/**
 * The browser routes when no provider answers: the refusal says who should provide the browser
 * on this machine (`built-in-browser.ts`), to the panel coded and to an agent in English.
 */
import { createTestAccount } from '../../../tests/helpers/accounts.js';
import '../../test-home.js';
import '../../../tests/helpers/paid-license.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { dbApi } from '../../db.js';
import { createBrowserProfile } from '../../browser-profiles.js';
import { issueMissionApiToken } from '../../users/api-tokens.js';
import { hashSessionToken, SESSION_COOKIE } from '../../users/session.js';
import { createDaemonAuthMiddleware } from '../http/auth.js';
import { registerNativeBrowserRoutes } from './native-routes.js';
import { NativeBrowserError } from '../../native-browser-provider.js';
import { apiError } from '../../api-error.js';
import { builtInBrowserRefusal } from '../../built-in-browser.js';

const alice = createTestAccount(dbApi, { email: 'unavailable-alice@example.test', name: 'Alice', passwordHash: 'unused' });
const cookie = randomUUID();
dbApi.createSession({ tokenHash: hashSessionToken(cookie), userId: alice.id, expiresAt: Date.now() + 60_000 });
const profile = createBrowserProfile({ name: 'Alice browser', owner_user_id: alice.id });
const mission = randomUUID();
dbApi.createMission(mission, 'unavailable-agent', 'test', undefined, alice.id);
dbApi.setMissionBrowserProfile(mission, profile.id);
const missionToken = issueMissionApiToken(mission);

const desktopDown = apiError('browser_desktop_unavailable', 'Open Timon desktop on the host machine to use this browser.');
const hostDown = builtInBrowserRefusal({
  provider: 'none', server: true, unit: 'timon-browser-abc',
  problems: [{ id: 'host-unit-missing', blocking: true, message: 'the browser host service is not installed.', fix: 'timon service install' }],
});
let explained = 0;
const app = express();
app.use(createDaemonAuthMiddleware({ required: true, token: 'unavailable-test-daemon' }));
app.use(express.json());
registerNativeBrowserRoutes(app, {
  capabilities: async () => ({ available: false, reason: desktopDown.error, refusal: desktopDown, chrome: { available: true, name: 'Chrome' } }),
  detectChrome: () => ({ found: false, reason: 'none' }),
  call: async () => { throw new NativeBrowserError(desktopDown, 503); },
  unavailable: () => { explained += 1; return hostDown; },
});
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
test.after(() => server.close());
const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/native-browser`;

async function call(path: string, body: object | undefined, auth: 'user' | 'mission' | 'anonymous') {
  const headers: Record<string, string> = {};
  if (auth === 'user') headers.cookie = `${SESSION_COOKIE}=${cookie}`;
  if (auth === 'mission') headers.authorization = `Bearer ${missionToken}`;
  if (body) headers['content-type'] = 'application/json';
  const res = await fetch(`${origin}/${path}`, { method: body ? 'POST' : 'GET', headers, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, json: await res.json() as Record<string, unknown> };
}

test('an anonymous request learns nothing of the browser host', async () => {
  const anonymous = await call('capabilities', undefined, 'anonymous');
  assert.equal(anonymous.status, 401);
  assert.doesNotMatch(JSON.stringify(anonymous.json), /timon-browser|service install/);
  assert.equal((await call('mission/command', { action: 'status' }, 'anonymous')).status, 401);
});

test('the panel gets the server refusal coded, with the repair command and nothing of the provider file', async () => {
  const caps = await call('capabilities', undefined, 'user');
  assert.equal(caps.status, 200);
  assert.equal(caps.json.available, false);
  assert.deepEqual(caps.json.refusal, hostDown);
  assert.equal(caps.json.reason, hostDown.error);
  assert.doesNotMatch(JSON.stringify(caps.json), /provider\.json|origin|token/i);
});

test('an agent is told the server browser is down, not to retry, and what the user runs', async () => {
  const before = explained;
  const res = await call('mission/command', { action: 'navigate', url: 'https://example.test' }, 'mission');
  assert.equal(res.status, 503);
  assert.equal(res.json.code, 'browser_host_stopped');
  assert.match(String(res.json.error), /Do not retry the browser: tell the user/);
  assert.match(String(res.json.error), /timon service install/);
  assert.ok(explained > before);
});
