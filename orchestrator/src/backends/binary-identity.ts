/**
 * Is the program a name resolved to the one the provider means? (`declares.binary.identity`)
 *
 * A bare name is not an identity: Cursor's installer and grok's both put an `agent` in `~/.local/bin`, and
 * the last one installed wins the name — even after the operator authorized that path for the other. A
 * provider that declares how its program describes itself (`agent --version` → `2026.10.16-…`) has it
 * checked before a mission starts it, and a mission on the wrong program fails at once instead of running a
 * stranger's CLI with the mission's prompt.
 *
 * What the program printed never leaves this module: not in a refusal, not in a log, not in `doctor`. A
 * stranger's `--version` may print a private path or a secret no redaction list knows, and a refusal only
 * needs to say which kind of answer it got (`BinaryIdentityFailure`). Nor does the refusal quote the full
 * path, which names the home folder: the file's own name is enough to recognise it.
 *
 * The answer is kept per file (path, size, modification time), so a mission start costs one run of the
 * program only after it was installed or replaced.
 *
 * The program runs as a stranger would be run: in an empty folder of its own, with an environment reduced to
 * a few named variables (`PROBE_ENV_KEYS`), and on Windows only as a `.exe` or an npm shim this daemon can
 * read line for line — never through `cmd.exe`, which would run whatever a batch file says. What it starts
 * ends with it, Windows included (`execTree`, `sweepOrphans`).
 *
 * The pattern comes from a manifest and is tested before the plugin's code is loaded, on up to 128 KB the
 * program printed, in the daemon's thread: V8's backtracking engine has no timeout of its own, so a pattern
 * like `^(a+)+$` would freeze every mission. It runs in a `vm` script whose timeout interrupts the match.
 * The linear engine of trigger filters (`triggers/safe-regex.ts`) was not used: it has no `m` flag and
 * refuses lookarounds and backreferences, which the SDK contract allows.
 */
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import { Script } from 'node:vm';
import { declaredBinaries, declaredBinary } from '../host/declared-binaries.js';
import { getHost } from '../host/index.js';
import { execTree } from '../host/kill-tree.js';
import { daemonNode } from '../host/launch-path.js';
import { windowsDirectLaunch } from '../host/windows-shell.js';
import { resolveExecutable } from '../plugins/policy.js';
import type { ProviderBinaryIdentity } from './provider-declarations.js';
import { profileDeclarations } from './registry.js';

const IDENTITY_TIMEOUT_MS = 5_000;
const IDENTITY_MAX_OUTPUT = 64 * 1024;
/** A version line takes microseconds; past this, the pattern is backtracking out of control. */
const PATTERN_TIMEOUT_MS = 250;
const CACHE_MAX = 64;
export const DEFAULT_IDENTITY_ARGS: readonly string[] = ['--version'];

/**
 * Why a program is refused, never with what it printed:
 * - `mismatch`: it answered, and the answer is not the declared one;
 * - `no_answer`: it printed nothing usable, or was stopped at the time limit;
 * - `slow_pattern`: the provider's pattern ran past its time limit, so the answer could not be read at all;
 * - `unsupported`: a file this daemon does not start to ask it anything (on Windows: neither a `.exe` nor an
 *   npm shim it can read).
 */
export type BinaryIdentityFailure = 'mismatch' | 'no_answer' | 'slow_pattern' | 'unsupported';
export type BinaryIdentityResult = { readonly ok: true } | { readonly ok: false; readonly reason: BinaryIdentityFailure };

/** Limits of one check; tests shorten them. */
export type BinaryIdentityLimits = { readonly runTimeoutMs: number; readonly patternTimeoutMs: number };
const LIMITS: BinaryIdentityLimits = { runTimeoutMs: IDENTITY_TIMEOUT_MS, patternTimeoutMs: PATTERN_TIMEOUT_MS };

/**
 * `durable`: an answer about the file, reused by every check until the file changes. A run that was cut
 * (time limit, failure, a pattern too slow under load) is kept too, but only for `knownBinaryIdentity`: a
 * report may show it, a launch asks again.
 */
type CacheEntry = { readonly result: BinaryIdentityResult; readonly durable: boolean };
const cache = new Map<string, CacheEntry>();
const MATCH = new Script('new RegExp(pattern, "m").test(subject)');

/** `true`/`false`, or `null` when the match ran past `timeoutMs` (V8 interrupts it, the daemon goes on). */
export function testIdentityPattern(pattern: string, subject: string, timeoutMs: number = PATTERN_TIMEOUT_MS): boolean | null {
  try {
    return MATCH.runInNewContext({ pattern, subject }, { timeout: timeoutMs }) === true;
  } catch (error) {
    if ((error as { code?: unknown }).code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') return null;
    throw error;
  }
}

export class BinaryIdentityError extends Error {
  readonly code = 'binary_identity';
  constructor(message: string) {
    super(message);
    this.name = 'BinaryIdentityError';
  }
}

/** The cache key of one check: the file as it is on disk, the question, the expected answer. `''` = never cached. */
function cacheKey(program: string, args: readonly string[], identity: ProviderBinaryIdentity): string {
  let stamp = '';
  try {
    const st = statSync(program);
    stamp = `${st.size}:${st.mtimeMs}`;
  } catch { /* not a file we can stat: never cached */ }
  return stamp ? `${program}\0${stamp}\0${args.join('\0')}\0${identity.pattern}` : '';
}

/**
 * Every variable a probed program sees, matched exactly (case aside on Windows, where `Path` is `PATH`):
 * enough to start a program and find its own install, none of the daemon's settings. No family such as
 * `NODE_*` or `npm_config_*`, which `systemEnv` lets through for missions and which may carry a token.
 */
export const PROBE_ENV_KEYS: readonly string[] = Object.freeze(['PATH', 'HOME', 'USERPROFILE', 'SystemRoot', 'TEMP', 'TMP', 'LANG']);

export function probeEnv(source: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
  const wanted = new Set(platform === 'win32' ? PROBE_ENV_KEYS.map((key) => key.toUpperCase()) : PROBE_ENV_KEYS);
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && wanted.has(platform === 'win32' ? key.toUpperCase() : key)) out[key] = value;
  }
  return out;
}

/** The runtime an npm shim names, found the way the host adapter finds it for a launch. */
function findRuntime(name: 'node' | 'bun'): string | null {
  try { return getHost().bin(name); } catch {
    return name === 'node' ? daemonNode() : null;
  }
}

/**
 * What is started to ask `program`, or `null` for a file this daemon does not start to ask it anything. On
 * Windows: a `.exe` as it is, an npm `.cmd` shim as the `.exe` it runs (`windowsDirectLaunch`), nothing else
 * — a `.bat`, a `.com`, a shim it cannot read would go through `cmd.exe`.
 */
export function probeLaunch(
  program: string, args: readonly string[], platform: NodeJS.Platform = process.platform,
  runtime: (name: 'node' | 'bun') => string | null = findRuntime,
): { file: string; args: string[] } | null {
  if (platform !== 'win32') return { file: program, args: [...args] };
  const ext = win32.extname(program).toLowerCase();
  if (ext === '.exe') return { file: program, args: [...args] };
  if (ext !== '.cmd') return null;
  const direct = windowsDirectLaunch(program, args, { findRuntime: runtime, platform });
  return direct && win32.extname(direct.file).toLowerCase() === '.exe' ? direct : null;
}

/** An empty folder of its own for one run, so the program reads and leaves nothing in the daemon's. */
function withProbeFolder<T>(run: (cwd: string) => T): T {
  const cwd = mkdtempSync(join(tmpdir(), 'timon-identity-'));
  let async = false;
  try {
    const out = run(cwd);
    if (out instanceof Promise) {
      async = true;
      return out.finally(() => rmSync(cwd, { recursive: true, force: true })) as T;
    }
    return out;
  } finally {
    if (!async) rmSync(cwd, { recursive: true, force: true });
  }
}

/** Kept like any answer about the file: it depends on nothing but the file. */
function unsupported(key: string): BinaryIdentityResult {
  const result: BinaryIdentityResult = { ok: false, reason: 'unsupported' };
  remember(key, result, true);
  return result;
}

function remember(key: string, result: BinaryIdentityResult, durable: boolean): void {
  if (!key) return;
  // Re-inserted at the end: the oldest entry is the first one dropped.
  cache.delete(key);
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!);
  cache.set(key, { result, durable });
}

/**
 * How one run ended, as the verdict reads it. `answered`: the program exited by itself with code 0, before
 * the time limit and under the output cap. Anything else is no answer, whatever it printed first: a program
 * that prints the expected version and then fails, hangs or floods is not the program a mission can run.
 */
type ProbeRun = { readonly answered: boolean; readonly output: string };

/** The verdict on one run. Durable only for an answer read to its end: a failed or cut run is asked again by a launch. */
function verdict(key: string, identity: ProviderBinaryIdentity, run: ProbeRun, limits: BinaryIdentityLimits): BinaryIdentityResult {
  // On a loaded machine a sane program can miss its limit once: the next launch must really ask.
  if (!run.answered) {
    const result: BinaryIdentityResult = { ok: false, reason: 'no_answer' };
    remember(key, result, false);
    return result;
  }
  const matched = testIdentityPattern(identity.pattern, run.output, limits.patternTimeoutMs);
  // Not durable: under a heavy load a sane pattern could run past the limit once.
  if (matched === null) {
    const result: BinaryIdentityResult = { ok: false, reason: 'slow_pattern' };
    remember(key, result, false);
    return result;
  }
  const result: BinaryIdentityResult = matched ? { ok: true } : { ok: false, reason: run.output.trim() ? 'mismatch' : 'no_answer' };
  remember(key, result, true);
  return result;
}

/**
 * The last answer about `program` as it is on disk now, cut runs included, without running anything:
 * `undefined` when it was never asked, or was replaced since. What a report that must not wait shows.
 */
export function knownBinaryIdentity(program: string, identity: ProviderBinaryIdentity): BinaryIdentityResult | undefined {
  const key = cacheKey(program, [...(identity.args ?? DEFAULT_IDENTITY_ARGS)], identity);
  return key ? cache.get(key)?.result : undefined;
}

/**
 * Runs `program` (an absolute path) with the identity's arguments and tests what it printed. A durable answer
 * about the same file is reused, unless `fresh` asks the program again (`timon doctor`).
 */
export async function checkBinaryIdentity(
  program: string, identity: ProviderBinaryIdentity, limits: BinaryIdentityLimits = LIMITS, options: { fresh?: boolean } = {},
): Promise<BinaryIdentityResult> {
  const args = [...(identity.args ?? DEFAULT_IDENTITY_ARGS)];
  const key = cacheKey(program, args, identity);
  const known = key && !options.fresh ? cache.get(key) : undefined;
  if (known?.durable) return known.result;
  const launch = probeLaunch(program, args);
  if (!launch) return unsupported(key);
  // `execTree`: a program that leaves a child on its stdout would otherwise cost the whole limit at
  // every mission start, and leave that child running after each check. Its `code` is 1 past the output cap.
  const run = await withProbeFolder((cwd) => execTree(launch.file, launch.args, {
    timeout: limits.runTimeoutMs, maxBuffer: IDENTITY_MAX_OUTPUT, env: probeEnv(), cwd, sweepOrphans: true,
  }));
  return verdict(key, identity, {
    answered: run.code === 0 && run.timedOut !== true, output: `${run.stdout}\n${run.stderr}`,
  }, limits);
}

/**
 * The refusal a person reads: which program, what kind of answer, what was expected, what to do. A fixed
 * sentence: the file is named by its own name, never by its full path, and what it printed is not quoted.
 * `who`: "backend `cursor`". `where`: the field the pattern came from, the one the provider must change.
 */
export function binaryIdentityRefusal(
  who: string, program: string, identity: ProviderBinaryIdentity, reason: BinaryIdentityFailure, where = 'declares.binary.identity',
): string {
  const args = (identity.args ?? DEFAULT_IDENTITY_ARGS).join(' ');
  // `win32.basename` cuts at both separators: a Windows path reported by a Linux daemon is named all the same.
  const file = `\`${win32.basename(program)}\``;
  if (reason === 'slow_pattern') {
    return `${file} could not be checked as the program ${who} runs: its \`${where}.pattern\` `
      + `ran past ${PATTERN_TIMEOUT_MS} ms on what \`${args}\` printed. The provider must declare a simpler pattern.`;
  }
  if (reason === 'unsupported') {
    return `${file} cannot be checked as the program ${who} runs: on Windows, only a \`.exe\` program or an npm \`.cmd\` shim `
      + 'is started to be checked. Pin the program\'s `.exe`, or the shim npm installed for it.';
  }
  const fix = 'Install the right program, or pin its path in `host.binaries` (timon.config.json).';
  if (reason === 'no_answer') return `${file}, the program ${who} runs, did not answer \`${args}\`. ${fix}`;
  const expected = identity.expected ?? 'the program its provider declares';
  return `${file} is not ${expected}, the program ${who} runs: its \`${args}\` answer does not match. ${fix}`;
}

/**
 * Before a mission starts `cmd` for `backend`: throws `BinaryIdentityError` when the provider declared an
 * identity and the program does not have it. A backend that declared none passes untouched.
 */
export async function assertLaunchIdentity(backend: string, cmd: string): Promise<void> {
  const identity = profileDeclarations(backend)?.binary?.identity;
  if (!identity) return;
  const program = resolveExecutable(cmd) ?? cmd;
  const result = await checkBinaryIdentity(program, identity);
  if (!result.ok) throw new BinaryIdentityError(binaryIdentityRefusal(`backend \`${backend}\``, program, identity, result.reason));
}

/**
 * Before a provider plugin runs its declared program `name` (resolved to `program`) through
 * `ctx.provider.binary` — a version, a probe, the model probe's conversation, a server: the same check as a
 * mission's launch, from the declaration that names it. Throws `BinaryIdentityError`.
 */
export async function assertDeclaredIdentity(name: string, program: string, who: string): Promise<void> {
  const identity = declaredBinary(name)?.identity;
  if (!identity) return;
  const result = await checkBinaryIdentity(program, identity);
  if (!result.ok) throw new BinaryIdentityError(binaryIdentityRefusal(who, program, identity, result.reason));
}

/**
 * Tests only: the stand-in CLIs a launch test puts on the PATH sit behind a fake `host.spawn` that records
 * the launch and answers nothing, `--version` included. Each declared program the host resolves now is taken
 * as the one its provider means, until the file changes — the identity check itself has its own tests.
 */
export function assumeDeclaredIdentities(): void {
  for (const declaration of declaredBinaries()) {
    const identity = declaration.identity;
    if (!identity) continue;
    const args = [...(identity.args ?? DEFAULT_IDENTITY_ARGS)];
    for (const name of declaration.names) {
      const program = resolveExecutable(name);
      const key = program ? cacheKey(program, args, identity) : '';
      remember(key, { ok: true }, true);
    }
  }
}

/** Tests only: forget what was learned. */
export function resetBinaryIdentityCache(): void {
  cache.clear();
}
