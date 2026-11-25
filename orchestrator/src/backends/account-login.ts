/**
 * Signing a subscription account in from the browser (TODO #52, volet 3).
 *
 * The CLI runs on the daemon's machine while the person is in a browser, maybe
 * on another one: a callback to `localhost` would never reach the CLI. Both
 * CLIs offer a flow that does not need it (checked on claude 2.1.295 and codex
 * 0.159.0):
 *
 * - `claude auth login` prints an authorize URL whose last page shows a code;
 *   the CLI reads that code on its stdin. The person pastes it in Timon.
 * - `codex login --device-auth` prints a URL and a one-time code; the person
 *   types the code on that page and the CLI polls until it is accepted.
 *
 * A flow belongs to the browser session that started it, lives in memory, and
 * dies with its TTL or a cancel. The CLI signs in in a staging directory; only
 * once the identity is checked (not a duplicate, the one expected on a
 * reconnect) is the credential file moved into the account directory. Nothing
 * of the staging copy survives: the account directory is the only one that
 * goes on refreshing the token, so no second holder can rotate it under the
 * missions' feet.
 *
 * macOS claude is the exception: the CLI keeps the sign-in in the keychain,
 * under a service name derived from the config directory path, which a move
 * cannot carry. There the CLI signs in in the account directory itself, and a
 * refused identity is signed out again and left to reconnect. Every flow holds
 * its account (`account-signin.ts`) until it finished and its CLI exited, so a
 * launch never moves that entry out of the keychain while the CLI may rewrite
 * it.
 *
 * Nothing the CLI prints leaves this module except the URL and the device
 * code the person needs: its output carries the OAuth state, and a failure is
 * reported as a closed code, never as the CLI's words.
 */
import type { ChildProcess } from 'node:child_process';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { dbApi } from '../db.js';
import { getHost } from '../host/index.js';
import { killProcessTree } from '../host/kill-tree.js';
import { chooseLaunchNode, withLaunchPath } from '../host/launch-path.js';
import { LAUNCHD_SYSTEM_KIND } from '../host/service-install.js';
import { ensurePrivateDir } from '../host/private-dir.js';
import { systemEnv } from '../secrets/env.js';
import { clearBackendCooldown } from '../backend-fallback.js';
import { resetBreaker } from '../backend-breaker.js';
import { beginAccountSignIn } from './account-signin.js';
import {
  BackendAccountIdentityTakenError, LOGIN_STAGING_DIR, accountInstance, accountLoginStagingDir,
  ensureAccountConfigDir, findBackendAccountByIdentity, getBackendAccount, setBackendAccountIdentity,
  setBackendAccountStatus, type BackendAccountRow,
} from './accounts.js';
import { activeProfiles, backendTakesAccounts, profileAccountsDeclaration } from './registry.js';
import type { ProviderHostSignInDeclaration, ProviderLoginDriver, ProviderLoginRun, ProviderTokenDriver } from './provider-declarations.js';
import { forgetHostSignIn, getHostSignIn, hostSignInDir, hostSignInId, recordHostSignIn } from './host-sign-in.js';
import { noteProviderSignedInByPerson, refreshProviderSignIn } from './sign-in-state.js';
import { loadNodePty, ptySpawnOptions } from '../terminal-host/pty.js';
import { isRemoteDialect } from './types.js';

export type LoginPrompt =
  | { kind: 'paste-code'; url: string }
  | { kind: 'device-code'; url: string; code: string };

export type LoginState = 'starting' | 'waiting' | 'verifying' | 'connected' | 'failed';

export type LoginFailure =
  | 'expired' | 'cancelled' | 'code_rejected' | 'duplicate' | 'mismatch'
  | 'not_signed_in' | 'cli_failed' | 'cli_missing' | 'unsupported'
  /** A long-lived token was minted, but its store refused it. */
  | 'not_saved';

export type LoginView = {
  accountId: string;
  backend: string;
  state: LoginState;
  prompt: LoginPrompt | null;
  failure: LoginFailure | null;
  /** On `connected`: who the account is now signed in as. On `mismatch`: who
   *  it was expected to be. Only its manager ever reads a flow. */
  identity: string | null;
  /** The code was sent to the CLI: the flow waits for its verdict. */
  codeSent: boolean;
  startedAt: number;
  expiresAt: number;
};

/** Who started a flow: only the same user, from the same session, reads it. */
export type LoginInitiator = { userId: string; binding: string };

export type Identity = { key: string; label: string };

export class LoginFlowError extends Error {
  constructor(readonly code: 'unsupported' | 'not_waiting' | 'bad_code', message: string) {
    super(message);
    this.name = 'LoginFlowError';
  }
}

type LoginSpawn = (cmd: string, args: string[], opts: { env: NodeJS.ProcessEnv; cwd: string }) => ChildProcess;

/**
 * The part of a flow that depends on the CLI. `dir` is where the CLI signs in
 * (staging, or the account directory when `inPlace`).
 */
type LoginDriver = {
  /** Kept for the whole flow: the paste flow needs the user, the device one
   *  only the provider's page. */
  promptKind: LoginPrompt['kind'];
  args(expected: string | null): string[];
  env(dir: string): Record<string, string>;
  /** The prompt, once the CLI printed enough of it. */
  parse(output: string): LoginPrompt | null;
  identity(dir: string): Promise<Identity | null>;
  /** Moves the credential from staging into the account directory. */
  install(staging: string, dest: string): void;
  /** Signs `dir` out (in-place flows only). */
  signOut(dir: string): Promise<void>;
  /** The CLI keeps its sign-in outside the folder it is given (the macOS keychain): sign in in the account's own folder. */
  inPlace?(platform: NodeJS.Platform): boolean;
  /** How long a flow waits for the person; absent = the backend's default. */
  ttlMs?: number;
};

/**
 * Where a flow's sign-in goes and what accepting it means. A subscription
 * account is one target; the flow itself (process, prompt, clocks, staging)
 * does not depend on which.
 */
type LoginTarget = {
  /** The flow's key in `flows`: one flow per target at a time. */
  readonly key: string;
  /** What the view calls it (`LoginView.accountId`). */
  readonly id: string;
  readonly backend: string;
  /** Who a reconnect expects (an e-mail), handed to the CLI; null for anyone. */
  readonly expected: string | null;
  /** The folder the sign-in ends in. */
  dir(): string;
  /** Where the CLI signs in before the result is checked (not in place). */
  stagingDir(): string;
  /** Holds the target while the flow or its CLI may still write its credential. */
  hold(): () => void;
  /** Records the start of a flow. */
  started(initiator: LoginInitiator): void;
  /**
   * The CLI signed in as `identity`: accept it (and move the credential in
   * when not in place), or refuse it. Never throws for a refusal.
   */
  settle(flow: Flow, identity: Identity): Promise<void>;
};

type Flow = {
  view: LoginView;
  initiator: LoginInitiator;
  target: LoginTarget;
  driver: LoginDriver;
  dir: string;
  inPlace: boolean;
  child: ChildProcess | null;
  output: string;
  timers: NodeJS.Timeout[];
  done: boolean;
  /** The CLI is gone (or never started): it can no longer write the account's credential. */
  exited: boolean;
  /** Lets go of the account's sign-in hold; idempotent. */
  release: () => void;
};

export type LoginOptions = {
  spawn: LoginSpawn;
  platform: NodeJS.Platform;
  /** How long a flow waits for the person: what the driver declared, or the default. */
  ttlMs: (backend: string, declared: number | undefined) => number;
  /** How long the CLI may take to print its prompt. */
  promptTimeoutMs: number;
  /** How long a finished flow stays readable for the poller. */
  retainMs: number;
  /** Removes a staging directory (swapped by tests to simulate a locked one). */
  removeDir: (dir: string) => void;
  /** Runs a CLI command to the end and returns its stdout (identity probes). */
  run: (cmd: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs: number) => Promise<{ code: number; stdout: string }>;
  /** Where the host adapter finds a binary (pin, then search); `null` when absent. */
  resolveBin: (name: string) => string | null;
  /**
   * The daemon runs as a macOS LaunchDaemon (`launchd-system`), outside every
   * user session: a login keychain is out of its reach.
   */
  outsideSession: () => boolean;
};

const OUTPUT_CAP = 64 * 1024;
/** A CLI that ignores even SIGKILL must not keep its account held until the daemon stops. */
const RELEASE_GRACE_MS = 15_000;
// A provider that says nothing about it: a code is short-lived.
const DEFAULT_TTL_MS = 10 * 60_000;

function defaultRun(cmd: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs: number): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = getHost().spawn(cmd, args, { env, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      resolve({ code: 1, stdout: '' });
      return;
    }
    let stdout = '';
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, timeoutMs);
    timer.unref();
    child.stdout?.on('data', (chunk: Buffer) => { if (stdout.length < OUTPUT_CAP) stdout += chunk.toString('utf8'); });
    child.on('error', () => { clearTimeout(timer); resolve({ code: 1, stdout: '' }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code: code ?? 1, stdout }); });
  });
}

let options: LoginOptions = {
  spawn: (cmd, args, opts) => getHost().spawn(cmd, args, { ...opts, stdio: ['pipe', 'pipe', 'pipe'] }),
  platform: process.platform,
  ttlMs: (_backend, declared) => declared ?? DEFAULT_TTL_MS,
  promptTimeoutMs: 60_000,
  retainMs: 5 * 60_000,
  removeDir: (dir) => rmSync(dir, { recursive: true, force: true }),
  run: defaultRun,
  resolveBin: (name) => { try { return getHost().bin(name); } catch { return null; } },
  outsideSession: () => process.env.TIMON_SERVICE_KIND === LAUNCHD_SYSTEM_KIND,
};

/** Tests only: swap the process runner and the clocks. */
export function setLoginOptions(next: Partial<LoginOptions>): void {
  options = { ...options, ...next };
}

const flows = new Map<string, Flow>();

/**
 * The environment of a login: the system whitelist, nothing of the daemon's
 * secrets. The graphical session is left out so the CLI does not open a
 * browser on the daemon's desktop (Linux; to check on Mac and Windows).
 */
function baseEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(systemEnv(process.env, { platform: options.platform }))) {
    if (value === undefined || key === 'DISPLAY' || key === 'WAYLAND_DISPLAY') continue;
    env[key] = value;
  }
  return env;
}

/**
 * The PATH a mission's CLI gets (`host/launch-path.ts`), for its login too: an npm
 * `codex` found under nvm or `%APPDATA%\npm` runs `env node`, which the service's
 * PATH does not hold (TODO #486).
 */
function launchEnv(cmd: string, env: Record<string, string>): Record<string, string> {
  const next = withLaunchPath(env, {
    platform: options.platform,
    binary: options.resolveBin(cmd),
    node: chooseLaunchNode({
      platform: options.platform,
      findNode: () => options.resolveBin('node'),
      // Only Electron's binary is no `node`: a daemon run from sources IS on the right one.
      selfExecutable: process.versions.electron ? process.execPath : undefined,
    }),
  });
  if (next === env) return env;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(next)) if (value !== undefined) out[key] = value;
  return out;
}

/**
 * A login driver a PROVIDER declared (S7), played by the daemon: the provider describes
 * its CLI, the daemon owns the process, the staging folder, the clocks and what the
 * driver is allowed to run — the CLI of this profile, in the system environment plus
 * what the driver passes, never the daemon's secrets.
 */
function declaredDriver(declared: ProviderLoginDriver, cmd: string): LoginDriver {
  const env = (dir: string): Record<string, string> => launchEnv(cmd, declared.env(dir, baseEnv()));
  const run: ProviderLoginRun = (args, extra, timeoutMs = 30_000) => options.run(cmd, [...args], launchEnv(cmd, { ...baseEnv(), ...extra }), timeoutMs);
  return {
    promptKind: declared.promptKind,
    args: (expected) => declared.args(expected),
    env,
    parse: (output) => declared.parse(output),
    identity: (dir) => declared.identity(dir, run),
    install: (staging, dest) => declared.install(staging, dest),
    signOut: (dir) => declared.signOut(dir, run),
    ...(declared.inPlace ? { inPlace: declared.inPlace } : {}),
    ...(declared.ttlMs ? { ttlMs: declared.ttlMs } : {}),
  };
}

function driverFor(backend: string): { driver: LoginDriver; cmd: string } | null {
  const entry = activeProfiles().find((candidate) => candidate.profile.id === backend && !candidate.account);
  if (!entry || isRemoteDialect(entry.dialect)) return null;
  const cmd = entry.profile.cmd ?? entry.dialect.defaultCmd;
  // What the provider declared, the product's own two included.
  const declared = profileAccountsDeclaration(entry)?.login;
  if (declared) return { driver: declaredDriver(declared, cmd), cmd };
  return null;
}

function snapshot(flow: Flow): LoginView {
  return { ...flow.view, prompt: flow.view.prompt ? { ...flow.view.prompt } : null };
}

function stopChild(flow: Flow): void {
  const child = flow.child;
  flow.child = null;
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  // The whole tree: an orphaned codex would go on polling and could still
  // write a live sign-in after the flow was cancelled.
  killProcessTree(child, options.platform);
  const hard = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, 3_000);
  hard.unref();
}

function cleanup(flow: Flow): void {
  for (const timer of flow.timers) clearTimeout(timer);
  flow.timers = [];
  stopChild(flow);
  if (!flow.inPlace) removeStaging(flow.dir);
}

/**
 * Never throws: it runs from timers and child events, where an exception
 * would take the daemon down. Windows refuses to remove the working directory
 * of a CLI still exiting; the next flow on the account, or the next boot,
 * removes what is left.
 */
function removeStaging(dir: string): void {
  try {
    options.removeDir(dir);
  } catch {
    console.warn('[account-login] staging directory left in place, removed at the next flow or boot');
  }
}

/** The hold ends once nothing of the flow can write the credential any more. */
function releaseWhenSettled(flow: Flow): void {
  if (flow.done && flow.exited) flow.release();
}

function finish(flow: Flow, state: 'connected' | 'failed', failure: LoginFailure | null, identity: string | null = null): void {
  if (flow.done) return;
  flow.done = true;
  flow.view = { ...flow.view, state, failure, identity, prompt: null };
  cleanup(flow);
  releaseWhenSettled(flow);
  if (!flow.exited) {
    const grace = setTimeout(flow.release, RELEASE_GRACE_MS);
    grace.unref();
  }
  if (state === 'failed') console.warn(`[account-login] ${flow.view.backend} account ${flow.view.accountId}: ${failure}`);
  const retain = setTimeout(() => {
    if (flows.get(flow.target.key) === flow) flows.delete(flow.target.key);
  }, options.retainMs);
  retain.unref();
}

function audit(initiator: LoginInitiator, action: string, row: BackendAccountRow): void {
  dbApi.insertAuditLog({
    userId: initiator.userId,
    action,
    target: `${accountInstance(row)} owner:${row.owner_user_id ?? 'instance'}`,
  });
}

/**
 * The CLI said it is signed in: check who as, then let the target accept it.
 */
async function verify(flow: Flow): Promise<void> {
  flow.view = { ...flow.view, state: 'verifying' };
  const identity = await flow.driver.identity(flow.dir);
  if (flow.done) return;
  if (!identity) return finish(flow, 'failed', 'not_signed_in');
  await flow.target.settle(flow, identity);
}

/**
 * A subscription account: refuse a duplicate or another person than
 * expected, then move the credential in and put the account back in rotation.
 */
function accountTarget(account: BackendAccountRow): LoginTarget {
  return {
    key: account.id,
    id: account.id,
    backend: account.backend,
    expected: account.identity_label,
    dir: () => ensureAccountConfigDir(account.id),
    stagingDir: () => accountLoginStagingDir(account.id),
    hold: () => beginAccountSignIn(account.id),
    started: (initiator) => audit(initiator, 'backend_account.login_start', account),
    async settle(flow, identity) {
      const row = getBackendAccount(account.id);
      if (!row) return finish(flow, 'failed', 'cancelled');

      const refuse = async (failure: LoginFailure, label: string | null = null) => {
        // In place, the refused sign-in already replaced the previous one: it
        // must not stay usable, so the account waits for a proper reconnect.
        if (flow.inPlace) {
          await flow.driver.signOut(flow.dir);
          setBackendAccountStatus(row.id, 'reauth');
        }
        finish(flow, 'failed', failure, label);
      };
      if (row.identity_key && row.identity_key !== identity.key) return refuse('mismatch', row.identity_label);
      const holder = findBackendAccountByIdentity(row.backend, identity.key);
      if (holder && holder.id !== row.id) return refuse('duplicate');

      // Claimed before the move: the unique index settles two flows finishing at
      // once, and the loser never touches its account's credential.
      try {
        setBackendAccountIdentity(row.id, identity);
      } catch (err) {
        if (err instanceof BackendAccountIdentityTakenError) return refuse('duplicate');
        throw err;
      }
      if (!flow.inPlace) {
        try {
          flow.driver.install(flow.dir, ensureAccountConfigDir(row.id));
        } catch {
          setBackendAccountIdentity(row.id, row.identity_key && row.identity_label ? { key: row.identity_key, label: row.identity_label } : null);
          return finish(flow, 'failed', 'cli_failed');
        }
      }
      setBackendAccountStatus(row.id, 'active');
      clearBackendCooldown(accountInstance(row));
      resetBreaker(accountInstance(row));
      audit(flow.initiator, 'backend_account.connect', row);
      finish(flow, 'connected', null, identity.label);
    },
  };
}

/** The host's kept sign-in of `backend`, and the provider still offers it. */
function hostDeclaration(backend: string): ProviderHostSignInDeclaration | null {
  if (!backendTakesAccounts(backend)) return null;
  const entry = activeProfiles().find((candidate) => candidate.profile.id === backend && !candidate.account);
  return (entry && profileAccountsDeclaration(entry)?.host) ?? null;
}

/**
 * Whether only a long-lived token can run `backend`'s host launches: its CLI
 * keeps a sign-in in place (the macOS keychain) and the daemon runs outside
 * every user session, so neither the terminal's session nor a sign-in kept
 * in Timon's folder can be read (TODO #1140).
 */
function hostTokenOnly(backend: string, host: ProviderHostSignInDeclaration): boolean {
  if (!host.token) return false;
  const resolved = driverFor(backend);
  return resolved?.driver.inPlace?.(options.platform) === true && options.outsideSession();
}

/** What the screen may offer for the host's sign-in of `backend`; null when nothing. */
export function hostSignInSupport(backend: string): { browser: boolean; token: boolean; tokenOnly: boolean } | null {
  const host = hostDeclaration(backend);
  if (!host) return null;
  const tokenOnly = hostTokenOnly(backend, host);
  return { browser: driverFor(backend) !== null && !tokenOnly, token: host.token !== undefined, tokenOnly };
}

/** Whether the provider keeps a long-lived token for `backend` now; null when it has none to keep. */
export function hostTokenStored(backend: string): boolean | null {
  const token = hostDeclaration(backend)?.token;
  if (!token) return null;
  try { return token.stored(); } catch { return false; }
}

function hostAudit(initiator: LoginInitiator, action: string, backend: string): void {
  dbApi.insertAuditLog({ userId: initiator.userId, action, target: backend });
}

/**
 * The host's own sign-in, kept in Timon's folder (`host-sign-in.ts`). No
 * account row, so no duplicate check: it is in no rotation, and the operator
 * may sign it in as anyone, a reconnect included.
 */
function hostTarget(backend: string): LoginTarget {
  const id = hostSignInId(backend);
  return {
    key: `host:${backend}`,
    id,
    backend,
    expected: null,
    dir: () => ensurePrivateDir(hostSignInDir(backend)),
    stagingDir: () => accountLoginStagingDir(id),
    hold: () => beginAccountSignIn(id),
    started: (initiator) => hostAudit(initiator, 'backend_host.login_start', backend),
    async settle(flow, identity) {
      if (!flow.inPlace) {
        try {
          flow.driver.install(flow.dir, ensurePrivateDir(hostSignInDir(backend)));
        } catch {
          return finish(flow, 'failed', 'cli_failed');
        }
      }
      recordHostSignIn(backend, identity);
      clearBackendCooldown(backend);
      resetBreaker(backend);
      hostAudit(flow.initiator, 'backend_host.connect', backend);
      // Before `connected`: whoever reads the verdict once the flow reports success must find it signed in.
      noteProviderSignedInByPerson(backend);
      finish(flow, 'connected', null, identity.label);
    },
  };
}

/**
 * Starts signing `account` in. A flow already running on the account is
 * cancelled first: one CLI login per account at a time.
 */
export function startAccountLogin(account: BackendAccountRow, initiator: LoginInitiator): LoginView {
  return startLogin(accountTarget(account), initiator);
}

function startLogin(target: LoginTarget, initiator: LoginInitiator): LoginView {
  const resolved = driverFor(target.backend);
  if (!resolved) throw new LoginFlowError('unsupported', `backend ${target.backend} has no login flow`);
  const { driver, cmd } = resolved;
  cancelLoginInternal(target.key);

  // macOS claude keeps the sign-in in a keychain entry named after the config
  // directory: signing in elsewhere and moving the files would lose it.
  const inPlace = driver.inPlace?.(options.platform) ?? false;
  const ttlMs = options.ttlMs(target.backend, driver.ttlMs);
  let dir: string;
  if (inPlace) {
    dir = target.dir();
  } else {
    dir = target.stagingDir();
    removeStaging(dir);
    ensurePrivateDir(LOGIN_STAGING_DIR, options.platform);
    ensurePrivateDir(dir, options.platform);
  }
  const startedAt = Date.now();
  const flow: Flow = {
    view: {
      accountId: target.id, backend: target.backend, state: 'starting', prompt: null, failure: null,
      identity: null, codeSent: false, startedAt, expiresAt: startedAt + ttlMs,
    },
    initiator, target, driver, dir, inPlace, child: null, output: '', timers: [], done: false,
    exited: false, release: target.hold(),
  };
  flows.set(target.key, flow);

  let child: ChildProcess;
  try {
    child = options.spawn(cmd, driver.args(target.expected), { env: driver.env(dir), cwd: dir });
  } catch {
    flow.exited = true;
    finish(flow, 'failed', 'cli_missing');
    return snapshot(flow);
  }
  flow.child = child;
  const onData = (chunk: Buffer | string) => {
    if (flow.done || flow.output.length >= OUTPUT_CAP) return;
    flow.output += chunk.toString();
    if (!flow.view.prompt) {
      const prompt = driver.parse(flow.output);
      if (prompt) flow.view = { ...flow.view, prompt, state: 'waiting' };
    }
  };
  child.stdout?.on('data', onData);
  child.stderr?.on('data', onData);
  child.stdin?.on('error', () => { /* the CLI left: its exit says how */ });
  child.on('error', (err: NodeJS.ErrnoException) => {
    // `error` without a process (ENOENT) is never followed by `exit`.
    if (child.pid === undefined) flow.exited = true;
    finish(flow, 'failed', err.code === 'ENOENT' ? 'cli_missing' : 'cli_failed');
    releaseWhenSettled(flow);
  });
  child.on('exit', (code) => {
    flow.exited = true;
    releaseWhenSettled(flow);
    if (flow.done) return;
    flow.child = null;
    // A 0 without a pasted code is a sign-in that completed through the CLI's
    // own local callback (the person was on the daemon's machine).
    if (code === 0) {
      // `finish` never throws (`removeStaging`), so this catch cannot reject.
    void verify(flow).catch(() => finish(flow, 'failed', 'cli_failed'));
      return;
    }
    finish(flow, 'failed', flow.view.codeSent ? 'code_rejected' : 'cli_failed');
  });
  const expire = setTimeout(() => finish(flow, 'failed', 'expired'), ttlMs);
  const promptGuard = setTimeout(() => { if (!flow.view.prompt) finish(flow, 'failed', 'cli_failed'); }, options.promptTimeoutMs);
  expire.unref();
  promptGuard.unref();
  flow.timers.push(expire, promptGuard);
  target.started(initiator);
  return snapshot(flow);
}

function owned(key: string, initiator: LoginInitiator): Flow | undefined {
  const flow = flows.get(key);
  if (!flow || flow.initiator.userId !== initiator.userId || flow.initiator.binding !== initiator.binding) return undefined;
  return flow;
}

/** The flow of an account, for the session that started it only. */
export function getAccountLogin(accountId: string, initiator: LoginInitiator): LoginView | undefined {
  const flow = owned(accountId, initiator);
  return flow ? snapshot(flow) : undefined;
}

// Printable ASCII without blanks: the code goes to the CLI's stdin, never to a
// shell, so the only hazard is a line break or a control character.
const CODE_RE = /^[\x21-\x7e]{1,4096}$/;

/**
 * What the person pasted, as the CLI reads it: the code shown on the
 * provider's page (`code#state`), or the final URL of that page, from which
 * the same pair is taken.
 */
export function normalizeLoginCode(input: string): string | null {
  const text = input.trim();
  if (/^https?:\/\//i.test(text)) {
    try {
      const url = new URL(text);
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      const pair = code ? (state ? `${code}#${state}` : code) : null;
      return pair && CODE_RE.test(pair) ? pair : null;
    } catch {
      return null;
    }
  }
  return CODE_RE.test(text) ? text : null;
}

/** Hands the pasted code to the CLI. Undefined when the flow is not this session's. */
export function submitAccountLoginCode(accountId: string, initiator: LoginInitiator, input: string): LoginView | undefined {
  const flow = owned(accountId, initiator);
  if (!flow) return undefined;
  if (flow.done || flow.view.state !== 'waiting' || flow.driver.promptKind !== 'paste-code' || flow.view.codeSent || !flow.child?.stdin) {
    throw new LoginFlowError('not_waiting', 'this sign-in is not waiting for a code');
  }
  const code = normalizeLoginCode(input);
  if (!code) throw new LoginFlowError('bad_code', 'this does not look like a sign-in code');
  const stdin = flow.child.stdin;
  // Marked first: a CLI that rejects the code may exit within the write.
  flow.view = { ...flow.view, codeSent: true };
  stdin.write(`${code}\n`);
  return snapshot(flow);
}

/** Stops the session's flow. Undefined when there is none for it. */
export function cancelAccountLogin(accountId: string, initiator: LoginInitiator): LoginView | undefined {
  const flow = owned(accountId, initiator);
  if (!flow) return undefined;
  finish(flow, 'failed', 'cancelled');
  return snapshot(flow);
}

/** Stops whatever flow runs on the account (account deleted, new flow). */
export function cancelAccountLoginInternal(accountId: string): void {
  cancelLoginInternal(accountId);
}

function cancelLoginInternal(key: string): void {
  const flow = flows.get(key);
  if (!flow) return;
  finish(flow, 'failed', 'cancelled');
  flows.delete(key);
}

/** Staging left by a daemon that stopped mid-flow: never a live sign-in. */
export function purgeLoginStaging(): void {
  removeStaging(LOGIN_STAGING_DIR);
}

/** Tests only. */
export function resetAccountLogins(): void {
  for (const key of [...flows.keys()]) cancelLoginInternal(key);
}

/* ── The host's own sign-in, kept by Timon ──────────────────────────────── */

function hostKey(backend: string): string {
  return `host:${backend}`;
}

/** Starts signing the host's `backend` in from the browser, into Timon's folder. */
export function startHostLogin(backend: string, initiator: LoginInitiator): LoginView {
  const host = hostDeclaration(backend);
  if (!host) throw new LoginFlowError('unsupported', `backend ${backend} cannot keep the host's sign-in`);
  if (hostTokenOnly(backend, host)) {
    throw new LoginFlowError('unsupported', 'Timon runs as a service outside your session, where this sign-in cannot be read: create a long-lived token instead');
  }
  return startLogin(hostTarget(backend), initiator);
}

export function getHostLogin(backend: string, initiator: LoginInitiator): LoginView | undefined {
  const flow = owned(hostKey(backend), initiator);
  return flow ? snapshot(flow) : undefined;
}

export function submitHostLoginCode(backend: string, initiator: LoginInitiator, input: string): LoginView | undefined {
  return submitAccountLoginCode(hostKey(backend), initiator, input);
}

export function cancelHostLogin(backend: string, initiator: LoginInitiator): LoginView | undefined {
  return cancelAccountLogin(hostKey(backend), initiator);
}

/**
 * Back to the CLI's own sign-in (the terminal's session). A CLI that keeps the
 * sign-in in place (the macOS keychain, under the folder's name) is signed out
 * first, so no entry of Timon's folder stays behind; the folder then goes.
 */
export async function forgetHostLogin(backend: string): Promise<boolean> {
  cancelLoginInternal(hostKey(backend));
  const resolved = driverFor(backend);
  const kept = getHostSignIn(backend);
  if (kept && resolved?.driver.inPlace?.(options.platform)) {
    try { await resolved.driver.signOut(hostSignInDir(backend)); } catch { /* the folder goes anyway */ }
  }
  const removed = forgetHostSignIn(backend);
  await refreshProviderSignIn(backend, true);
  return removed;
}

/* ── A long-lived token, minted in a pseudo-terminal ────────────────────── */

/** The part of node-pty a token flow uses (`terminal-host/pty.ts`). */
export type TokenPty = {
  readonly pid: number;
  onData(listener: (data: string) => void): void;
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): void;
  write(data: string): void;
  kill(): void;
};

export type TokenPtySpawn = (file: string, args: string[], opts: { env: Record<string, string>; cwd: string; cols: number; rows: number }) => TokenPty;

/**
 * Wide enough that neither the page's address nor the token is ever wrapped:
 * the CLI draws its screen to the terminal's width, cursor moves included, and
 * a wrapped token would not read back in one piece.
 */
const TOKEN_COLS = 1000;
const TOKEN_ROWS = 50;

let tokenSpawn: TokenPtySpawn = (file, args, opts) => {
  // node-pty loads on the first flow (`loadNodePty`): a host without the native module only loses this gesture.
  const pty = loadNodePty();
  if (!pty) throw new Error('pty_unavailable');
  return pty.spawn(file, args, ptySpawnOptions({ shell: file, args, ...opts }, options.platform));
};

/** Tests only: swap the pseudo-terminal. */
export function setTokenPtySpawn(spawn: TokenPtySpawn): void {
  tokenSpawn = spawn;
}

type TokenFlow = {
  view: LoginView;
  initiator: LoginInitiator;
  driver: ProviderTokenDriver;
  dir: string;
  pty: TokenPty | null;
  /** The screen's last bytes, until the prompt is read. Never logged, wiped at the end. */
  output: string;
  /** What the CLI drew after the code was sent: where the token, or the refusal, appears. */
  afterCode: string;
  timers: NodeJS.Timeout[];
  done: boolean;
};

const tokenFlows = new Map<string, TokenFlow>();

function tokenSnapshot(flow: TokenFlow): LoginView {
  return { ...flow.view, prompt: flow.view.prompt ? { ...flow.view.prompt } : null };
}

function finishToken(flow: TokenFlow, state: 'connected' | 'failed', failure: LoginFailure | null): void {
  if (flow.done) return;
  flow.done = true;
  flow.view = { ...flow.view, state, failure, prompt: null };
  flow.output = '';
  flow.afterCode = '';
  for (const timer of flow.timers) clearTimeout(timer);
  flow.timers = [];
  const pty = flow.pty;
  flow.pty = null;
  try { pty?.kill(); } catch { /* gone */ }
  removeStaging(flow.dir);
  if (state === 'failed') console.warn(`[account-login] ${flow.view.backend} long-lived token: ${failure}`);
  const retain = setTimeout(() => {
    if (tokenFlows.get(flow.view.backend) === flow) tokenFlows.delete(flow.view.backend);
  }, options.retainMs);
  retain.unref();
}

/** The command a pseudo-terminal runs: a Windows npm shim is a batch file, which only `cmd.exe` runs. */
function ptyCommand(cmd: string, args: string[]): { file: string; args: string[] } {
  const path = options.resolveBin(cmd) ?? cmd;
  if (options.platform === 'win32' && /\.(cmd|bat)$/i.test(path)) {
    return { file: process.env.ComSpec ?? 'cmd.exe', args: ['/d', '/s', '/c', path, ...args] };
  }
  return { file: path, args };
}

function tokenSeen(flow: TokenFlow): boolean {
  const token = flow.driver.token(flow.afterCode);
  if (!token) return false;
  try {
    flow.driver.save(token);
  } catch {
    finishToken(flow, 'failed', 'not_saved');
    return true;
  }
  hostAudit(flow.initiator, 'backend_host.token_created', flow.view.backend);
  noteProviderSignedInByPerson(flow.view.backend);
  finishToken(flow, 'connected', null);
  return true;
}

/**
 * Starts minting a long-lived token for the host's `backend`. The CLI runs in a
 * throwaway private folder, in a pseudo-terminal; the person opens the page,
 * pastes its code, and the token the CLI prints goes to the provider's store.
 */
export function startHostToken(backend: string, initiator: LoginInitiator): LoginView {
  const driver = hostDeclaration(backend)?.token;
  const entry = activeProfiles().find((candidate) => candidate.profile.id === backend && !candidate.account);
  if (!driver || !entry || isRemoteDialect(entry.dialect)) throw new LoginFlowError('unsupported', `backend ${backend} mints no long-lived token`);
  cancelHostTokenInternal(backend);
  const cmd = entry.profile.cmd ?? entry.dialect.defaultCmd;
  const dir = accountLoginStagingDir(`token${backend}`);
  removeStaging(dir);
  ensurePrivateDir(LOGIN_STAGING_DIR, options.platform);
  ensurePrivateDir(dir, options.platform);
  const ttlMs = options.ttlMs(backend, driver.ttlMs);
  const startedAt = Date.now();
  const flow: TokenFlow = {
    view: {
      accountId: backend, backend, state: 'starting', prompt: null, failure: null,
      identity: null, codeSent: false, startedAt, expiresAt: startedAt + ttlMs,
    },
    initiator, driver, dir, pty: null, output: '', afterCode: '', timers: [], done: false,
  };
  tokenFlows.set(backend, flow);

  let pty: TokenPty;
  try {
    const run = ptyCommand(cmd, driver.args());
    pty = tokenSpawn(run.file, run.args, {
      env: launchEnv(cmd, driver.env(dir, baseEnv())), cwd: dir, cols: TOKEN_COLS, rows: TOKEN_ROWS,
    });
  } catch (err) {
    finishToken(flow, 'failed', (err as Error).message === 'pty_unavailable' ? 'unsupported' : 'cli_missing');
    return tokenSnapshot(flow);
  }
  flow.pty = pty;
  pty.onData((data) => {
    if (flow.done) return;
    if (flow.view.codeSent) {
      flow.afterCode = (flow.afterCode + data).slice(-OUTPUT_CAP);
      if (tokenSeen(flow)) return;
      if (driver.rejected(flow.afterCode)) finishToken(flow, 'failed', 'code_rejected');
      return;
    }
    if (flow.view.prompt) return;
    // A rolling tail: the CLI redraws its screen, and the address comes after its banner.
    flow.output = (flow.output + data).slice(-OUTPUT_CAP);
    const prompt = driver.parse(flow.output);
    if (prompt) {
      flow.output = '';
      flow.view = { ...flow.view, prompt: { kind: 'paste-code', url: prompt.url }, state: 'waiting' };
    }
  });
  pty.onExit(() => {
    flow.pty = null;
    if (flow.done) return;
    if (flow.view.codeSent && tokenSeen(flow)) return;
    finishToken(flow, 'failed', flow.view.codeSent ? 'code_rejected' : 'cli_failed');
  });
  const expire = setTimeout(() => finishToken(flow, 'failed', 'expired'), ttlMs);
  const promptGuard = setTimeout(() => { if (!flow.view.prompt) finishToken(flow, 'failed', 'cli_failed'); }, options.promptTimeoutMs);
  expire.unref();
  promptGuard.unref();
  flow.timers.push(expire, promptGuard);
  hostAudit(initiator, 'backend_host.token_start', backend);
  return tokenSnapshot(flow);
}

function ownedToken(backend: string, initiator: LoginInitiator): TokenFlow | undefined {
  const flow = tokenFlows.get(backend);
  if (!flow || flow.initiator.userId !== initiator.userId || flow.initiator.binding !== initiator.binding) return undefined;
  return flow;
}

export function getHostToken(backend: string, initiator: LoginInitiator): LoginView | undefined {
  const flow = ownedToken(backend, initiator);
  return flow ? tokenSnapshot(flow) : undefined;
}

/** Types the pasted code into the CLI's screen. Undefined when the flow is not this session's. */
export function submitHostTokenCode(backend: string, initiator: LoginInitiator, input: string): LoginView | undefined {
  const flow = ownedToken(backend, initiator);
  if (!flow) return undefined;
  if (flow.done || flow.view.state !== 'waiting' || flow.view.codeSent || !flow.pty) {
    throw new LoginFlowError('not_waiting', 'this sign-in is not waiting for a code');
  }
  const code = normalizeLoginCode(input);
  if (!code) throw new LoginFlowError('bad_code', 'this does not look like a sign-in code');
  flow.view = { ...flow.view, codeSent: true, state: 'verifying' };
  // A terminal's Enter is a carriage return.
  flow.pty.write(`${code}\r`);
  return tokenSnapshot(flow);
}

export function cancelHostToken(backend: string, initiator: LoginInitiator): LoginView | undefined {
  const flow = ownedToken(backend, initiator);
  if (!flow) return undefined;
  finishToken(flow, 'failed', 'cancelled');
  return tokenSnapshot(flow);
}

function cancelHostTokenInternal(backend: string): void {
  const flow = tokenFlows.get(backend);
  if (!flow) return;
  finishToken(flow, 'failed', 'cancelled');
  tokenFlows.delete(backend);
}

/** Tests only. */
export function resetHostTokens(): void {
  for (const backend of [...tokenFlows.keys()]) cancelHostTokenInternal(backend);
}
