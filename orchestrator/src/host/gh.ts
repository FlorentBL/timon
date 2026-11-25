/**
 * The GitHub CLI, as the daemon runs it for a project's integration setting
 * (`docs/KANBAN-PR-PIPELINE.md` §2.5, §3.2).
 *
 * One rule: `gh` acts as the account of the config folder the project names,
 * never as whatever the daemon's environment happens to hold. A `GH_TOKEN` or
 * `GITHUB_TOKEN` in that environment wins over every config folder, so it is
 * removed whenever a folder is named; prompts are off, since nobody can answer
 * one behind the daemon.
 *
 * The folder's content is never read by Timon beyond the names of the hosts
 * `hosts.yml` signs in to (`ghForgeHost`) and whether each one keeps its token
 * in that file (the `oauth_token` key, never its value), and its path never
 * reaches a log or an error: only `gh` opens the rest.
 */
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ExecOpts, ExecResult } from './types.js';
import { getHost } from './index.js';

/** Variables through which a token overrides the config folder. */
const TOKEN_VARIABLES = ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN'] as const;

/** The environment `gh` runs in for a project: its config folder, no token
 *  that would override it, no prompt, no update check. */
export function ghEnv(configDir: string | null, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1' };
  if (configDir) {
    env.GH_CONFIG_DIR = configDir;
    for (const name of TOKEN_VARIABLES) delete env[name];
  }
  return env;
}

const GITHUB_HOST = 'github.com';
const HOST_NAME = /^[a-z0-9](?:[a-z0-9-]{0,62})(?:\.[a-z0-9](?:[a-z0-9-]{0,62}))*$/;

type GhHostEntry = { host: string; tokenInFile: boolean };

/** An `oauth_token` key, and the forms of it that hold nothing. Only matched,
 *  never captured: the token itself is not read. */
const TOKEN_KEY = /^[ \t]+oauth_token[ \t]*:/;
const EMPTY_TOKEN = /^[ \t]+oauth_token[ \t]*:[ \t]*(?:(?:""|''|~|null)[ \t]*)?(?:#.*)?$/;

/**
 * The hosts of a `hosts.yml`, and for each whether its active token is stored
 * in the file: a non-empty `oauth_token` directly under the host. Without it,
 * gh reads the token from the system keyring. A host listed twice counts as
 * not storing it, the safe answer.
 */
function readGhHosts(text: string): GhHostEntry[] {
  const hosts: GhHostEntry[] = [];
  let current: GhHostEntry | null = null;
  let childIndent: number | null = null;
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    const indent = line.length - line.trimStart().length;
    if (indent === 0) {
      const m = /^(?:"([^"]+)"|'([^']+)'|([^\s#'"][^\s:]*)):\s*(?:#.*)?$/.exec(line);
      const host = (m?.[1] ?? m?.[2] ?? m?.[3])?.toLowerCase();
      current = null;
      childIndent = null;
      if (!host || !HOST_NAME.test(host)) continue;
      const known = hosts.find((h) => h.host === host);
      if (known) { known.tokenInFile = false; continue; }
      current = { host, tokenInFile: false };
      hosts.push(current);
      continue;
    }
    if (!current) continue;
    childIndent ??= indent;
    // Deeper lines are a user's own entry (`users:`), not the host's token.
    if (indent === childIndent && TOKEN_KEY.test(line) && !EMPTY_TOKEN.test(line)) current.tokenInFile = true;
  }
  return hosts;
}

/** The top-level keys of a `hosts.yml`: the hosts `gh` signs in to. */
export function parseGhHosts(text: string): string[] {
  return readGhHosts(text).map((h) => h.host);
}

/** The host a call reaches among the hosts a folder signs in to (see
 *  `ghForgeHost`). */
function forgeHostAmong(hosts: string[]): string | null {
  if (hosts.length === 0 || hosts.includes(GITHUB_HOST)) return GITHUB_HOST;
  return hosts.length === 1 ? hosts[0]! : null;
}

/**
 * The forge host `gh` reaches with `configDir`: github.com, or the one GitHub
 * Enterprise host its `hosts.yml` signs in to when github.com is not among
 * them. Null when it signs in to several Enterprise hosts and not github.com:
 * which one a call reaches is then not the folder's to tell.
 */
export function ghForgeHost(configDir: string | null, read: (file: string) => string = (file) => readFileSync(file, 'utf8')): string | null {
  if (!configDir) return GITHUB_HOST;
  let hosts: string[];
  try { hosts = parseGhHosts(read(join(configDir, 'hosts.yml'))); } catch { return GITHUB_HOST; }
  return forgeHostAmong(hosts);
}

/**
 * The config folder `gh` reads with `configDir`: that folder, or the default
 * gh resolves itself from the environment it inherits (`GH_CONFIG_DIR`, then
 * `XDG_CONFIG_HOME/gh`, then `%AppData%/GitHub CLI` on Windows, then
 * `~/.config/gh`), the same order as gh's own `ConfigDir`.
 */
export function ghConfigFolder(
  configDir: string | null, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform,
): string {
  if (configDir) return configDir;
  if (env.GH_CONFIG_DIR) return env.GH_CONFIG_DIR;
  if (env.XDG_CONFIG_HOME) return join(env.XDG_CONFIG_HOME, 'gh');
  if (platform === 'win32' && env.APPDATA) return join(env.APPDATA, 'GitHub CLI');
  return join(homedir(), '.config', 'gh');
}

export type GhCredentialsIo = {
  stat?: (file: string) => { ino: bigint; size: bigint; mtimeNs: bigint };
  read?: (file: string) => string;
};

/**
 * A stamp of the credentials `gh` signs in with for `configDir`: the inode,
 * size and modification time of its `hosts.yml`, when the token of the host gh
 * reaches is stored in that file. Logging in, out or switching accounts then
 * rewrites the file, so a stamp that moved means the account may have.
 *
 * Null when the token lives in the system keyring: its active entry is keyed
 * by host alone (`gh:<host>`), shared by every config folder, so a
 * `gh auth switch` or `gh auth login` run with another folder changes this
 * folder's account without touching its `hosts.yml`. Null too when the file
 * cannot be read. Nothing can be cached on a null stamp.
 */
export function ghCredentialsStamp(configDir: string | null, io: GhCredentialsIo = {}): string | null {
  const stat = io.stat ?? ((file: string) => statSync(file, { bigint: true }));
  const read = io.read ?? ((file: string) => readFileSync(file, 'utf8'));
  try {
    const file = join(ghConfigFolder(configDir), 'hosts.yml');
    // Stat first: a write that lands between the two moves the next stamp.
    const s = stat(file);
    const hosts = readGhHosts(read(file));
    const host = forgeHostAmong(hosts.map((h) => h.host));
    if (!host || !hosts.find((h) => h.host === host)?.tokenInFile) return null;
    // Nanoseconds: two writes within the same millisecond still differ.
    return `${s.ino}:${s.size}:${s.mtimeNs}`;
  } catch {
    return null;
  }
}

export type GhRunner = (args: string[], opts: ExecOpts) => Promise<ExecResult>;

const hostRunner: GhRunner = (args, opts) => getHost().execAsync('gh', args, opts);

export type GhLoginOutcome =
  | { ok: true; login: string }
  | { ok: false; code: 'gh_missing' | 'gh_failed' | 'timed_out' | 'unexpected_answer'; reason: string };

const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
const TIMEOUT_MS = 20_000;

/** What gh said, short, without anything shaped like a token. */
function redacted(text: string): string {
  return text
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, '[redacted]')
    .trim()
    .slice(0, 300);
}

/**
 * The login `gh` answers for with `configDir` (`gh api user`): one network
 * call to the forge, which the caller asks for explicitly.
 */
export async function ghLogin(configDir: string | null, run: GhRunner = hostRunner): Promise<GhLoginOutcome> {
  let result: ExecResult;
  try {
    result = await run(['api', 'user', '--jq', '.login'], { env: ghEnv(configDir), timeout: TIMEOUT_MS });
  } catch {
    return { ok: false, code: 'gh_missing', reason: 'the GitHub CLI (gh) was not found on this machine' };
  }
  if (result.timedOut) return { ok: false, code: 'timed_out', reason: 'gh did not answer in time' };
  if (result.code !== 0) {
    return { ok: false, code: 'gh_failed', reason: redacted(result.stderr || result.stdout) || `gh exited with code ${result.code}` };
  }
  const login = result.stdout.trim();
  if (!GITHUB_LOGIN.test(login)) return { ok: false, code: 'unexpected_answer', reason: 'gh did not answer a GitHub login' };
  return { ok: true, login };
}
