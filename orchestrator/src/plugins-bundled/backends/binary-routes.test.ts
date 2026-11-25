/**
 * `/api/host/binaries` — pinning a backend CLI from Settings (TODO #413).
 *
 * Refusals first: the pinned path is the program every mission of a backend
 * executes. Then the promise of the feature: the file is rewritten without
 * losing anything, and the RUNNING daemon — host adapter included — uses the
 * new path at once. Isolated TIMON_HOME, witness on 127.0.0.1:0.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { grantTestPermissions, postTestAccount } from '../../../tests/helpers/accounts.js';

const HOME = mkdtempSync(join(tmpdir(), 'timon-binary-pins-'));
process.env.TIMON_HOME = HOME;
await import('../../../tests/helpers/paid-license.js');
process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';

const { createDaemonAuthMiddleware } = await import('../http/auth.js');
const { registerRoutes: registerUserRoutes } = await import('../users/routes.js');
const { registerBinaryRoutes, sendBinaryRouteError } = await import('./binary-routes.js');
const { dbApi } = await import('../../db.js');
const { SESSION_COOKIE } = await import('../../users/session.js');
const { issueMissionApiToken } = await import('../../users/api-tokens.js');
const { issuePairingCode, redeemPairingCode } = await import('../../users/devices.js');
const { CONFIG_FILE, config } = await import('../../config/load.js');
const { checkBackendBinaries } = await import('../../backends/binary-check.js');
const { assertExecutablePin, normalizePinPath, runnableOnWindows } = await import('../../backends/binary-pins.js');
const { getHost } = await import('../../host/index.js');
{
  const { mountOfficialProviders } = await import('../../../tests/helpers/official-providers.js');
  await mountOfficialProviders();
}

const TOKEN = 'witness-daemon-token';
const app = express();
app.use(createDaemonAuthMiddleware({ token: TOKEN, required: true }));
app.use(express.json());
registerUserRoutes(app, { setupPolicy: 'free' });
registerBinaryRoutes(app);
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
test.after(() => { server.close(); });

function sessionCookie(res: Response): string | undefined {
  const lines = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  for (const line of lines) {
    const match = new RegExp(`(?:^|,\\s*)${SESSION_COOKIE}=([^;]+)`).exec(line);
    if (match?.[1]) return decodeURIComponent(match[1]);
  }
  return undefined;
}

async function call(method: string, path: string, opts: { body?: unknown; cookie?: string; bearer?: string } = {}) {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (opts.cookie) headers.cookie = `${SESSION_COOKIE}=${encodeURIComponent(opts.cookie)}`;
  if (opts.bearer) headers.authorization = `Bearer ${opts.bearer}`;
  const res = await fetch(`${base}${path}`, { method, headers, ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }) });
  const text = await res.text();
  let json: unknown = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, json, text };
}

const setup = await call('POST', '/api/auth/setup', { body: { email: 'admin@example.com', name: 'Admin', password: 'admin-secret' } });
assert.equal(setup.status, 201);
const adminCookie = sessionCookie((await fetch(`${base}/api/auth/login`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'admin@example.com', password: 'admin-secret' }),
})))!;
const created = await postTestAccount(dbApi, { email: 'ada@example.com', name: 'Ada', password: 'ada-secret' });
const adaId = (created.json as { user: { id: string } }).user.id;
const adaCookie = sessionCookie((await fetch(`${base}/api/auth/login`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'ada@example.com', password: 'ada-secret' }),
})))!;
assert.ok(adminCookie && adaCookie);
const admin = dbApi.listUsers().find((u) => u.email === 'admin@example.com')!;
dbApi.createMission('mission-binary-pins', 'admin.agent', 'work', undefined, admin.id);
const missionToken = issueMissionApiToken('mission-binary-pins');
assert.ok(adaId);
// The superadmin's own paired machine: it acts with the owner's rights, but it is not the person.
const paired = redeemPairingCode({ code: issuePairingCode(admin.id).code, name: 'laptop', ip: null, userAgent: null });
assert.equal(paired.kind, 'ok');
const deviceToken = paired.kind === 'ok' ? paired.token : '';

// What a configured install looks like: a file the person wrote, four-space
// indent, keys this feature must not touch.
const ORIGINAL = { version: 1, edition: 'expert', daemon: { listen: { port: 3999 } }, host: { gui: 'disabled' }, modules: { '@timon/video-factory': false } };
writeFileSync(CONFIG_FILE, `${JSON.stringify(ORIGINAL, null, 4)}\n`);

const CMD = checkBackendBinaries()[0]!.cmd;
// Beside the Timon home, not in it: no binary is ever resolved from there.
const BIN_DIR = join(`${HOME}-pins`, 'bin dir');
mkdirSync(BIN_DIR, { recursive: true });
// Windows runs a program by its extension: the witness there is a batch file.
const RUNNABLE = process.platform === 'win32' ? '.cmd' : '';
const SCRIPT = process.platform === 'win32' ? '@exit /b 0\r\n' : '#!/bin/sh\nexit 0\n';
/** Runnable on Linux, refused on Windows for want of an extension. */
const POSIX_EXECUTABLE = join(BIN_DIR, CMD);
writeFileSync(POSIX_EXECUTABLE, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
const EXECUTABLE = join(BIN_DIR, `${CMD}${RUNNABLE}`);
writeFileSync(EXECUTABLE, SCRIPT, { mode: 0o755 });
const NOT_EXECUTABLE = join(BIN_DIR, `${CMD}-plain`);
writeFileSync(NOT_EXECUTABLE, 'not a program\n', { mode: 0o644 });
chmodSync(NOT_EXECUTABLE, 0o644);

const ROUTES: [string, string, unknown?][] = [
  ['GET', '/api/host/binaries'],
  ['POST', '/api/host/binaries/recheck'],
  ['PUT', `/api/host/binaries/${CMD}`, { path: EXECUTABLE }],
  ['DELETE', `/api/host/binaries/${CMD}`],
];

function fileNow(): Record<string, unknown> {
  return JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) as Record<string, unknown>;
}

test('anonymous: 401 on every route, and the file is untouched', async () => {
  const before = readFileSync(CONFIG_FILE, 'utf8');
  for (const [method, path, body] of ROUTES) {
    assert.equal((await call(method, path, { body })).status, 401, `${method} ${path}`);
  }
  assert.equal(readFileSync(CONFIG_FILE, 'utf8'), before);
});

test('daemon token, mission token, non-superadmin session: 403, nothing written', async () => {
  const before = readFileSync(CONFIG_FILE, 'utf8');
  for (const [method, path, body] of ROUTES) {
    assert.equal((await call(method, path, { body, bearer: TOKEN })).status, 403, `daemon token ${method} ${path}`);
    assert.equal((await call(method, path, { body, bearer: missionToken })).status, 403, `mission token ${method} ${path}`);
    assert.equal((await call(method, path, { body, cookie: adaCookie })).status, 403, `session ${method} ${path}`);
  }
  assert.equal(readFileSync(CONFIG_FILE, 'utf8'), before);
  assert.equal(config().host.binaries[CMD], undefined);
});

/**
 * A pin is the program the daemon runs at every mission, and the PUT runs it once to check it: a setting of
 * the host. `providers:manage` opens the Providers screen and the list of programs, not this.
 */
test('pinning and unpinning: a superadmin in a session only — not providers:manage, not a paired device', async () => {
  grantTestPermissions(dbApi, adaId, ['providers:manage']);
  try {
    const before = readFileSync(CONFIG_FILE, 'utf8');
    for (const [method, path, body] of ROUTES) {
      const manager = await call(method, path, { body, cookie: adaCookie });
      const device = await call(method, path, { body, bearer: deviceToken });
      if (method === 'PUT' || method === 'DELETE') {
        assert.equal(manager.status, 403, `providers:manage ${method} ${path}: ${manager.text}`);
        assert.equal(device.status, 403, `device ${method} ${path}: ${device.text}`);
      } else {
        assert.equal(manager.status, 200, `providers:manage still reads: ${method} ${path}`);
        assert.equal(device.status, 200, `the superadmin's device still reads: ${method} ${path}`);
      }
    }
    assert.equal(readFileSync(CONFIG_FILE, 'utf8'), before);
    assert.equal(config().host.binaries[CMD], undefined);
  } finally {
    grantTestPermissions(dbApi, adaId, []);
  }
});

test('refusals: unknown name, relative, missing, folder, not executable — none echoes the input', async () => {
  const cases: [string, unknown, number, string][] = [
    ['node', { path: process.execPath }, 404, 'unknown_binary'],
    ['__proto__', { path: EXECUTABLE }, 404, 'unknown_binary'],
    [CMD, { path: `bin/${CMD}` }, 400, 'path_not_absolute'],
    [CMD, { path: join(HOME, 'nowhere-secret-name', CMD) }, 400, 'path_missing'],
    [CMD, { path: BIN_DIR }, 400, 'path_not_file'],
    [CMD, { path: EXECUTABLE, extra: true }, 400, 'invalid_body'],
    [CMD, {}, 400, 'invalid_body'],
  ];
  if (process.platform !== 'win32') cases.push([CMD, { path: NOT_EXECUTABLE }, 400, 'path_not_executable']);
  const before = readFileSync(CONFIG_FILE, 'utf8');
  for (const [name, body, status, code] of cases) {
    const out = await call('PUT', `/api/host/binaries/${encodeURIComponent(name)}`, { cookie: adminCookie, body });
    assert.equal(out.status, status, `${name} ${JSON.stringify(body)}: ${out.text}`);
    assert.equal((out.json as { error: string }).error, code);
    assert.doesNotMatch(out.text, /nowhere-secret-name/);
  }
  assert.equal(readFileSync(CONFIG_FILE, 'utf8'), before);
});

test('PUT: the file keeps every other key and its indent, and the running daemon uses the pin at once', async () => {
  // The adapter exists BEFORE the pin, as in a running daemon: it must not
  // keep the paths it was built with.
  const host = getHost();
  const out = await call('PUT', `/api/host/binaries/${CMD}`, { cookie: adminCookie, body: { path: `  "${EXECUTABLE}"  ` } });
  assert.equal(out.status, 200, out.text);

  const raw = readFileSync(CONFIG_FILE, 'utf8');
  assert.match(raw, /^ {4}"version": 1,$/m, 'four-space indent kept');
  const written = fileNow();
  assert.deepEqual(written, { ...ORIGINAL, host: { gui: 'disabled', binaries: { [CMD]: EXECUTABLE } } });
  assert.deepEqual(readdirSync(HOME).filter((f) => f.endsWith('.tmp')), [], 'no temporary file left');

  assert.equal(config().host.binaries[CMD], EXECUTABLE);
  const status = checkBackendBinaries().find((s) => s.cmd === CMD)!;
  assert.deepEqual([status.path, status.pinned], [EXECUTABLE, true]);
  assert.equal(host.bin(CMD), EXECUTABLE, 'the host adapter resolves the new pin without a restart');

  const listed = (out.json as { binaries: { cmd: string; pin: string | null; path: string | null }[] }).binaries.find((b) => b.cmd === CMD)!;
  assert.deepEqual([listed.pin, listed.path], [EXECUTABLE, EXECUTABLE]);
});

test('recheck re-reads a hand edit without writing', async () => {
  const other = join(BIN_DIR, `${CMD}-other${RUNNABLE}`);
  writeFileSync(other, SCRIPT, { mode: 0o755 });
  const edited = { ...fileNow(), host: { gui: 'disabled', binaries: { [CMD]: other } } };
  writeFileSync(CONFIG_FILE, `${JSON.stringify(edited, null, 4)}\n`);
  const before = readFileSync(CONFIG_FILE, 'utf8');

  const out = await call('POST', '/api/host/binaries/recheck', { cookie: adminCookie });
  assert.equal(out.status, 200, out.text);
  assert.equal((out.json as { configError: string | null }).configError, null);
  assert.equal(config().host.binaries[CMD], other);
  assert.equal(getHost().bin(CMD), other);
  assert.equal(readFileSync(CONFIG_FILE, 'utf8'), before, 'recheck writes nothing');

  // A broken file leaves the live pins alone and says so.
  writeFileSync(CONFIG_FILE, '{ not json');
  const broken = await call('POST', '/api/host/binaries/recheck', { cookie: adminCookie });
  assert.equal(broken.status, 200);
  assert.equal((broken.json as { configError: string | null }).configError, 'config_unreadable');
  assert.equal(config().host.binaries[CMD], other);
  const refused = await call('PUT', `/api/host/binaries/${CMD}`, { cookie: adminCookie, body: { path: EXECUTABLE } });
  assert.equal(refused.status, 409, 'an unreadable file is never overwritten');
  assert.equal(readFileSync(CONFIG_FILE, 'utf8'), '{ not json');
  writeFileSync(CONFIG_FILE, before);
});

test('DELETE removes the key and goes back to detection', async () => {
  await call('POST', '/api/host/binaries/recheck', { cookie: adminCookie });
  const out = await call('DELETE', `/api/host/binaries/${CMD}`, { cookie: adminCookie });
  assert.equal(out.status, 200, out.text);
  assert.deepEqual(fileNow(), ORIGINAL, 'the file is back to what the person wrote');
  assert.equal(CMD in config().host.binaries, false);
  assert.equal(checkBackendBinaries().find((s) => s.cmd === CMD)!.pinned, false);
});

test('no config file yet: the pin is refused rather than ending the first run', async () => {
  const saved = readFileSync(CONFIG_FILE, 'utf8');
  const { rmSync } = await import('node:fs');
  rmSync(CONFIG_FILE);
  try {
    const out = await call('PUT', `/api/host/binaries/${CMD}`, { cookie: adminCookie, body: { path: EXECUTABLE } });
    assert.equal(out.status, 409);
    assert.equal((out.json as { error: string }).error, 'no_config');
    assert.equal(existsSync(CONFIG_FILE), false);
  } finally {
    writeFileSync(CONFIG_FILE, saved);
  }
});

/**
 * #1101: a tester pinned `/usr/local/bin/ollama` for Ollama Cloud, which runs on the Codex CLI, and every
 * mission ran `ollama exec …`. The Codex provider declares how its CLI describes itself: the pin asks first.
 */
// Windows starts only a `.exe` or a known npm shim to check it, and these stubs are batch files: the format
// itself is tested in `binary-identity.test.ts`.
test('a pin on another program is refused, naming the CLI expected; the right one is saved', { skip: process.platform === 'win32' }, async () => {
  const stubOf = (name: string, line: string): string => {
    const file = join(BIN_DIR, `${name}${RUNNABLE}`);
    writeFileSync(file, process.platform === 'win32' ? `@echo ${line}\r\n` : `#!/bin/sh\necho "${line}"\n`, { mode: 0o755 });
    return file;
  };
  const ollama = stubOf('ollama', 'ollama version is 0.16.2');
  const codex = stubOf('codex', 'codex-cli 0.169.0');
  const before = readFileSync(CONFIG_FILE, 'utf8');

  const wrong = await call('PUT', '/api/host/binaries/codex', { cookie: adminCookie, body: { path: ollama } });
  assert.equal(wrong.status, 400, wrong.text);
  assert.deepEqual(wrong.json, { error: 'wrong_program', message: 'This file is not the Codex CLI: its `--version` answer does not match.' });
  assert.equal(readFileSync(CONFIG_FILE, 'utf8'), before, 'nothing written');
  assert.equal(config().host.binaries.codex, undefined);

  // The right version, then a failure: the identity is read only from a run that succeeded.
  const failing = join(BIN_DIR, `codex-failing${RUNNABLE}`);
  writeFileSync(failing, process.platform === 'win32' ? '@echo codex-cli 0.169.0\r\n@exit /b 1\r\n' : '#!/bin/sh\necho "codex-cli 0.169.0"\nexit 1\n', { mode: 0o755 });
  const failed = await call('PUT', '/api/host/binaries/codex', { cookie: adminCookie, body: { path: failing } });
  assert.equal(failed.status, 400, failed.text);
  assert.equal((failed.json as { error: string }).error, 'no_answer');
  assert.equal(readFileSync(CONFIG_FILE, 'utf8'), before, 'nothing written');

  const right = await call('PUT', '/api/host/binaries/codex', { cookie: adminCookie, body: { path: codex } });
  assert.equal(right.status, 200, right.text);
  assert.equal(config().host.binaries.codex, codex);
  assert.equal((await call('DELETE', '/api/host/binaries/codex', { cookie: adminCookie })).status, 200);
  assert.equal(readFileSync(CONFIG_FILE, 'utf8'), before);
});

/**
 * A file-system failure names its file in full, and the home folder with it: neither the answer nor the log
 * carries it. One test per branch: the config write, the probe's folder, its removal, the unexpected error.
 */
async function capturingLogs<T>(run: () => Promise<T>): Promise<{ out: T; logs: string }> {
  const lines: string[] = [];
  const saved = { warn: console.warn, log: console.log, error: console.error };
  const keep = (...args: unknown[]): void => { lines.push(args.map(String).join(' ')); };
  console.warn = keep;
  console.log = keep;
  console.error = keep;
  try {
    return { out: await run(), logs: lines.join('\n') };
  } finally {
    Object.assign(console, saved);
  }
}

function assertNoPath(text: string, ...paths: string[]): void {
  for (const path of [HOME, `${HOME}-pins`, tmpdir(), ...paths]) {
    assert.equal(text.includes(path), false, `${JSON.stringify(path)} leaked in ${text}`);
  }
}

// chmod does not refuse root, and Windows has no mode bits to refuse a write with.
const CANNOT_REFUSE_WRITES = process.platform === 'win32' || process.getuid?.() === 0;

test('a config file the daemon cannot write: pin_write_failed, the errno alone in the log', { skip: CANNOT_REFUSE_WRITES }, async () => {
  const before = readFileSync(CONFIG_FILE, 'utf8');
  // The temporary file is written beside the config: a folder that refuses new entries fails `writeFileSync`.
  chmodSync(HOME, 0o555);
  let res: Awaited<ReturnType<typeof call>>;
  let logs: string;
  try {
    ({ out: res, logs } = await capturingLogs(() => call('PUT', `/api/host/binaries/${CMD}`, { cookie: adminCookie, body: { path: EXECUTABLE } })));
  } finally {
    chmodSync(HOME, 0o755);
  }
  assert.equal(res.status, 500, res.text);
  assert.deepEqual(res.json, {
    error: 'pin_write_failed', message: 'timon.config.json could not be written: check that the daemon may write to its folder.',
  });
  assert.match(logs, /\[backends\] binary pin: pin_write_failed \(EACCES\)/);
  assertNoPath(`${res.text}\n${logs}`, CONFIG_FILE, EXECUTABLE);
  assert.equal(readFileSync(CONFIG_FILE, 'utf8'), before, 'nothing written');
  assert.equal(config().host.binaries[CMD], undefined, 'nothing applied');
  assert.deepEqual(readdirSync(HOME).filter((f) => f.endsWith('.tmp')), [], 'no temporary file left');
});

// Windows starts only a `.exe` or a known npm shim to check it, and these stubs are shell scripts.
test('the folder the check runs in cannot be made: probe_setup_failed, the errno alone in the log', { skip: process.platform === 'win32' }, async () => {
  const before = readFileSync(CONFIG_FILE, 'utf8');
  // A file never asked before: a known answer would skip the run, and the folder with it.
  const codex = join(BIN_DIR, 'codex-setup');
  writeFileSync(codex, '#!/bin/sh\necho "codex-cli 0.169.0"\n', { mode: 0o755 });
  const missing = join(`${HOME}-pins`, 'no such temp');
  const savedTmp = process.env.TMPDIR;
  process.env.TMPDIR = missing;
  let res: Awaited<ReturnType<typeof call>>;
  let logs: string;
  try {
    ({ out: res, logs } = await capturingLogs(() => call('PUT', '/api/host/binaries/codex', { cookie: adminCookie, body: { path: codex } })));
  } finally {
    if (savedTmp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = savedTmp;
  }
  assert.equal(res.status, 500, res.text);
  assert.equal((res.json as { error: string }).error, 'probe_setup_failed');
  assert.match(logs, /\[backends\] binary pin: probe_setup_failed \(ENOENT\)/);
  assertNoPath(`${res.text}\n${logs}`, missing, codex);
  assert.equal(readFileSync(CONFIG_FILE, 'utf8'), before, 'nothing written');
});

test('a check whose folder cannot be removed still answers, and logs the errno alone', { skip: CANNOT_REFUSE_WRITES }, async () => {
  const { rmSync } = await import('node:fs');
  const temp = join(`${HOME}-pins`, 'probe temp');
  mkdirSync(temp, { recursive: true });
  // The program leaves a folder it locked: removing what is inside it is refused.
  const codex = join(BIN_DIR, 'codex-locking');
  writeFileSync(codex, '#!/bin/sh\nmkdir locked && touch locked/file && chmod 500 locked\necho "codex-cli 0.169.0"\n', { mode: 0o755 });
  const savedTmp = process.env.TMPDIR;
  process.env.TMPDIR = temp;
  let res: Awaited<ReturnType<typeof call>>;
  let logs: string;
  try {
    ({ out: res, logs } = await capturingLogs(() => call('PUT', '/api/host/binaries/codex', { cookie: adminCookie, body: { path: codex } })));
  } finally {
    if (savedTmp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = savedTmp;
    for (const left of readdirSync(temp)) chmodSync(join(temp, left, 'locked'), 0o755);
    rmSync(temp, { recursive: true, force: true });
  }
  assert.equal(res.status, 200, res.text);
  assert.equal(config().host.binaries.codex, codex);
  assert.match(logs, /\[backends\] identity check: its temporary folder could not be removed \(EACCES\)/);
  assertNoPath(logs, temp, codex);
  assert.equal((await call('DELETE', '/api/host/binaries/codex', { cookie: adminCookie })).status, 200);
});

test('an unexpected failure: a fixed answer, and the errno alone in the log', async () => {
  const leaked = join(HOME, 'secret folder', 'timon.config.json');
  const error = Object.assign(new Error(`EPERM: operation not permitted, open '${leaked}'`), { code: 'EPERM', path: leaked });
  const sent: { status?: number; body?: unknown } = {};
  const res = {
    status(code: number) { sent.status = code; return res; },
    json(body: unknown) { sent.body = body; return res; },
  };
  const { logs } = await capturingLogs(async () => {
    sendBinaryRouteError(res as unknown as Parameters<typeof sendBinaryRouteError>[0], error, 'binary unpin');
  });
  assert.equal(sent.status, 500);
  assert.deepEqual(sent.body, { error: 'pin_failed', message: 'The configuration could not be written.' });
  assert.equal(logs, '[backends] binary unpin: unexpected failure (EPERM)');
  assertNoPath(`${JSON.stringify(sent.body)}\n${logs}`, leaked);
});

test('normalizePinPath: quotes, tilde and Windows paths', () => {
  assert.equal(normalizePinPath('"/opt/x/claude"', 'linux', '/home/u'), '/opt/x/claude');
  assert.equal(normalizePinPath('~/bin/claude', 'linux', '/home/u'), join('/home/u', 'bin', 'claude'));
  assert.equal(normalizePinPath('claude', 'linux', '/home/u'), null);
  assert.equal(normalizePinPath('~', 'linux', '/home/u'), null);
  assert.equal(normalizePinPath('"C:\\Program Files\\Claude\\claude.exe"', 'win32', 'C:\\Users\\u'), 'C:\\Program Files\\Claude\\claude.exe');
  assert.equal(normalizePinPath('~\\AppData\\Roaming\\npm\\claude.cmd', 'win32', 'C:\\Users\\u'), 'C:\\Users\\u\\AppData\\Roaming\\npm\\claude.cmd');
  assert.equal(normalizePinPath('\\\\server\\share\\claude.exe', 'win32', 'C:\\Users\\u'), '\\\\server\\share\\claude.exe');
  assert.equal(normalizePinPath('C:claude.exe', 'win32', 'C:\\Users\\u'), null, 'drive-relative is not absolute');
  assert.equal(normalizePinPath('\\claude.exe', 'win32', 'C:\\Users\\u'), null, 'root-relative depends on the current drive');
});

test('Windows: only what the adapter can start is accepted, whatever the execute bit says', () => {
  for (const ok of ['C:\\npm\\claude.cmd', 'C:\\npm\\CLAUDE.CMD', 'C:\\x\\codex.exe', 'C:\\x\\run.bat', 'C:\\x\\tool.com']) {
    assert.equal(runnableOnWindows(ok), true, ok);
  }
  for (const refused of ['C:\\npm\\claude', 'C:\\npm\\claude.ps1', 'C:\\x\\claude.js']) {
    assert.equal(runnableOnWindows(refused), false, refused);
  }
  // An existing, runnable-on-Linux file without a Windows extension: refused
  // as soon as the daemon runs on Windows.
  assert.throws(() => assertExecutablePin(POSIX_EXECUTABLE, 'win32'), (err: Error & { code?: string }) => err.code === 'path_not_executable');
  assert.doesNotThrow(() => assertExecutablePin(POSIX_EXECUTABLE, 'linux'));
});
