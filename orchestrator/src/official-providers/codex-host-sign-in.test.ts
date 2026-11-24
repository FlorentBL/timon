/**
 * The host's own Codex sign-in kept by Timon (TODO #1137), through the real registry: the provider
 * declares it (`accounts.host`), the browser flow plays `codex login --device-auth` into Timon's
 * folder, and a launch of the base profile then runs on that folder's `auth.json` instead of the
 * terminal's `~/.codex` one. Without it, the terminal's session stays what missions run on. The CLI
 * is a fake driven by the test: no real `codex` runs.
 */
import '../test-home.js';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { getHost } from '../host/index.js';
import { TIMON_HOME } from '../paths.js';
import type { ProfileRuntime } from '../backends/types.js';

process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';
const { mountOfficialProviders, buildDialectUnderSeal } = await import('../../tests/helpers/official-providers.js');
await mountOfficialProviders();
const { hostSignInSupport, startHostLogin, getHostLogin, cancelHostLogin, forgetHostLogin, setLoginOptions, resetAccountLogins } = await import('../backends/account-login.js');
const { hostSignInView } = await import('../backends/host-sign-in-view.js');
const { getHostSignIn, hostSignInDir, hostSignInId, recordHostSignIn, resetHostSignIns, credentialAccountOf } = await import('../backends/host-sign-in.js');
const { providerAuthStatus, activeProfiles } = await import('../backends/registry.js');
const { codexLoginDriver } = await import('../../official-providers/provider-codex/lib/login.js');

const DEVICE_URL = 'https://auth.openai.com/codex/device';
const DEVICE_CODE = 'AB12-CD34';
const EMAIL = 'host@perso.example';

/** An `auth.json` as `codex login` writes it: the identity lives in the id token's claims. */
function authJson(email = EMAIL): string {
  const claims = { email, sub: 'user-sub', 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-host', chatgpt_user_id: 'user-host' } };
  const idToken = `e30.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`;
  return JSON.stringify({ tokens: { id_token: idToken, access_token: 'host-access', refresh_token: 'host-refresh', account_id: 'acct-host' } });
}

class FakeCli extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  pid = 4242;
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

/** What the fake CLI was started with, and the hook that ends its polling as the person would. */
type Run = { args: string[]; env: NodeJS.ProcessEnv; approve: () => void };
const runs: Run[] = [];
setLoginOptions({
  spawn: (_cmd, args, opts) => {
    const cli = new FakeCli();
    const env = opts.env as NodeJS.ProcessEnv;
    runs.push({
      args, env,
      approve: () => {
        writeFileSync(join(env.CODEX_HOME!, 'auth.json'), authJson());
        cli.exit(0);
      },
    });
    setImmediate(() => cli.stdout.write(`Follow these steps to sign in:\n1. Open ${DEVICE_URL}\n2. Enter this one-time code ${DEVICE_CODE}\n`));
    return cli as unknown as ChildProcess;
  },
  platform: 'linux', promptTimeoutMs: 5_000, retainMs: 60_000, resolveBin: () => null,
});

const who = { userId: 'operator', binding: 'session-hash' };

function isolate(t: TestContext): string {
  const before = { ...process.env };
  const terminal = join(TIMON_HOME, randomUUID());
  process.env.CODEX_AUTH_DIR = terminal;
  t.mock.method(getHost(), 'execAsync', () => { throw new Error('unexpected CLI check'); });
  t.mock.method(globalThis, 'fetch', () => { throw new Error('unexpected network'); });
  t.after(async () => {
    resetAccountLogins();
    await forgetHostLogin('codex');
    resetHostSignIns();
    process.env = before;
  });
  return terminal;
}

async function until(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const opts = (missionId = randomUUID()) => ({ agentName: 'main', missionId,
  cfg: { cwd: TIMON_HOME, browser_profile_id: null }, systemPrompt: 'Test', message: 'Test', resumeSession: null });

/** The base profile `codex`, as the registry hands it to a launch: with the kept sign-in as its account when there is one. */
function baseProfile(): ProfileRuntime {
  return getHostSignIn('codex')
    ? { id: 'codex', cmd: 'codex', env: {}, account: { id: hostSignInId('codex'), name: 'Codex', configDir: hostSignInDir('codex') } }
    : { id: 'codex', cmd: 'codex', env: {} };
}

test('the Codex provider lets Timon keep the host sign-in, signed in from the browser, with no token to mint', () => {
  assert.deepEqual(hostSignInSupport('codex'), { browser: true, token: false, tokenOnly: false });
  assert.equal(hostSignInView('codex')?.token, null);
});

test('the browser flow signs Codex in into Timon\'s folder, never into ~/.codex, and says who', async (t) => {
  const terminal = isolate(t);
  const started = startHostLogin('codex', who);
  assert.equal(started.backend, 'codex');
  await until(() => getHostLogin('codex', who)?.state === 'waiting', 'the device code');
  assert.deepEqual(getHostLogin('codex', who)?.prompt, { kind: 'device-code', url: DEVICE_URL, code: DEVICE_CODE });
  const run = runs.at(-1)!;
  // File storage and no inherited key: the missions link a file, and nothing stands in for the sign-in.
  assert.deepEqual(run.args, ['login', '--device-auth', '-c', 'cli_auth_credentials_store=file']);
  assert.equal(run.env.OPENAI_API_KEY, '');
  assert.equal(run.env.CODEX_API_KEY, '');
  assert.notEqual(run.env.CODEX_HOME, terminal);

  run.approve();
  await until(() => getHostLogin('codex', who)?.state === 'connected', 'the sign-in');
  assert.equal(getHostLogin('codex', who)?.identity, EMAIL);
  assert.equal(readFileSync(join(hostSignInDir('codex'), 'auth.json'), 'utf8'), authJson());
  assert.equal(existsSync(join(terminal, 'auth.json')), false, 'the terminal\'s folder is never written');
  assert.equal(getHostSignIn('codex')?.identityLabel, EMAIL);
  assert.equal(credentialAccountOf('codex'), hostSignInId('codex'));
  const view = hostSignInView('codex');
  assert.equal(view?.kept, true);
  assert.equal(view?.identity, EMAIL);
});

test('end to end: after a browser sign-in, a base-profile mission from the registry runs on the kept auth.json', async (t) => {
  const terminal = isolate(t);
  startHostLogin('codex', who);
  await until(() => getHostLogin('codex', who)?.state === 'waiting', 'the device code');
  runs.at(-1)!.approve();
  await until(() => getHostLogin('codex', who)?.state === 'connected', 'the sign-in');

  // The runtime the dispatcher would get: the registry's base profile, not one built by the test.
  const base = activeProfiles().find((entry) => entry.profile.id === 'codex' && !entry.account);
  assert.ok(base, 'the base codex profile is active');
  const { runtime } = await base.runtimeFor();
  assert.equal(runtime.account?.configDir, hostSignInDir('codex'));
  // The kept folder is open to the provider's scratch link: no ScratchPathError, the mission reads the kept file.
  const spec = await buildDialectUnderSeal('codex', 'codex', runtime, opts());
  assert.equal(readFileSync(join(spec.env!.CODEX_HOME!, 'auth.json'), 'utf8'), authJson());
  assert.notEqual(spec.env!.CODEX_HOME, terminal);
});

test('a cancelled flow keeps nothing', async (t) => {
  isolate(t);
  startHostLogin('codex', who);
  await until(() => getHostLogin('codex', who)?.state === 'waiting', 'the device code');
  assert.equal(cancelHostLogin('codex', who)?.failure, 'cancelled');
  assert.equal(getHostSignIn('codex'), undefined);
  assert.equal(existsSync(join(hostSignInDir('codex'), 'auth.json')), false);
});

test('kept by Timon: a mission links the kept auth.json, and the provider counts as signed in without ~/.codex', async (t) => {
  const terminal = isolate(t);
  mkdirSync(terminal, { recursive: true });
  writeFileSync(join(terminal, 'auth.json'), '{"terminal":true}');
  mkdirSync(hostSignInDir('codex'), { recursive: true });
  writeFileSync(join(hostSignInDir('codex'), 'auth.json'), authJson());
  recordHostSignIn('codex', { key: 'k', label: EMAIL });
  process.env.CODEX_API_KEY = 'inherited-key';

  const spec = await buildDialectUnderSeal('codex', 'codex', baseProfile(), opts());
  assert.equal(readFileSync(join(spec.env!.CODEX_HOME!, 'auth.json'), 'utf8'), authJson());
  assert.equal(spec.env?.CODEX_API_KEY, '', 'an inherited key never overrides the kept sign-in');

  // The terminal's session gone: only Timon's kept sign-in can answer the check.
  rmSync(terminal, { recursive: true, force: true });
  const status = await providerAuthStatus('codex');
  assert.equal(status?.ok, true);
  assert.equal(status?.signInCommand, null);
});

test('the terminal\'s session: a mission links ~/.codex as before, and going back to it removes Timon\'s folder', async (t) => {
  const terminal = isolate(t);
  mkdirSync(terminal, { recursive: true });
  writeFileSync(join(terminal, 'auth.json'), '{"terminal":true}');
  mkdirSync(hostSignInDir('codex'), { recursive: true });
  writeFileSync(join(hostSignInDir('codex'), 'auth.json'), authJson());
  recordHostSignIn('codex', { key: 'k', label: EMAIL });
  const missionId = randomUUID();
  const kept = await buildDialectUnderSeal('codex', 'codex', baseProfile(), opts(missionId));
  assert.equal(readFileSync(join(kept.env!.CODEX_HOME!, 'auth.json'), 'utf8'), authJson());

  assert.equal(await forgetHostLogin('codex'), true);
  assert.equal(existsSync(hostSignInDir('codex')), false);
  assert.equal(credentialAccountOf('codex'), null);
  // The same mission's next turn moves back to the terminal's sign-in.
  const back = await buildDialectUnderSeal('codex', 'codex', baseProfile(), opts(missionId));
  assert.equal(readFileSync(join(back.env!.CODEX_HOME!, 'auth.json'), 'utf8'), '{"terminal":true}');
});

test('a kept sign-in whose file went missing refuses the launch and says where to sign in again', async (t) => {
  isolate(t);
  recordHostSignIn('codex', { key: 'k', label: EMAIL });
  await assert.rejects(buildDialectUnderSeal('codex', 'codex', baseProfile(), opts()), /Codex sign-in kept by Timon is missing/);
});

test('the driver reads who signed in from the id token, and nothing from a file without one', async () => {
  const dir = join(TIMON_HOME, randomUUID());
  mkdirSync(dir, { recursive: true });
  assert.equal(await codexLoginDriver.identity(dir), null);
  writeFileSync(join(dir, 'auth.json'), authJson('other@perso.example'));
  assert.equal((await codexLoginDriver.identity(dir))?.label, 'other@perso.example');
  writeFileSync(join(dir, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'sk-not-a-sign-in' }));
  assert.equal(await codexLoginDriver.identity(dir), null);
});
