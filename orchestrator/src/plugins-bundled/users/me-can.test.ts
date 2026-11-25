/**
 * `GET /api/auth/me` answers `can`: whether the caller holds the permissions
 * the UI greys a control on (TODO #560, #620, #693). Witness on 127.0.0.1:0.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { grantTestPermissions, postTestAccount } from '../../../tests/helpers/accounts.js';

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-roles-http-m2d-'));
await import('../../../tests/helpers/paid-license.js');
process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';

const { createDaemonAuthMiddleware } = await import('../http/auth.js');
const { registerRoutes } = await import('./routes.js');
const { dbApi } = await import('../../db.js');
const { SESSION_COOKIE } = await import('../../users/session.js');

const TOKEN = 'witness-daemon-token';

const app = express();
app.use(createDaemonAuthMiddleware({ token: TOKEN, required: true }));
app.use(express.json());
registerRoutes(app, { setupPolicy: 'free' });

const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const { port } = server.address() as AddressInfo;
assert.notEqual(port, 3000, 'the witness must not take the production port');
const base = `http://127.0.0.1:${port}`;
test.after(() => { server.close(); });

function sessionCookie(res: Response): string | undefined {
  const lines = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : (res.headers.get('set-cookie') ? [res.headers.get('set-cookie')!] : []);
  for (const line of lines) {
    const match = new RegExp(`(?:^|,\\s*)${SESSION_COOKIE}=([^;]+)`).exec(line);
    if (match?.[1]) return decodeURIComponent(match[1]);
  }
  return undefined;
}

async function call(
  method: string,
  path: string,
  opts: { body?: unknown; cookie?: string; bearer?: string } = {},
): Promise<{ status: number; json: unknown; res: Response }> {
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
  return { status: res.status, json, res };
}

const setup = await call('POST', '/api/auth/setup', {
  body: { email: 'robin@example.com', name: 'Robin', password: 'super-secret' },
});
assert.equal(setup.status, 201);
const adminCookie = sessionCookie(setup.res);
assert.ok(adminCookie);

const createdUser = postTestAccount(dbApi, { email: 'ada@example.com', name: 'Ada', password: 'employee-secret' });
assert.equal(createdUser.status, 201);
const adaId = createdUser.json.user!.id;
const adaLogin = await call('POST', '/api/auth/login', {
  body: { email: 'ada@example.com', password: 'employee-secret' },
});
const adaCookie = sessionCookie(adaLogin.res);
assert.ok(adaCookie);

// TODO #560: the UI greys the Git buttons on `can`, so it must say no to an
// account without the grant, and follow the grant both ways.
const NONE = { 'projects:manage': false, 'agents:manage': false, 'agents:privileged-config': false, 'providers:manage': false, 'providers:accounts': false, 'settings:write': false, 'forge:publish': false };
const ALL = { 'projects:manage': true, 'agents:manage': true, 'agents:privileged-config': true, 'providers:manage': true, 'providers:accounts': true, 'settings:write': true, 'forge:publish': true };
const canOf = async (opts: { cookie?: string; bearer?: string }) =>
  ((await call('GET', '/api/auth/me', opts)).json as { can: Record<string, boolean> }).can;

test('GET /api/auth/me says whether the caller holds projects:manage', async () => {
  assert.deepEqual(await canOf({ cookie: adaCookie }), NONE);
  assert.deepEqual(await canOf({ cookie: adminCookie }), ALL);
  assert.deepEqual(await canOf({ bearer: TOKEN }), ALL);

  grantTestPermissions(dbApi, adaId, ['projects:manage']);
  try {
    assert.deepEqual(await canOf({ cookie: adaCookie }), { ...NONE, 'projects:manage': true });
  } finally {
    grantTestPermissions(dbApi, adaId, []);
  }
  assert.deepEqual(await canOf({ cookie: adaCookie }), NONE);
});

// TODO #620: the skill island greys the global / project / role attachment
// controls on it; `agents:manage` alone is not enough to hold it.
test('GET /api/auth/me says whether the caller holds agents:privileged-config', async () => {
  // An anonymous caller is refused the grant, never handed a default true.
  assert.deepEqual(await canOf({}), NONE);

  grantTestPermissions(dbApi, adaId, ['agents:manage']);
  try {
    assert.deepEqual(await canOf({ cookie: adaCookie }), { ...NONE, 'agents:manage': true });
  } finally {
    grantTestPermissions(dbApi, adaId, []);
  }

  grantTestPermissions(dbApi, adaId, ['agents:manage', 'agents:privileged-config']);
  try {
    assert.deepEqual(await canOf({ cookie: adaCookie }), { ...NONE, 'agents:manage': true, 'agents:privileged-config': true });
  } finally {
    grantTestPermissions(dbApi, adaId, []);
  }
  assert.deepEqual(await canOf({ cookie: adaCookie }), NONE);
});

// The Providers screen paints its level from these two (`users/provider-access.ts`).
test('GET /api/auth/me says which level of the Providers screen the caller holds', async () => {
  grantTestPermissions(dbApi, adaId, ['providers:accounts']);
  try {
    assert.deepEqual(await canOf({ cookie: adaCookie }), { ...NONE, 'providers:accounts': true });
  } finally {
    grantTestPermissions(dbApi, adaId, []);
  }
  // A deny of the wide level on top of `*` leaves the narrow one.
  grantTestPermissions(dbApi, adaId, ['*', '-providers:manage']);
  try {
    const can = await canOf({ cookie: adaCookie });
    assert.equal(can['providers:manage'], false);
    assert.equal(can['providers:accounts'], true);
  } finally {
    grantTestPermissions(dbApi, adaId, []);
  }
});

// TODO #693: the skill island greys the agent-scope attachment controls on
// `agents:manage`, the permission every attachment write requires.
test('GET /api/auth/me says whether the caller holds agents:manage', async () => {
  // Anonymous and grant-less callers read false: a greyed button, never a 403.
  assert.equal((await canOf({}))['agents:manage'], false);
  assert.equal((await canOf({ cookie: adaCookie }))['agents:manage'], false);

  grantTestPermissions(dbApi, adaId, ['agents:read', 'agents:privileged-config']);
  try {
    assert.equal((await canOf({ cookie: adaCookie }))['agents:manage'], false, 'privileged-config does not imply agents:manage');
  } finally {
    grantTestPermissions(dbApi, adaId, []);
  }

  grantTestPermissions(dbApi, adaId, ['agents:manage']);
  try {
    assert.equal((await canOf({ cookie: adaCookie }))['agents:manage'], true);
  } finally {
    grantTestPermissions(dbApi, adaId, []);
  }
  assert.equal((await canOf({ cookie: adaCookie }))['agents:manage'], false);
});

// Settings › System › Updates hides "Check now" and its switch on it (POST /api/updates/check).
test('GET /api/auth/me says whether the caller holds settings:write', async () => {
  assert.equal((await canOf({}))['settings:write'], false);
  assert.equal((await canOf({ cookie: adaCookie }))['settings:write'], false);
  grantTestPermissions(dbApi, adaId, ['settings']);
  try {
    assert.equal((await canOf({ cookie: adaCookie }))['settings:write'], false, 'reading the settings does not write them');
  } finally {
    grantTestPermissions(dbApi, adaId, []);
  }
  grantTestPermissions(dbApi, adaId, ['settings:write']);
  try {
    assert.deepEqual(await canOf({ cookie: adaCookie }), { ...NONE, 'settings:write': true });
  } finally {
    grantTestPermissions(dbApi, adaId, []);
  }
});

// The Publish on GitHub window greys its button on it (POST …/forge-proposals/:id/publish).
test('GET /api/auth/me says whether the caller holds forge:publish, which projects:manage does not imply', async () => {
  assert.equal((await canOf({}))['forge:publish'], false);
  grantTestPermissions(dbApi, adaId, ['projects:manage']);
  try {
    assert.equal((await canOf({ cookie: adaCookie }))['forge:publish'], false);
  } finally {
    grantTestPermissions(dbApi, adaId, []);
  }
  grantTestPermissions(dbApi, adaId, ['forge:publish']);
  try {
    assert.deepEqual(await canOf({ cookie: adaCookie }), { ...NONE, 'forge:publish': true });
  } finally {
    grantTestPermissions(dbApi, adaId, []);
  }
});
