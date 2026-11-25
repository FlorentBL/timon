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
 * The pattern comes from a manifest and is tested before the plugin's code is loaded, on up to 128 KB the
 * program printed, in the daemon's thread: V8's backtracking engine has no timeout of its own, so a pattern
 * like `^(a+)+$` would freeze every mission. It runs in a `vm` script whose timeout interrupts the match.
 * The linear engine of trigger filters (`triggers/safe-regex.ts`) was not used: it has no `m` flag and
 * refuses lookarounds and backreferences, which the SDK contract allows.
 */
import { statSync } from 'node:fs';
import { basename } from 'node:path';
import { Script } from 'node:vm';
import { declaredBinaries, declaredBinary } from '../host/declared-binaries.js';
import { getHost } from '../host/index.js';
import { execTree } from '../host/kill-tree.js';
import { resolveExecutable } from '../plugins/policy.js';
import { systemEnv } from '../secrets/env.js';
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
 * - `slow_pattern`: the provider's pattern ran past its time limit, so the answer could not be read at all.
 */
export type BinaryIdentityFailure = 'mismatch' | 'no_answer' | 'slow_pattern';
export type BinaryIdentityResult = { readonly ok: true } | { readonly ok: false; readonly reason: BinaryIdentityFailure };

/** Limits of one check; tests shorten them. */
export type BinaryIdentityLimits = { readonly runTimeoutMs: number; readonly patternTimeoutMs: number };
const LIMITS: BinaryIdentityLimits = { runTimeoutMs: IDENTITY_TIMEOUT_MS, patternTimeoutMs: PATTERN_TIMEOUT_MS };

const cache = new Map<string, BinaryIdentityResult>();
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
 * How one run ended, as the verdict reads it. `answered`: the program exited by itself with code 0, before
 * the time limit and under the output cap. Anything else is no answer, whatever it printed first: a program
 * that prints the expected version and then fails, hangs or floods is not the program a mission can run.
 */
type ProbeRun = { readonly answered: boolean; readonly output: string };

/** The verdict on one run. Kept only for an answer read to its end: a failed or cut run is asked again next time. */
function verdict(key: string, identity: ProviderBinaryIdentity, run: ProbeRun, limits: BinaryIdentityLimits): BinaryIdentityResult {
  // On a loaded machine a sane program can miss its limit once: the next try must really ask.
  if (!run.answered) return { ok: false, reason: 'no_answer' };
  const matched = testIdentityPattern(identity.pattern, run.output, limits.patternTimeoutMs);
  // Not cached: under a heavy load a sane pattern could run past the limit once.
  if (matched === null) return { ok: false, reason: 'slow_pattern' };
  const result: BinaryIdentityResult = matched ? { ok: true } : { ok: false, reason: run.output.trim() ? 'mismatch' : 'no_answer' };
  if (key) {
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!);
    cache.set(key, result);
  }
  return result;
}

/** Runs `program` (an absolute path) with the identity's arguments and tests what it printed. */
export async function checkBinaryIdentity(
  program: string, identity: ProviderBinaryIdentity, limits: BinaryIdentityLimits = LIMITS,
): Promise<BinaryIdentityResult> {
  const args = [...(identity.args ?? DEFAULT_IDENTITY_ARGS)];
  const key = cacheKey(program, args, identity);
  const known = key ? cache.get(key) : undefined;
  if (known) return known;
  // `execTree`: a program that leaves a child on its stdout would otherwise cost the whole limit at
  // every mission start, and leave that child running after each check. Its `code` is 1 past the output cap.
  const run = await execTree(program, args, {
    timeout: limits.runTimeoutMs, maxBuffer: IDENTITY_MAX_OUTPUT, env: systemEnv(),
  });
  return verdict(key, identity, {
    answered: run.code === 0 && run.timedOut !== true, output: `${run.stdout}\n${run.stderr}`,
  }, limits);
}

/**
 * The same check and the same cache for a caller that cannot wait: `doctor`'s report is synchronous. The
 * host adapter's synchronous run answers a non-zero code when its timeout stopped the program.
 */
export function checkBinaryIdentitySync(
  program: string, identity: ProviderBinaryIdentity, limits: BinaryIdentityLimits = LIMITS,
): BinaryIdentityResult {
  const args = [...(identity.args ?? DEFAULT_IDENTITY_ARGS)];
  const key = cacheKey(program, args, identity);
  const known = key ? cache.get(key) : undefined;
  if (known) return known;
  const run = getHost().exec(program, args, {
    timeout: limits.runTimeoutMs, maxBuffer: IDENTITY_MAX_OUTPUT, env: systemEnv(), windowsHide: true,
  });
  return verdict(key, identity, { answered: run.code === 0, output: `${run.stdout}\n${run.stderr}` }, limits);
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
  const file = `\`${basename(program)}\``;
  if (reason === 'slow_pattern') {
    return `${file} could not be checked as the program ${who} runs: its \`${where}.pattern\` `
      + `ran past ${PATTERN_TIMEOUT_MS} ms on what \`${args}\` printed. The provider must declare a simpler pattern.`;
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
      if (key) cache.set(key, { ok: true });
    }
  }
}

/** Tests only: forget what was learned. */
export function resetBinaryIdentityCache(): void {
  cache.clear();
}
