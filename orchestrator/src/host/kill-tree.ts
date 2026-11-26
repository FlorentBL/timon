/**
 * Stops a child and what it started.
 *
 * On Windows a shim the adapter cannot start directly runs through `cmd.exe`
 * (`windows-shell.ts`): `child.kill()` ends `cmd.exe` and leaves the real node
 * process running. `taskkill /T` takes the whole tree, as long as the root is
 * still there to walk down from: the root is ended once it has answered. Elsewhere
 * the signal reaches the CLI itself, which is enough for the login flows that use
 * this (`backends/account-login.ts`).
 *
 * POSIX has a stronger answer for a child started with `detached`: its process
 * group. The table of `process-tree.ts` cannot do this job: once a program has
 * exited, what it left behind is reparented and no parent pid leads to it any
 * more, whereas the group still holds it and the kernel signals it atomically.
 * A descendant that called `setsid()` left the group too: `execTree` also
 * reaches it, through a scope or a mark (see `Leftovers`).
 *
 * Never throws: the child may already be gone.
 */
import type { ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { getHost } from './index.js';
import { hasSystemd } from './systemd.js';
import type { ExecResult, Host, SpawnOpts } from './types.js';
import { instancePrefix } from './units.js';

/**
 * How long the root waits for `taskkill`. Under the shortest grace of a caller
 * (`session-one-shot`, 2 s), whose forced kill stays the last resort. `taskkill`
 * keeps its own longer limit: past this wait it may still finish what it started.
 */
const TASKKILL_WAIT_MS = 1_500;

/**
 * Returns at once on every platform: on Windows the root ends a little later, and
 * a caller that needs it gone waits for its `exit`. `taskkill` is started before
 * this returns, so a daemon exiting right after still takes the tree.
 */
export function killProcessTree(child: ChildProcess, platform: NodeJS.Platform = process.platform): void {
  const endRoot = () => { try { child.kill('SIGTERM'); } catch { /* already gone */ } };
  if (platform !== 'win32' || !child.pid) { endRoot(); return; }
  // `exit` can precede `close`: Windows may already have reused the root's pid.
  if (child.exitCode !== null || child.signalCode !== null) return;
  const answer = getHost().execAsync('taskkill', ['/T', '/F', '/PID', String(child.pid)], { timeout: 5_000, windowsHide: true });
  let ended = false;
  const endOnce = () => {
    if (ended) return;
    ended = true;
    clearTimeout(wait);
    endRoot();
  };
  const wait = setTimeout(endOnce, TASKKILL_WAIT_MS);
  wait.unref();
  // A failed `taskkill` is no reason to spare the root.
  answer.then(endOnce, endOnce);
}

/**
 * Signals the group of a child started with `detached: true` (POSIX), and falls
 * back on `killProcessTree` where there is no group: Windows, or a group gone.
 */
export function stopProcessGroup(child: ChildProcess, signal: NodeJS.Signals, platform: NodeJS.Platform = process.platform): void {
  const pid = child.pid;
  // Negative pid = the group `detached` gave it. Never 0, which is our own
  // group, nor 1: -1 reaches every process this user may signal.
  if (platform !== 'win32' && pid !== undefined && pid > 1) {
    try { process.kill(-pid, signal); return; } catch { /* already gone, or no group */ }
  }
  killProcessTree(child, platform);
}

/** Once the program and what it left are ended, how long its pipes get to report closed. */
const DRAIN_MS = 250;

/**
 * What the limit keeps of the caller's `timeout` for the ending: the program is stopped this long before the
 * deadline, so that the call, cleanup included, still returns by it. A quarter of a short timeout.
 */
const CLEANUP_RESERVE_MS = 1_000;

export function cleanupReserve(timeout: number): number {
  return Math.min(CLEANUP_RESERVE_MS, Math.floor(timeout / 4));
}

export type ExecTreeOpts = Pick<SpawnOpts, 'cwd' | 'env'> & {
  /**
   * The one deadline of the call, end to end: the containment check, the program, the ending of what it
   * left and the draining of its pipes all fit in it. The program itself is stopped `cleanupReserve` sooner.
   */
  timeout: number;
  maxBuffer: number;
  /**
   * Also stops the program once it has printed nothing for this long. For a long
   * job that reports its progress (a checkout on a slow disk): it may run for as
   * long as it keeps talking, under `timeout`, which stays the ceiling.
   */
  stallTimeout?: number;
  /**
   * Windows: also end what the program left running once it has exited (`sweepWindowsOrphans`), before the
   * call returns. Costs one PowerShell run per call: for a program that must leave nothing behind, such as
   * a file the daemon is only asked to identify.
   */
  sweepOrphans?: boolean;
};

/** How long the sweep's PowerShell may take at most; the call's own deadline may cut it shorter. */
const SWEEP_TIMEOUT_MS = 10_000;

/**
 * The PowerShell that ends what `rootPid` left behind after it exited. Windows does not reparent: an
 * orphan still names its dead parent in `ParentProcessId`, and so do its own children. Two guards against
 * a recycled pid: nothing is done while a live process holds `rootPid` (it would be someone else's), and
 * only processes created since the root was started count (an older one named a previous holder of the pid).
 */

/**
 * The PowerShell that ends what `rootPid` left behind after it exited. Windows does not reparent: an
 * orphan still names its dead parent in `ParentProcessId`, and so do its own children. Two guards against
 * a recycled pid: nothing is done while a live process holds `rootPid` (it would be someone else's), and
 * only processes created since the root was started count (an older one named a previous holder of the pid).
 */
export function windowsOrphanSweepScript(rootPid: number, since: Date): string {
  if (!Number.isSafeInteger(rootPid) || rootPid <= 4) throw new Error('not a process that can be swept');
  return [
    `$root = ${rootPid}`,
    `$since = [datetime]::Parse('${since.toISOString()}', [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind).ToUniversalTime()`,
    '$all = @(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CreationDate)',
    'if (@($all | Where-Object { $_.ProcessId -eq $root }).Count -gt 0) { return }',
    '$found = @(); $parents = @($root)',
    'while ($parents.Count -gt 0) {',
    '  $next = @($all | Where-Object { ($parents -contains $_.ParentProcessId) -and ($found -notcontains $_.ProcessId) -and $_.CreationDate -and ($_.CreationDate.ToUniversalTime() -ge $since) } | ForEach-Object { $_.ProcessId })',
    '  $found += $next; $parents = $next',
    '}',
    'foreach ($id in $found) { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue }',
  ].join('\n');
}

/**
 * Ends, on Windows, what `rootPid` (started at `since`, now exited) left running. Never throws: false when
 * the sweep could not be run to its end (no PowerShell, a refused pid, an error, out of time), so that the
 * caller can say so instead of believing the tree is gone.
 */
export async function sweepWindowsOrphans(host: Pick<Host, 'execAsync'>, rootPid: number, since: Date, timeoutMs = SWEEP_TIMEOUT_MS): Promise<boolean> {
  try {
    const r = await host.execAsync('powershell', ['-NoProfile', '-NonInteractive', '-Command', windowsOrphanSweepScript(rootPid, since)], {
      timeout: Math.max(1, Math.min(SWEEP_TIMEOUT_MS, timeoutMs)), windowsHide: true,
    });
    return r.code === 0 && r.timedOut !== true;
  } catch {
    return false;
  }
}

/* ── What a launch leaves behind (POSIX) ─────────────────────────────────── */

/**
 * The group signal reaches what stayed in the program's process group. A descendant that called `setsid()`
 * (a daemonising helper, an updater) left it, and once its parent exits no parent pid leads to it either.
 * Two ways to still find it, by strength:
 *
 * - Linux with a user systemd manager: the launch runs in a transient scope of its own (`SpawnOpts.scope`),
 *   the same mechanism as the missions' scopes. A cgroup cannot be left by `setsid`, and
 *   `systemctl --user kill` ends every process in it at once.
 * - Elsewhere (macOS, Linux without a manager): the launch carries a random mark in its environment, which
 *   every descendant inherits, `setsid` or not, and the process table is swept for it. A session sweep
 *   would miss exactly the processes that matter here, since `setsid` also leaves the session. A process
 *   that rewrites its own environment escapes this one.
 */
type Leftovers = {
  /** Ends what the launch left; settles by `deadline`. Never rejects. */
  end(deadline: number): Promise<void>;
  /** The same, synchronously, for a daemon that is exiting. */
  endNow(): void;
};

/** The variable that carries the mark of a launch. */
export const EXEC_TREE_MARK = 'TIMON_EXEC_TREE_MARK';

/** A marked process can still fork while it is being ended: the table is read again, this many times. */
const SWEEP_PASSES = 4;

/** How long the one-time check that the user manager accepts scopes may take. */
const SCOPE_PROBE_MS = 5_000;

const left = (deadline: number): number => Math.max(1, deadline - Date.now());
const quietly = (fn: () => void): void => { try { fn(); } catch { /* gone already */ } };

let scopeProbe: Promise<boolean> | undefined;
let scopeForTest: boolean | null = null;

/** Test-only: `false` takes the marked sweep where a scope would be used, `null` asks the machine again. */
export function setExecScopeForTest(value: boolean | null): void {
  scopeForTest = value;
  scopeProbe = undefined;
}

function scopeUnit(): string {
  return `${instancePrefix()}-exec-${randomBytes(4).toString('hex')}`;
}

/**
 * Whether `systemd-run --user --scope` works here, asked once by running `true` in one. A failing
 * `systemd-run` cannot be told from the program's own failure afterwards, so it is never used unchecked.
 */
function scopeUsable(host: Pick<Host, 'platform' | 'execAsync'>): Promise<boolean> {
  if (scopeForTest !== null) return Promise.resolve(scopeForTest);
  if (host.platform !== 'linux' || !hasSystemd()) return Promise.resolve(false);
  scopeProbe ??= host.execAsync('systemd-run', ['--user', '--scope', '--quiet', '--collect', `--unit=${scopeUnit()}`, '--', 'true'], { timeout: SCOPE_PROBE_MS })
    .then((r) => {
      if (r.code !== 0) console.warn(`[host] systemd-run --scope is refused here (${(r.stderr || r.stdout).trim() || `code ${r.code}`}): launches are swept by mark instead`);
      return r.code === 0;
    }, () => false);
  return scopeProbe;
}

/** The probe, given at most half of what is left: past that the launch is swept by mark, and the probe still answers the next one. */
async function scopeUsableBy(host: Pick<Host, 'platform' | 'execAsync'>, deadline: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), Math.floor(left(deadline) / 2)); });
  try { return await Promise.race([scopeUsable(host), late]); } finally { clearTimeout(timer); }
}

function scopeLeftovers(host: Pick<Host, 'exec' | 'execAsync'>, unit: string): Leftovers {
  const args = ['--user', 'kill', '--signal=SIGKILL', `${unit}.scope`];
  // `--collect` removes an empty scope at once: "not loaded" means nothing was left.
  const said = (r: ExecResult) => {
    if (r.code === 0 || /not loaded/i.test(r.stderr)) return;
    console.warn(`[host] could not end what ${unit}.scope holds: ${r.stderr.trim() || `code ${r.code}`}${r.timedOut ? ' (out of time)' : ''}`);
  };
  return {
    end: async (deadline) => {
      try { said(await host.execAsync('systemctl', args, { timeout: left(deadline) })); } catch (error) {
        console.warn(`[host] could not end what ${unit}.scope holds: ${(error as Error).message}`);
      }
    },
    endNow: () => { try { said(host.exec('systemctl', args, { timeout: 1_000 })); } catch { /* exiting: nothing more to do */ } },
  };
}

/** Whether a NUL-separated environment (`/proc/<pid>/environ`) holds exactly `entry`. */
export function environHoldsEntry(environ: string, entry: string): boolean {
  for (let at = environ.indexOf(entry); at >= 0; at = environ.indexOf(entry, at + 1)) {
    const end = at + entry.length;
    if ((at === 0 || environ[at - 1] === '\0') && (end === environ.length || environ[end] === '\0')) return true;
  }
  return false;
}

/** The pids whose line of `ps -E -o pid=,command=` (environment appended to the command) holds `entry` as a word. */
export function markedPidsFromPs(stdout: string, entry: string): number[] {
  const out: number[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (m && m[2]!.split(/\s+/).includes(entry)) out.push(Number(m[1]));
  }
  return out;
}

const PS_MARK_ARGS = (): string[] => [
  '-ww', '-E', '-x', ...(typeof process.getuid === 'function' ? ['-U', String(process.getuid())] : []), '-o', 'pid=,command=',
];
/** Environments of every process of the user: far more than a process table. */
const PS_MARK_MAX_BUFFER = 64 * 1024 * 1024;

const PROC_DIGITS = /^\d+$/;

async function markedPids(host: Pick<Host, 'platform' | 'execAsync'>, entry: string, deadline: number): Promise<number[]> {
  if (host.platform === 'linux') {
    // portability: Linux pseudo-fs, behind the platform guard above
    const names = await readdir('/proc').catch(() => [] as string[]);
    const found = await Promise.all(names.filter((n) => PROC_DIGITS.test(n)).map(async (n) => {
      // Another user's process, or one gone since `readdir`: not ours to end anyway.
      // portability: Linux pseudo-fs, behind the platform guard above
      try { return environHoldsEntry(await readFile(`/proc/${n}/environ`, 'latin1'), entry) ? Number(n) : null; } catch { return null; }
    }));
    return found.filter((pid): pid is number => pid !== null);
  }
  const r = await host.execAsync('ps', PS_MARK_ARGS(), { timeout: left(deadline), maxBuffer: PS_MARK_MAX_BUFFER }).catch(() => null);
  return r && r.code === 0 ? markedPidsFromPs(r.stdout, entry) : [];
}

function markedPidsSync(host: Pick<Host, 'platform' | 'exec'>, entry: string): number[] {
  if (host.platform === 'linux') {
    const out: number[] = [];
    let names: string[] = [];
    // portability: Linux pseudo-fs, behind the platform guard above
    try { names = readdirSync('/proc'); } catch { return out; }
    for (const n of names) {
      if (!PROC_DIGITS.test(n)) continue;
      // portability: Linux pseudo-fs, behind the platform guard above
      try { if (environHoldsEntry(readFileSync(`/proc/${n}/environ`, 'latin1'), entry)) out.push(Number(n)); } catch { /* not ours, or gone */ }
    }
    return out;
  }
  try {
    const r = host.exec('ps', PS_MARK_ARGS(), { timeout: 2_000, maxBuffer: PS_MARK_MAX_BUFFER });
    return r.code === 0 ? markedPidsFromPs(r.stdout, entry) : [];
  } catch { return []; }
}

function markedLeftovers(host: Pick<Host, 'platform' | 'exec' | 'execAsync'>, token: string): Leftovers {
  const entry = `${EXEC_TREE_MARK}=${token}`;
  const self = new Set([process.pid, process.ppid]);
  // SIGKILL leaves a zombie until it is reaped, and a zombie shows no environment: a pass sees only the living.
  const endAll = (pids: number[]): boolean => {
    const targets = pids.filter((pid) => pid > 1 && !self.has(pid));
    for (const pid of targets) quietly(() => process.kill(pid, 'SIGKILL'));
    return targets.length > 0;
  };
  return {
    end: async (deadline) => {
      for (let pass = 0; pass < SWEEP_PASSES && Date.now() < deadline; pass++) {
        if (!endAll(await markedPids(host, entry, deadline))) return;
      }
    },
    endNow: () => {
      for (let pass = 0; pass < SWEEP_PASSES; pass++) if (!endAll(markedPidsSync(host, entry))) return;
    },
  };
}

/* ── execTree ──────────────────────────────────────────────────────────────── */

/**
 * `detached` takes the child out of the daemon's group and session: a Ctrl+C at
 * the terminal no longer reaches it, nor does launchd's group kill. The daemon
 * ends on its stop signals through `process.exit` (`daemon-shutdown.ts`), so this
 * brings back what those signals did, scope and marked processes included. A
 * SIGKILLed daemon still leaves them.
 */
const liveCalls = new Set<() => void>();
let exitHooked = false;
function trackCall(endNow: () => void): void {
  liveCalls.add(endNow);
  if (exitHooked) return;
  exitHooked = true;
  process.on('exit', () => { for (const end of liveCalls) end(); });
}

/**
 * `execAsync` for a program that is only asked a question, whose limit and exit
 * also end everything it started. What it is for: the answer returns when the
 * program exits, not when the last holder of its stdout lets go; and nothing it
 * started outlives the call, not even a descendant that left its group and
 * session with `setsid` (see `Leftovers`). SIGKILL, because a program that
 * ignores SIGTERM must not hold the caller.
 *
 * One deadline, `timeout`, bounds the whole call: past it the call returns,
 * whatever is still being ended.
 *
 * Windows has no group: the limit takes the tree through `taskkill /T`, which
 * walks down from a living root only. What a program left after it exited is
 * ended by `sweepOrphans`, when the caller asks for it; otherwise it stays.
 *
 * Same contract as `execAsync`: rejects only for a binary that does not resolve.
 */
export async function execTree(name: string, args: string[], opts: ExecTreeOpts): Promise<ExecResult> {
  const host = getHost();
  // `spawn` would fall back on the bare name and report ENOENT by event.
  host.bin(name);
  const startedAt = new Date();
  const deadline = startedAt.getTime() + opts.timeout;
  const posix = host.platform !== 'win32';
  const unit = posix && await scopeUsableBy(host, deadline) ? scopeUnit() : null;
  const token = posix && !unit ? randomBytes(16).toString('hex') : null;
  const leftovers = unit ? scopeLeftovers(host, unit) : token ? markedLeftovers(host, token) : null;
  return new Promise((resolve) => {
    // Off on Windows, where `detached` opens a console window.
    const grouped = posix;
    const env = token ? { ...(opts.env ?? process.env), [EXEC_TREE_MARK]: token } : opts.env;
    const child = host.spawn(name, args, {
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
      ...(env ? { env } : {}),
      ...(unit ? { scope: unit } : {}),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      detached: grouped,
    });
    const endNow = () => { stopProcessGroup(child, 'SIGKILL'); leftovers?.endNow(); };
    if (grouped && child.pid) trackCall(endNow);

    let stdout = '';
    let stderr = '';
    let exitCode: number | null = null;
    let done = false;
    let closed = false;
    let cleaned = false;
    let overflowed = false;
    let timedOut = false;
    let stopped = false;
    let settled = false;
    let cleanup: Promise<void> | undefined;
    let drain: NodeJS.Timeout | undefined;
    let stall: NodeJS.Timeout | undefined;

    const settle = () => {
      if (settled) return;
      settled = true;
      clearTimeout(limit);
      clearTimeout(stall);
      clearTimeout(drain);
      clearTimeout(ceiling);
      liveCalls.delete(endNow);
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolve({ code: overflowed ? 1 : exitCode ?? 1, stdout, stderr, ...(timedOut ? { timedOut: true } : {}) });
    };
    // Returns once the program is over and what it left is ended. `close` normally follows at once: the
    // drain is for a holder of the pipes nothing could end (a process the kernel cannot kill right now).
    const ready = () => {
      if (settled || !done || !cleaned) return;
      if (closed) settle();
      else drain ??= setTimeout(settle, Math.min(DRAIN_MS, left(deadline)));
    };
    const stop = () => {
      if (stopped) return;
      stopped = true;
      stopProcessGroup(child, 'SIGKILL', host.platform);
    };
    // Once. POSIX as soon as the program is over or stopped. Windows once its root has exited: the sweep
    // reads a dead root's children, and a living pid could be anyone's.
    const clean = () => {
      if (cleanup) return;
      if (posix) cleanup = leftovers?.end(deadline) ?? Promise.resolve();
      else if (opts.sweepOrphans && child.pid) {
        const root = child.pid;
        cleanup = sweepWindowsOrphans(host, root, startedAt, left(deadline)).then((swept) => {
          if (!swept) console.warn(`[host] could not sweep what process ${root} left running: it may still run`);
        });
      } else cleanup = Promise.resolve();
      void cleanup.then(() => { cleaned = true; ready(); });
    };

    const expire = () => {
      timedOut = true;
      stop();
      if (posix) clean();
    };
    const limit = setTimeout(expire, Math.max(0, deadline - cleanupReserve(opts.timeout) - Date.now()));
    // Whatever is still pending: the caller has the answer by its deadline.
    const ceiling = setTimeout(settle, left(deadline));
    const rearmStall = () => {
      if (opts.stallTimeout === undefined || stopped || done || settled) return;
      clearTimeout(stall);
      stall = setTimeout(expire, opts.stallTimeout);
    };
    rearmStall();

    const keep = (held: string, chunk: string): string => {
      rearmStall();
      const next = held + chunk;
      if (next.length <= opts.maxBuffer) return next;
      overflowed = true;
      stop();
      if (posix) clean();
      return next.slice(0, opts.maxBuffer);
    };
    child.stdout?.setEncoding('utf8').on('data', (chunk: string) => { stdout = keep(stdout, chunk); });
    child.stderr?.setEncoding('utf8').on('data', (chunk: string) => { stderr = keep(stderr, chunk); });

    // A launch that failed: nothing ran, but a scope or a mark may have been set up for it.
    child.on('error', () => { done = true; clean(); ready(); });
    child.on('exit', (code) => {
      exitCode = code;
      done = true;
      clearTimeout(limit);
      clearTimeout(stall);
      // At once: the group outlives its leader only as long as it has members,
      // and an empty group's number can come back. Never `taskkill` here: on
      // Windows this pid may already belong to another process.
      if (grouped) stop();
      clean();
      ready();
    });
    child.on('close', () => { closed = true; ready(); });
  });
}
