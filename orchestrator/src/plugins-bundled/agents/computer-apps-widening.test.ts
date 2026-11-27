/**
 * An agent's token cannot widen `computer_use_apps` through the agent config PATCH:
 * it may keep or narrow the list, never add to it, whatever its account holds.
 * Isolated TIMON_HOME, witness on 127.0.0.1:0.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { grantTestPermissions, postTestAccount } from '../../../tests/helpers/accounts.js';

const HOME = mkdtempSync(join(tmpdir(), 'timon-computer-apps-widening-'));
process.env.TIMON_HOME = HOME;
await import('../../../tests/helpers/paid-license.js');
await import('../../../tests/helpers/claude-provider.js');

process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';
const TOKEN = 'witness-daemon-token';
writeFileSync(join(HOME, 'daemon-token'), TOKEN, { encoding: 'utf8', mode: 0o600 });

const { createDaemonAuthMiddleware } = await import('../http/auth.js');
const { registerRoutes: registerUserRoutes } = await import('../users/routes.js');
const { registerRoutes: registerAgentRoutes } = await import('./routes.js');
const { dbApi } = await import('../../db.js');
const { agentConfig } = await import('../../paths.js');
const { hashApiToken, issueMissionApiToken } = await import('../../users/api-tokens.js');
const { SESSION_COOKIE } = await import('../../users/session.js');

const app = express();
app.use(createDaemonAuthMiddleware({ token: TOKEN, required: true }));
app.use(express.json());
registerUserRoutes(app, { setupPolicy: 'free' });
registerAgentRoutes(app);

const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const { port } = server.address() as AddressInfo;
const base = `http://127.0.0.1:${port}`;
test.after(() => { server.close(); });

function sessionCookie(res: Response): string | undefined {
  for (const line of res.headers.getSetCookie()) {
    const match = new RegExp(`(?:^|,\\s*)${SESSION_COOKIE}=([^;]+)`).exec(line);
    if (match?.[1]) return decodeURIComponent(match[1]);
  }
  return undefined;
}

async function call(
  method: string,
  path: string,
  opts: { body?: unknown; cookie?: string; bearer?: string } = {},
): Promise<{ status: number; json: unknown }> {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (opts.cookie) headers.cookie = `${SESSION_COOKIE}=${encodeURIComponent(opts.cookie)}`;
  if (opts.bearer) headers.authorization = `Bearer ${opts.bearer}`;
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
  });
  const text = await res.text();
  let json: unknown = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, json };
}

const setup = await call('POST', '/api/auth/setup', {
  body: { email: 'admin@example.com', name: 'Admin', password: 'admin-secret' },
});
assert.equal(setup.status, 201);

async function account(email: string, permissions: string[]): Promise<{ id: string; cookie: string }> {
  const created = await postTestAccount(dbApi, { email, name: email, password: 'pass-secret' });
  assert.equal(created.status, 201);
  const id = (created.json as { user: { id: string } }).user.id;
  grantTestPermissions(dbApi, id, permissions);
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'pass-secret' }),
  });
  const cookie = sessionCookie(res);
  assert.ok(cookie);
  return { id, cookie };
}

const manager = await account('manager@example.com', ['agents:manage', 'agents:read', 'missions:read']);

function missionToken(agent: string, ownerId: string): string {
  const missionId = randomUUID();
  dbApi.createMission(missionId, agent, 'work', undefined, ownerId);
  const raw = issueMissionApiToken(missionId);
  assert.ok(dbApi.getLiveApiToken(hashApiToken(raw)));
  return raw;
}

const cwd = mkdtempSync(join(tmpdir(), 'timon-computer-apps-cwd-'));
dbApi.upsertProject('apps-widening', { cwd });
// Coders, so that only the explicit reports_to tree decides who orchestrates whom.
for (const name of ['apps.lead', 'apps.helper', 'apps.stranger']) {
  const r = await call('POST', '/api/agents', { bearer: TOKEN, body: { name, system_prompt: 'witness', config: { cwd, role: 'coder' } } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
}
const stored = (name: string): Record<string, unknown> => JSON.parse(readFileSync(agentConfig(name), 'utf8')) as Record<string, unknown>;



// A person (the operator's daemon token) lists the applications; the agent's own token then tries to change them.
const seeded = await call('PATCH', '/api/agents/apps.lead/config', { bearer: TOKEN, body: { computer_use_apps: ['Notepad'] } });
assert.equal(seeded.status, 200, JSON.stringify(seeded.json));
const leadToken = missionToken('apps.lead', manager.id);

test("an agent's token cannot add an application to computer_use_apps", async () => {
  const r = await call('PATCH', '/api/agents/apps.lead/config', { bearer: leadToken, body: { computer_use_apps: ['Notepad', 'Calculator'] } });
  assert.equal(r.status, 403, JSON.stringify(r.json));
  assert.match(JSON.stringify(r.json), /adds Calculator/);
  assert.deepEqual(stored('apps.lead').computer_use_apps, ['Notepad']);
});

test("an agent's token cannot widen the list of an agent that has none", async () => {
  const r = await call('PATCH', '/api/agents/apps.helper/config', { bearer: leadToken, body: { computer_use_apps: ['Notepad'] } });
  assert.equal(r.status, 403, JSON.stringify(r.json));
  assert.match(JSON.stringify(r.json), /adds Notepad/);
  assert.equal(stored('apps.helper').computer_use_apps, undefined);
});

test("an agent's token may narrow the list", async () => {
  const r = await call('PATCH', '/api/agents/apps.lead/config', { bearer: leadToken, body: { computer_use_apps: [] } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(stored('apps.lead').computer_use_apps ?? [], []);
});

test("an agent's token cannot change computer_use_mode, a person can", async () => {
  const refused = await call('PATCH', '/api/agents/apps.helper/config', { bearer: leadToken, body: { computer_use_mode: 'background' } });
  assert.equal(refused.status, 403, JSON.stringify(refused.json));
  assert.equal(stored('apps.helper').computer_use_mode, undefined);
  const invalid = await call('PATCH', '/api/agents/apps.helper/config', { bearer: TOKEN, body: { computer_use_mode: 'sideways' } });
  assert.equal(invalid.status, 400, JSON.stringify(invalid.json));
  const set = await call('PATCH', '/api/agents/apps.helper/config', { bearer: TOKEN, body: { computer_use_mode: 'background' } });
  assert.equal(set.status, 200, JSON.stringify(set.json));
  assert.equal(stored('apps.helper').computer_use_mode, 'background');
});
