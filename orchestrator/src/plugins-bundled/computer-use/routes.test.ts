import { createTestAccount } from '../../../tests/helpers/accounts.js';
import '../../test-home.js';
import '../../../tests/helpers/paid-license.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdirSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { dbApi } from '../../db.js';
import { agentConfig, agentDir } from '../../paths.js';
import { issueMissionApiToken } from '../../users/api-tokens.js';
import { hashSessionToken, SESSION_COOKIE } from '../../users/session.js';
import { createDaemonAuthMiddleware } from '../http/auth.js';
import { registerComputerRoutes } from './routes.js';
import { callNativeComputer, computerUnavailableHint, NativeComputerError } from '../../native-computer-provider.js';
import { apiError } from '../../api-error.js';
import { agentWideningRefusal } from '../../users/privileged-overrides.js';

const alice = createTestAccount(dbApi, { email: 'computer-alice@example.test', name: 'Alice', passwordHash: 'unused' });
const cookie = randomUUID();
dbApi.createSession({ tokenHash: hashSessionToken(cookie), userId: alice.id, expiresAt: Date.now() + 60_000 });

function agentWith(name: string, config: object): string {
  mkdirSync(agentDir(name), { recursive: true });
  writeFileSync(agentConfig(name), JSON.stringify(config));
  const mission = randomUUID();
  dbApi.createMission(mission, name, 'test', undefined, alice.id);
  return issueMissionApiToken(mission);
}
const enabledToken = agentWith('computer-on', { computer_use: true });
const disabledToken = agentWith('computer-off', {});

const forwarded: ({ allowedApps: string[] } | undefined)[] = [];
const calls: { command: string; args: Record<string, unknown>; actor: string }[] = [];
let desktop: 'up' | 'down' | 'stopped' | 'echo' = 'up';
const app = express();
app.use(createDaemonAuthMiddleware({ required: true, token: 'computer-test-daemon' }));
app.use(express.json());
registerComputerRoutes(app, {
  call: async (command, args, actor, options) => {
    calls.push({ command, args, actor });
    forwarded.push(options?.allowedApps === undefined ? undefined : { allowedApps: [...options.allowedApps] });
    if (desktop === 'down') throw new NativeComputerError(apiError('computer_unavailable', 'down'), 503);
    if (desktop === 'stopped') throw new NativeComputerError(apiError('computer_stopped', 'stopped'), 409);
    if (desktop === 'echo') throw new Error(`driver rejected ${String(args.text)}`);
    return { command };
  },
});
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
test.after(() => server.close());
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/computer`;
async function post(command: string, body: object = {}, auth: 'user' | 'enabled' | 'disabled' | 'daemon' | 'anonymous' = 'enabled') {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (auth === 'user') headers.cookie = `${SESSION_COOKIE}=${cookie}`;
  if (auth === 'enabled') headers.authorization = `Bearer ${enabledToken}`;
  if (auth === 'disabled') headers.authorization = `Bearer ${disabledToken}`;
  if (auth === 'daemon') headers.authorization = 'Bearer computer-test-daemon';
  const res = await fetch(`${base}/${command}`, { method: 'POST', headers, body: JSON.stringify(body) });
  return { status: res.status, json: await res.json() as any };
}

test('an anonymous request is refused', async () => {
  assert.equal((await post('status', {}, 'anonymous')).status, 401);
  assert.equal(calls.length, 0);
});

test('an agent without computer_use gets 403 computer_use_disabled', async () => {
  const res = await post('click', { x: 1, y: 2 }, 'disabled');
  assert.equal(res.status, 403);
  assert.equal(res.json.code, 'computer_use_disabled');
  assert.equal((await post('status', {}, 'disabled')).status, 403);
  assert.equal(calls.length, 0);
});

test('the daemon token is never accepted for a command', async () => {
  const res = await post('status', {}, 'daemon');
  assert.equal(res.status, 403);
  assert.equal(res.json.code, 'computer_mission_token_required');
});

test('an unknown command is refused with 400, invalid arguments too', async () => {
  const unknown = await post('format_disk');
  assert.equal(unknown.status, 400);
  assert.equal(unknown.json.code, 'computer_command_unknown');
  assert.equal((await post('click', { x: 'a', y: 2 })).json.code, 'computer_args_invalid');
  assert.equal((await post('type', { text: 'x'.repeat(2001) })).status, 400);
  assert.equal((await post('click', { x: 1, y: 2, actor: 'human' })).status, 400);
  assert.equal(calls.length, 0);
});

test('the actor comes from the authentication, never the body', async () => {
  const res = await post('click', { x: 1, y: 2, button: 'right' });
  assert.equal(res.status, 200);
  assert.deepEqual(res.json, { ok: true, result: { command: 'click' } });
  assert.deepEqual(calls.at(-1), { command: 'click', args: { x: 1, y: 2, button: 'right' }, actor: 'agent' });
  await post('stop', {}, 'user');
  assert.equal(calls.at(-1)?.actor, 'human');
});

test('stop and resume are reserved to people, who can do nothing else', async () => {
  assert.equal((await post('stop', {}, 'enabled')).json.code, 'computer_command_user_only');
  assert.equal((await post('resume', {}, 'enabled')).status, 403);
  assert.equal((await post('status', {}, 'user')).status, 200);
  assert.equal((await post('resume', {}, 'user')).status, 200);
  assert.equal((await post('click', { x: 1, y: 2 }, 'user')).status, 403);
});

test('an absent desktop answers 503 and a stopped one 409', async () => {
  desktop = 'down';
  const down = await post('screenshot');
  assert.equal(down.status, 503);
  assert.equal(down.json.code, 'computer_unavailable');
  desktop = 'stopped';
  const stopped = await post('move', { x: 1, y: 1 });
  assert.equal(stopped.status, 409);
  assert.equal(stopped.json.code, 'computer_stopped');
  desktop = 'up';
});

test('the real provider answers 503 when the desktop has written no provider file', async () => {
  await assert.rejects(callNativeComputer('status', {}, 'agent', { home: '/nonexistent-timon-home' }),
    (error: NativeComputerError) => error.status === 503 && error.body.code === 'computer_unavailable');
});

test('typed text never reaches the logs', async () => {
  const secret = 'hunter2-typed-text';
  const lines: string[] = [];
  const originals = { log: console.log, info: console.info, warn: console.warn, error: console.error };
  for (const key of Object.keys(originals) as (keyof typeof originals)[]) console[key] = (...parts: unknown[]) => { lines.push(parts.join(' ')); };
  try {
    await post('type', { text: secret });
    desktop = 'echo';
    const res = await post('type', { text: secret });
    assert.equal(res.status, 400);
  } finally {
    Object.assign(console, originals);
    desktop = 'up';
  }
  assert.equal(lines.some((line) => line.includes(secret)), false);
});

test('only a person turns computer_use on', () => {
  assert.match(agentWideningRefusal({ computer_use: true }, null) ?? '', /computer_use/);
  assert.equal(agentWideningRefusal({ computer_use: true }, { computer_use: true }), null);
  // The list of allowed applications: kept or narrowed by an agent's token, never widened.
  assert.match(agentWideningRefusal({ computer_use_apps: ['Notepad'] }, null) ?? '', /computer_use_apps/);
  assert.match(agentWideningRefusal({ computer_use_apps: ['Notepad', 'Calc'] }, { computer_use_apps: ['notepad'] }) ?? '', /adds Calc/);
  assert.equal(agentWideningRefusal({ computer_use_apps: ['NOTEPAD'] }, { computer_use_apps: ['Notepad', 'Calc'] }), null);
  assert.equal(agentWideningRefusal({ computer_use_apps: [] }, null), null);
  assert.match(agentWideningRefusal({ computer_use_apps: 'Notepad' }, null) ?? '', /array of strings/);
  assert.equal(agentWideningRefusal({ computer_use: false }, null), null);
  assert.match(agentWideningRefusal({ computer_use: 'yes' }, null) ?? '', /boolean/);
});

test('setting up the computer is reserved to people: an agent and an anonymous caller are refused', async () => {
  for (const command of ['request_permissions', 'restart_app']) {
    const agent = await post(command, {}, 'enabled');
    assert.equal(agent.status, 403);
    assert.equal(agent.json.code, 'computer_command_user_only');
    assert.equal((await post(command, {}, 'anonymous')).status, 401);
    assert.equal((await post(command, {}, 'daemon')).status, 403);
    assert.equal((await post(command, { actor: 'agent' }, 'user')).json.code, 'computer_args_invalid');
  }
  const before = calls.length;
  assert.equal((await post('request_permissions', {}, 'disabled')).status, 403);
  assert.equal(calls.length, before);
  const person = await post('request_permissions', {}, 'user');
  assert.equal(person.status, 200);
  assert.deepEqual(calls.at(-1), { command: 'request_permissions', args: {}, actor: 'human' });
  assert.equal((await post('restart_app', {}, 'user')).status, 200);
});

test('an unavailable desktop tells the agent what to ask the user, without echoing the desktop text', async () => {
  const server = (await import('node:http')).createServer((_req, res) => {
    res.statusCode = 503;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: false, code: 'computer_unavailable', error: 'Computer use is unavailable: permission-screen. /Users/secret' }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { mkdtempSync, mkdirSync: mk, writeFileSync: write } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const home = mkdtempSync(join(tmpdir(), 'computer-home-'));
  mk(join(home, 'computer-native'));
  write(join(home, 'computer-native', 'provider.json'), JSON.stringify({ version: 1, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, token: 'x'.repeat(40), pid: 1 }));
  try {
    await assert.rejects(callNativeComputer('screenshot', {}, 'agent', { home }), (error: NativeComputerError) => {
      assert.equal(error.status, 503);
      assert.equal(error.body.code, 'computer_unavailable');
      assert.match(error.body.error, /Ask the user to allow Timon under System Settings › Privacy & Security › Screen Recording/);
      assert.doesNotMatch(error.body.error, /secret/);
      return true;
    });
  } finally { server.close(); }
});

test('every unavailable reason has an instruction for the agent', () => {
  assert.match(computerUnavailableHint('permission-accessibility'), /Accessibility/);
  assert.match(computerUnavailableHint('no-input-tool'), /install xdotool/);
  assert.match(computerUnavailableHint('wayland'), /X11/);
  assert.match(computerUnavailableHint('no-desktop'), /desktop app must be running/);
  assert.match(computerUnavailableHint('weird'), /setup card/);
  assert.match(computerUnavailableHint(null), /setup card/);
});

test('the agent\'s allowed applications travel with its commands, never a person\'s or the body\'s', async () => {
  const listed = agentWith('computer-apps', { computer_use: true, computer_use_apps: ['TextEdit', ' ', 3] });
  const listedRes = await fetch(`${base}/click`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${listed}` }, body: JSON.stringify({ x: 1, y: 2 }) });
  assert.equal(listedRes.status, 200);
  assert.deepEqual(forwarded.at(-1), { allowedApps: ['TextEdit'] });
  await post('click', { x: 1, y: 2 }, 'enabled');
  assert.deepEqual(forwarded.at(-1), { allowedApps: [] }, 'no list stored = nothing allowed');
  await post('list_windows', {}, 'user');
  assert.equal(forwarded.at(-1), undefined, 'a person\'s command carries no list');
  assert.equal((await post('click', { x: 1, y: 2, allowedApps: ['*'] }, 'enabled')).status, 400, 'the body cannot add one');
});

test('list_windows is open to a person and an agent; focus_window only to an agent, with a plain id', async () => {
  assert.equal((await post('list_windows', {}, 'user')).status, 200);
  assert.equal((await post('list_windows', {}, 'enabled')).status, 200);
  assert.equal((await post('list_windows', {}, 'anonymous')).status, 401);
  assert.equal((await post('list_windows', {}, 'disabled')).json.code, 'computer_use_disabled');
  assert.equal((await post('focus_window', { id: '12:3' }, 'enabled')).status, 200);
  assert.equal((await post('focus_window', { id: '12:3' }, 'user')).status, 403);
  assert.equal((await post('focus_window', { id: '../etc' }, 'enabled')).json.code, 'computer_args_invalid');
  assert.equal((await post('focus_window', {}, 'enabled')).json.code, 'computer_args_invalid');
});
