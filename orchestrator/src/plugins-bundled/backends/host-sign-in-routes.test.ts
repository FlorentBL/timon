/**
 * The host's own Claude sign-in from the browser (TODO #426): into Timon's folder with the
 * accounts' login driver, a long-lived token minted in a pseudo-terminal, back to the
 * terminal's session. The CLI and the pseudo-terminal are fakes driven by the test: no real
 * `claude` runs. Isolated TIMON_HOME, witness server on 127.0.0.1:0.
 */
import { EventEmitter, once } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { grantTestPermissions, postTestAccount } from '../../../tests/helpers/accounts.js';

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-host-sign-in-'));
await import('../../../tests/helpers/paid-license.js');
process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';

const { createDaemonAuthMiddleware } = await import('../http/auth.js');
const { registerRoutes: registerUserRoutes } = await import('../users/routes.js');
const { registerAccountRoutes } = await import('./account-routes.js');
const { registerHostSignInRoutes } = await import('./host-sign-in-routes.js');
const { resetAccountLogins, resetHostTokens, setLoginOptions, setTokenPtySpawn } = await import('../../backends/account-login.js');
const { credentialAccountOf, hostSignInDir } = await import('../../backends/host-sign-in.js');
const { activeProfiles, providerAuthStatus } = await import('../../backends/registry.js');
const { dbApi } = await import('../../db.js');
const { SESSION_COOKIE } = await import('../../users/session.js');
const { issueMissionApiToken } = await import('../../users/api-tokens.js');
const { providerSignedIn, refreshProviderSignIn, resetProviderSignInForTest, setProviderSignInForTest, setSignInEnv } = await import('../../backends/sign-in-state.js');

class FakeCli extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  constructor(readonly args: string[], readonly env: NodeJS.ProcessEnv) { super(); }
  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    if (this.exitCode === null && this.signalCode === null) {
      this.signalCode = signal;
      this.emit('exit', null, signal);
    }
    return true;
  }
  exit(code: number): void {
    this.exitCode = code;
    this.emit('exit', code, null);
  }
}

const CODE = 'Secr3tAuthCode_host#St4te-xyz';
const TOKEN_CODE = 'Secr3tTokenCode_host#St4te-tok';
const LONG_LIVED = 'sk-ant-oat01-LongLivedTokenMadeUpForTheRouteTest_abcdefghijklmnopqrstuvwxyz0123456789';
const AUTHORIZE = 'https://claude.com/cai/oauth/authorize?code=true&scope=user%3Ainference&state=abc';
const EMAIL = 'host@perso.example';

function fakeSpawn(_cmd: string, args: string[], opts: { env: NodeJS.ProcessEnv; cwd: string }): ChildProcess {
  const cli = new FakeCli(args, opts.env);
  setImmediate(() => {
    cli.stdout.write(`If the browser didn't open, visit: ${AUTHORIZE}\nPaste code here if prompted > `);
    cli.stdin.on('data', (chunk: Buffer) => {
      if (chunk.toString().trim() !== CODE) return cli.exit(1);
      const dir = opts.env.CLAUDE_CONFIG_DIR!;
      writeFileSync(join(dir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'host-access' } }));
      writeFileSync(join(dir, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: EMAIL } }));
      cli.exit(0);
    });
  });
  return cli as unknown as ChildProcess;
}

async function fakeRun(_cmd: string, args: string[], env: NodeJS.ProcessEnv) {
  const dir = env.CLAUDE_CONFIG_DIR!;
  if (args[1] === 'logout') return { code: 0, stdout: '' };
  if (!existsSync(join(dir, '.credentials.json'))) return { code: 1, stdout: JSON.stringify({ loggedIn: false }) };
  const email = (JSON.parse(readFileSync(join(dir, '.claude.json'), 'utf8')) as { oauthAccount: { emailAddress: string } }).oauthAccount.emailAddress;
  return { code: 0, stdout: JSON.stringify({ loggedIn: true, email, orgId: 'org-host' }) };
}

setLoginOptions({ spawn: fakeSpawn, run: fakeRun, platform: 'linux', promptTimeoutMs: 5_000, retainMs: 60_000, resolveBin: () => null });

/** A pseudo-terminal running `claude setup-token`: what it was started with, and what it was typed. */
type PtyRun = { file: string; args: string[]; env: Record<string, string>; typed: string[]; killed: boolean };
const ptyRuns: PtyRun[] = [];
/** What the fake prints after a code: the token, or the CLI's refusal. */
let ptyAnswer: 'token' | 'refuse' = 'token';
setTokenPtySpawn((file, args, opts) => {
  const run: PtyRun = { file, args, env: opts.env, typed: [], killed: false };
  ptyRuns.push(run);
  const data: Array<(text: string) => void> = [];
  const exits: Array<(event: { exitCode: number }) => void> = [];
  const emit = (text: string) => { for (const listener of data) listener(text); };
  setImmediate(() => emit(`Welcome\r\n\u001b]8;id=x;${AUTHORIZE}\u0007${AUTHORIZE.slice(0, 30)}\u001b]8;;\u0007\r\nPaste code here if prompted >`));
  return {
    pid: 4242,
    onData: (listener) => { data.push(listener); },
    onExit: (listener) => { exits.push(listener); },
    write(text) {
      run.typed.push(text);
      if (text !== `${TOKEN_CODE}\r`) return;
      setImmediate(() => emit(ptyAnswer === 'token'
        ? `\u001b[32mcreated\u001b[39m\r\nYour\u001b[6GOAuth\u001b[12Gtoken\u001b[18G(valid\u001b[25Gfor\u001b[29G1\u001b[31Gyear):\r\n\u001b[33m${LONG_LIVED}\u001b[39m\r\n`
        : '\u001b[31mOAuth\u001b[7Gerror:\u001b[14GThat code wasn\'t accepted.\u001b[39m'));
    },
    kill() { run.killed = true; for (const listener of exits) listener({ exitCode: 0 }); },
  };
});

const logged: string[] = [];
{
  const { mountOfficialProviders } = await import('../../../tests/helpers/official-providers.js');
  await mountOfficialProviders();
}
for (const level of ['log', 'warn', 'error'] as const) {
  const original = console[level];
  console[level] = (...parts: unknown[]) => { logged.push(parts.map(String).join(' ')); original(...parts); };
}

const DAEMON = 'witness-daemon-token';
const app = express();
app.use(createDaemonAuthMiddleware({ token: DAEMON, required: true }));
app.use(express.json());
registerUserRoutes(app, { setupPolicy: 'free' });
registerAccountRoutes(app);
registerHostSignInRoutes(app);
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
test.after(() => { resetAccountLogins(); resetHostTokens(); server.close(); });

type Login = { state: string; failure: string | null; identity: string | null; codeSent: boolean; prompt: { kind: string; url: string } | null };
type View = { kept: boolean; identity: string | null; browser: boolean; token: { stored: boolean } | null; tokenOnly: boolean; signedIn: boolean | null };
type Reply = { status: number; text: string; json: { login?: Login; hostSignIn?: View } & Record<string, unknown> };
const replies: string[] = [];

async function call(method: string, path: string, opts: { body?: unknown; cookie?: string; bearer?: string } = {}): Promise<Reply> {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (opts.cookie) headers.cookie = `${SESSION_COOKIE}=${encodeURIComponent(opts.cookie)}`;
  if (opts.bearer) headers.authorization = `Bearer ${opts.bearer}`;
  const res = await fetch(`${base}${path}`, { method, headers, ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }) });
  const text = await res.text();
  replies.push(text);
  return { status: res.status, text, json: text ? JSON.parse(text) : {} };
}

async function login(email: string, password: string): Promise<string> {
  const res = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });
  const line = res.headers.getSetCookie().find((l) => l.startsWith(`${SESSION_COOKIE}=`))!;
  return decodeURIComponent(line.split(';')[0]!.slice(SESSION_COOKIE.length + 1));
}

async function until(path: string, cookie: string, done: (login: Login) => boolean): Promise<Login> {
  for (let i = 0; i < 100; i++) {
    const login = (await call('GET', path, { cookie })).json.login!;
    if (done(login)) return login;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('the flow never got there');
}

const over = (login: Login) => login.state === 'connected' || login.state === 'failed';
const HOST = '/api/backends/host-sign-in/claude';

assert.equal((await call('POST', '/api/auth/setup', { body: { email: 'admin@example.com', name: 'Admin', password: 'admin-secret' } })).status, 201);
const admin = await login('admin@example.com', 'admin-secret');
assert.equal((await postTestAccount(dbApi, { email: 'ada@example.com', name: 'ada', password: 'ada-secret' })).status, 201);
const ada = await login('ada@example.com', 'ada-secret');
grantTestPermissions(dbApi, dbApi.getUserByEmail('ada@example.com')!.id, ['providers:accounts']);

test('an anonymous caller is refused on every route of the host sign-in', async () => {
  const routes: Array<[string, string]> = [
    ['GET', ''], ['DELETE', ''],
    ['POST', '/login'], ['GET', '/login'], ['POST', '/login/code'], ['DELETE', '/login'],
    ['POST', '/token'], ['GET', '/token'], ['POST', '/token/code'], ['DELETE', '/token'],
  ];
  for (const [method, path] of routes) {
    const res = await call(method, `${HOST}${path}`, { body: method === 'POST' ? {} : undefined });
    assert.equal(res.status, 401, `${method} ${path}`);
  }
});

test('below the full level of the Providers screen, and from a mission, the host sign-in is refused', async () => {
  assert.equal((await call('GET', HOST, { cookie: ada })).status, 403);
  assert.equal((await call('POST', `${HOST}/login`, { cookie: ada, body: {} })).status, 403);
  assert.equal((await call('POST', `${HOST}/token`, { cookie: ada, body: {} })).status, 403);
  dbApi.createMission('mission-host-1', 'host-agent', 'brief', undefined, dbApi.getUserByEmail('admin@example.com')!.id);
  const mission = issueMissionApiToken('mission-host-1');
  assert.equal((await call('GET', HOST, { bearer: mission })).status, 403);
  assert.equal((await call('POST', `${HOST}/login`, { bearer: mission, body: {} })).status, 403);
  assert.equal((await call('DELETE', HOST, { bearer: mission })).status, 403);
});

test('the daemon token reads the state but starts no flow: a flow belongs to a browser session', async () => {
  const read = await call('GET', HOST, { bearer: DAEMON });
  assert.equal(read.status, 200, read.text);
  assert.equal(read.json.hostSignIn!.kept, false);
  assert.equal((await call('POST', `${HOST}/login`, { bearer: DAEMON, body: {} })).status, 403);
  assert.equal((await call('POST', `${HOST}/token`, { bearer: DAEMON, body: {} })).status, 403);
});

test('a backend that cannot keep the host sign-in answers 404, and a body is checked', async () => {
  assert.equal((await call('GET', '/api/backends/host-sign-in/ollama-cloud', { cookie: admin })).status, 404);
  assert.equal((await call('GET', '/api/backends/host-sign-in/..%2Fclaude', { cookie: admin })).status, 404);
  assert.equal((await call('POST', `${HOST}/login`, { cookie: admin, body: { dir: '/tmp' } })).status, 400);
});

test('signed in from the browser: the sign-in lands in Timon\'s folder and the base profile launches on it', async () => {
  const view = await call('GET', HOST, { cookie: admin });
  assert.deepEqual({ ...view.json.hostSignIn, signedIn: undefined }, { backend: 'claude', kept: false, identity: null, browser: true, token: { stored: false }, tokenOnly: false, signedIn: undefined });

  assert.equal((await call('POST', `${HOST}/login`, { cookie: admin, body: {} })).status, 202);
  const waiting = await until(`${HOST}/login`, admin, (l) => l.state !== 'starting');
  assert.deepEqual(waiting.prompt, { kind: 'paste-code', url: AUTHORIZE });
  // Another session, even the operator's own, does not see the flow.
  const other = await login('admin@example.com', 'admin-secret');
  assert.equal((await call('GET', `${HOST}/login`, { cookie: other })).status, 404);
  assert.equal((await call('POST', `${HOST}/login/code`, { cookie: other, body: { code: CODE } })).status, 404);

  // Known signed out until now: the success must not wait for a check to say otherwise.
  setProviderSignInForTest('claude', false);
  const sent = await call('POST', `${HOST}/login/code`, { cookie: admin, body: { code: CODE } });
  assert.equal(sent.status, 200, sent.text);
  const done = await until(`${HOST}/login`, admin, over);
  assert.equal(done.state, 'connected', JSON.stringify(done));
  assert.equal(done.identity, EMAIL);
  assert.equal(providerSignedIn('claude'), true, 'usable as soon as the flow says connected');

  const dir = hostSignInDir('claude');
  assert.ok(existsSync(join(dir, '.credentials.json')), 'the credential moved into Timon\'s folder');
  const kept = (await call('GET', HOST, { cookie: admin })).json.hostSignIn!;
  assert.equal(kept.kept, true);
  assert.equal(kept.signedIn, true, 'the screens read it signed in, so none offers to sign in again');
  assert.equal(kept.identity, EMAIL);
  assert.equal(credentialAccountOf('claude'), 'hostclaude');
  assert.equal(credentialAccountOf('kimi'), null);
  const status = await providerAuthStatus('claude');
  assert.equal(status?.ok, true);

  const base = activeProfiles().find((entry) => entry.profile.id === 'claude' && !entry.account)!;
  const { runtime } = await base.runtimeFor();
  assert.deepEqual((runtime as { account?: unknown }).account, { id: 'hostclaude', name: base.profile.label, configDir: dir });
  // Still no account row: it is in no rotation and no selector.
  assert.ok(!activeProfiles().some((entry) => entry.profile.id === 'claude@hostclaude'));

  for (const text of [...replies, ...logged]) assert.ok(!text.includes(CODE), 'the pasted code came back or was logged');
});

test('the fence and the keychain move name the kept sign-in as they name an account', async () => {
  const { missionFenceTarget } = await import('../../agent.js');
  const target = missionFenceTarget({ missionId: 'mission-fence', agentName: 'main', project: '', backend: 'claude', cwd: null, mcpServers: [] });
  assert.equal(target.account, 'hostclaude');
  const { accountCredentialHold, prepareMissionLaunch, recordOneShotProcess } = await import('../../mission-fence-state.js');
  // A one-shot on the base profile runs outside the fence and may renew the kept sign-in: nothing moves meanwhile.
  const oneShot = new EventEmitter();
  recordOneShotProcess('mission-summary', 'claude', oneShot);
  const release = prepareMissionLaunch('mission-fenced', { account: 'hostclaude', fenced: true });
  assert.equal(accountCredentialHold('hostclaude', 'mission-fenced'), 'in-use');
  oneShot.emit('close');
  assert.equal(accountCredentialHold('hostclaude', 'mission-fenced'), null);
  release();
});

test('a long-lived token is minted in a pseudo-terminal and goes to the provider\'s store, nowhere else', async () => {
  ptyAnswer = 'token';
  setProviderSignInForTest('claude', false);
  const started = await call('POST', `${HOST}/token`, { cookie: admin, body: {} });
  assert.equal(started.status, 202, started.text);
  const waiting = await until(`${HOST}/token`, admin, (l) => l.state !== 'starting');
  assert.deepEqual(waiting.prompt, { kind: 'paste-code', url: AUTHORIZE });
  assert.equal((await call('POST', `${HOST}/token/code`, { cookie: admin, body: { code: `  ${TOKEN_CODE}  ` } })).status, 200);
  const done = await until(`${HOST}/token`, admin, over);
  assert.equal(done.state, 'connected', JSON.stringify(done));
  assert.equal(providerSignedIn('claude'), true, 'a minted token makes claude usable at once');

  const run = ptyRuns.at(-1)!;
  assert.deepEqual(run.args, ['setup-token']);
  assert.deepEqual(run.typed, [`${TOKEN_CODE}\r`]);
  assert.equal(run.env.CLAUDE_CODE_OAUTH_TOKEN, '');
  assert.ok(run.killed, 'the pseudo-terminal is closed once the token is read');
  assert.ok(!existsSync(run.env.CLAUDE_CONFIG_DIR!), 'the throwaway folder is gone');
  assert.equal((await call('GET', HOST, { cookie: admin })).json.hostSignIn!.token!.stored, true);

  for (const text of [...replies, ...logged]) {
    assert.ok(!text.includes(LONG_LIVED), 'the token came back to a browser or was logged');
    assert.ok(!text.includes(TOKEN_CODE), 'the pasted code came back or was logged');
  }
});

test('a code the CLI refuses ends the token flow as rejected', async () => {
  ptyAnswer = 'refuse';
  assert.equal((await call('POST', `${HOST}/token`, { cookie: admin, body: {} })).status, 202);
  await until(`${HOST}/token`, admin, (l) => l.state !== 'starting');
  assert.equal((await call('POST', `${HOST}/token/code`, { cookie: admin, body: { code: TOKEN_CODE } })).status, 200);
  const done = await until(`${HOST}/token`, admin, over);
  assert.equal(done.failure, 'code_rejected');
  assert.equal((await call('POST', `${HOST}/token/code`, { cookie: admin, body: { code: 'two\nlines' } })).status, 400);
});

// #1211: the pseudo-terminal starts a Node CLI with the `node` the host chose, as a mission does.
test('the token\'s pseudo-terminal runs a Node CLI on the node the host chose, not on its shebang', { skip: process.platform === 'win32' }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'timon-token-node-'));
  const [cliDir, nodeDir] = ['cli', 'node'].map((name) => join(root, name));
  for (const dir of [cliDir!, nodeDir!]) mkdirSync(dir);
  const claude = join(cliDir!, 'claude');
  const node = join(nodeDir!, 'node');
  writeFileSync(claude, '#!/usr/bin/env node\n', { mode: 0o755 });
  writeFileSync(node, '', { mode: 0o755 });
  setLoginOptions({ resolveBin: (name) => name === 'claude' ? claude : name === 'node' ? node : null });
  try {
    ptyAnswer = 'token';
    assert.equal((await call('POST', `${HOST}/token`, { cookie: admin, body: {} })).status, 202);
    await until(`${HOST}/token`, admin, (l) => l.state !== 'starting');
    const run = ptyRuns.at(-1)!;
    assert.equal(run.file, node);
    assert.deepEqual(run.args, [claude, 'setup-token']);
    assert.equal((await call('DELETE', `${HOST}/token`, { cookie: admin })).status, 200);
  } finally {
    setLoginOptions({ resolveBin: () => null });
    rmSync(root, { recursive: true, force: true });
  }
});

test('without a pseudo-terminal on the host, the token flow says it is unsupported', async () => {
  setTokenPtySpawn(() => { throw new Error('pty_unavailable'); });
  const started = await call('POST', `${HOST}/token`, { cookie: admin, body: {} });
  assert.equal(started.status, 202);
  assert.equal(started.json.login!.failure, 'unsupported');
});

test('back to the terminal\'s session: Timon\'s folder goes, the base profile runs on the CLI\'s own again', async () => {
  const res = await call('DELETE', HOST, { cookie: admin });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.hostSignIn!.kept, false);
  assert.ok(!existsSync(hostSignInDir('claude')));
  assert.equal(credentialAccountOf('claude'), null);
  const base = activeProfiles().find((entry) => entry.profile.id === 'claude' && !entry.account)!;
  const { runtime } = await base.runtimeFor();
  assert.equal((runtime as { account?: unknown }).account, undefined);

  // No kept sign-in and no terminal session any more: the minted token alone keeps claude
  // signed in, for a person's explicit check too, not only for the verdict the flow recorded.
  const empty = mkdtempSync(join(tmpdir(), 'timon-no-session-'));
  setSignInEnv(() => ({ CLAUDE_CONFIG_DIR: empty, HOME: empty }));
  try {
    assert.equal(await refreshProviderSignIn('claude', true), true);
    assert.equal(providerSignedIn('claude'), true);
  } finally {
    resetProviderSignInForTest();
  }
});

test('a macOS service outside the user\'s session offers the token alone, and refuses the sign-in it could not read', async () => {
  setLoginOptions({ platform: 'darwin', outsideSession: () => true });
  try {
    const view = (await call('GET', HOST, { cookie: admin })).json.hostSignIn!;
    assert.equal(view.tokenOnly, true);
    assert.equal(view.browser, false, 'no sign-in from the browser: its keychain entry is out of the service\'s reach');
    assert.ok(view.token, 'the long-lived token stays on offer');
    const refused = await call('POST', `${HOST}/login`, { cookie: admin, body: {} });
    assert.equal(refused.status, 400, refused.text);
    assert.match(refused.text, /long-lived token/);
  } finally {
    setLoginOptions({ platform: 'linux', outsideSession: () => false });
  }
  // The same service on Linux, or a LaunchAgent in the session: the sign-in is offered again.
  setLoginOptions({ platform: 'linux', outsideSession: () => true });
  try {
    const view = (await call('GET', HOST, { cookie: admin })).json.hostSignIn!;
    assert.equal(view.tokenOnly, false);
    assert.equal(view.browser, true);
  } finally {
    setLoginOptions({ outsideSession: () => false });
  }
});
