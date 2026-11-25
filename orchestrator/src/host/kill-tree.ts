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
 *
 * Never throws: the child may already be gone.
 */
import type { ChildProcess } from 'node:child_process';
import { getHost } from './index.js';
import type { ExecResult, Host, SpawnOpts } from './types.js';

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

/** What a program that left the group keeps open is given this long after its exit. */
const DRAIN_MS = 250;

export type ExecTreeOpts = Pick<SpawnOpts, 'cwd' | 'env'> & {
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

/** How long the sweep's PowerShell may take; past it, the call returns anyway. */
const SWEEP_TIMEOUT_MS = 10_000;

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

/** Ends, on Windows, what `rootPid` (started at `since`, now exited) left running. Never throws. */
export async function sweepWindowsOrphans(host: Pick<Host, 'execAsync'>, rootPid: number, since: Date): Promise<void> {
  try {
    await host.execAsync('powershell', ['-NoProfile', '-NonInteractive', '-Command', windowsOrphanSweepScript(rootPid, since)], {
      timeout: SWEEP_TIMEOUT_MS, windowsHide: true,
    });
  } catch { /* no PowerShell, or a pid that cannot be swept: nothing more can be done from here */ }
}

/**
 * `detached` takes the child out of the daemon's group and session: a Ctrl+C at
 * the terminal no longer reaches it, nor does launchd's group kill. The daemon
 * ends on its stop signals through `process.exit` (`daemon-shutdown.ts`), so this
 * brings back what those signals did. A SIGKILLed daemon still leaves the child.
 */
const liveGroups = new Set<ChildProcess>();
let exitHooked = false;
function trackGroup(child: ChildProcess): void {
  liveGroups.add(child);
  if (exitHooked) return;
  exitHooked = true;
  process.on('exit', () => { for (const live of liveGroups) stopProcessGroup(live, 'SIGKILL'); });
}

/**
 * `execAsync` for a program that is only asked a question, whose limit and exit
 * also end what it started. Two differences that are the point of it: the answer
 * returns when the program exits, not when the last holder of its stdout lets go;
 * and nothing it left in its group outlives the call. SIGKILL, because a program
 * that ignores SIGTERM must not hold the caller. A child that left the group on
 * purpose (`setsid`, a detached updater) is not ours to end, and is left alone.
 *
 * Windows has no group: the limit takes the tree through `taskkill /T`, which
 * walks down from a living root only. What a program left after it exited is
 * ended by `sweepOrphans`, when the caller asks for it; otherwise it stays.
 *
 * Same contract as `execAsync`: rejects only for a binary that does not resolve.
 */
export function execTree(name: string, args: string[], opts: ExecTreeOpts): Promise<ExecResult> {
  return new Promise((resolve) => {
    const host = getHost();
    // `spawn` would fall back on the bare name and report ENOENT by event.
    host.bin(name);
    // Off on Windows, where `detached` opens a console window.
    const grouped = host.platform !== 'win32';
    const startedAt = new Date();
    const child = host.spawn(name, args, {
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
      ...(opts.env ? { env: opts.env } : {}),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      detached: grouped,
    });
    if (grouped && child.pid) trackGroup(child);

    let stdout = '';
    let stderr = '';
    let exitCode: number | null = null;
    let exited = false;
    let overflowed = false;
    let timedOut = false;
    let stopped = false;
    let settled = false;
    let drain: NodeJS.Timeout | undefined;
    let sweep: Promise<void> | undefined;

    const stop = () => {
      if (stopped) return;
      stopped = true;
      liveGroups.delete(child);
      stopProcessGroup(child, 'SIGKILL', host.platform);
    };
    const settle = () => {
      if (settled) return;
      settled = true;
      clearTimeout(limit);
      clearTimeout(stall);
      clearTimeout(drain);
      liveGroups.delete(child);
      child.stdout?.destroy();
      child.stderr?.destroy();
      const result: ExecResult = { code: overflowed ? 1 : exitCode ?? 1, stdout, stderr, ...(timedOut ? { timedOut: true } : {}) };
      if (sweep) void sweep.then(() => resolve(result));
      else resolve(result);
    };
    // `close` normally comes first. This is for a holder outside the group, or a
    // process the kernel cannot end right now: the caller returns regardless.
    const drainThenSettle = () => { drain ??= setTimeout(settle, DRAIN_MS); };

    const expire = () => {
      timedOut = true;
      stop();
      drainThenSettle();
    };
    const limit = setTimeout(expire, opts.timeout);
    let stall: NodeJS.Timeout | undefined;
    const rearmStall = () => {
      if (opts.stallTimeout === undefined || stopped || exited || settled) return;
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
      drainThenSettle();
      return next.slice(0, opts.maxBuffer);
    };
    child.stdout?.setEncoding('utf8').on('data', (chunk: string) => { stdout = keep(stdout, chunk); });
    child.stderr?.setEncoding('utf8').on('data', (chunk: string) => { stderr = keep(stderr, chunk); });

    child.on('error', settle);
    child.on('exit', (code) => {
      exitCode = code;
      exited = true;
      clearTimeout(limit);
      clearTimeout(stall);
      // At once: the group outlives its leader only as long as it has members,
      // and an empty group's number can come back. Never `taskkill` here: on
      // Windows this pid may already belong to another process.
      if (grouped) stop();
      else liveGroups.delete(child);
      // Started before `settle` can run, so the call never returns ahead of it.
      if (!grouped && opts.sweepOrphans && child.pid) sweep = sweepWindowsOrphans(host, child.pid, startedAt);
      drainThenSettle();
    });
    child.on('close', settle);
  });
}
