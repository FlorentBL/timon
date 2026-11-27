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
import { callNativeComputer, NativeComputerError } from '../../native-computer-provider.js';
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

const calls: { command: string; args: Record<string, unknown>; actor: string }[] = [];
let desktop: 'up' | 'down' | 'stopped' | 'echo' = 'up';
const app = express();
app.use(createDaemonAuthMiddleware({ required: true, token: 'computer-test-daemon' }));
app.use(express.json());
registerComputerRoutes(app, {
  call: async (command, args, actor) => {
    calls.push({ command, args, actor });
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
  assert.equal(agentWideningRefusal({ computer_use: false }, null), null);
  assert.match(agentWideningRefusal({ computer_use: 'yes' }, null) ?? '', /boolean/);
});
