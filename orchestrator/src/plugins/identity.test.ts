/**
 * M.7 — per-request identity on PluginContext. A plugin is loaded once;
 * facades read AsyncLocalStorage. Jobs see `plugin:<id>` rows only; a
 * router handler sees what the current caller sees. `assertPermission`
 * checks the manifesto, then the M.2 evaluator.
 */
import { createTestAccount, grantTestPermissions } from '../../tests/helpers/accounts.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { Context } from '@deepseek-ai/cordis';

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-plugin-identity-'));
await import('../../tests/helpers/paid-license.js');
process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';

const { createHttpPlugin } = await import('../kernel/http-service.js');
const { readManifest, PLUGIN_API_VERSION } = await import('./manifest.js');
const {
  createPluginContext, daemonHost, PluginPermissionError, PluginCallerError, PLUGIN_ROUTE_PREFIX,
} = await import('./context.js');
const { identityFromRequest, runPluginRequest } = await import('./als.js');
const { dbApi } = await import('../db.js');
const { hashPassword } = await import('../users/password.js');
const { createDaemonAuthMiddleware } = await import('../plugins-bundled/http/auth.js');
const { hashSessionToken, issueSessionToken, SESSION_COOKIE } = await import('../users/session.js');

function manifestOf(id: string, permissions: string[], extra: Record<string, unknown> = {}) {
  const res = readManifest({ timon: { id, apiVersion: PLUGIN_API_VERSION, permissions, ...extra } });
  assert.equal(res.ok, true, `invalid test manifest for ${id}`);
  if (!res.ok) throw new Error('unreachable');
  return res.manifest;
}

async function pluginFiber(root: Context) {
  let inner!: Context;
  const fiber = await root.plugin({ name: 'plugin-holder', apply(ctx: Context) { inner = ctx; } });
  return { ctx: inner, dispose: () => fiber.dispose() };
}

const admin = createTestAccount(dbApi, {
  email: 'admin@example.com',
  name: 'Admin',
  passwordHash: await hashPassword('admin-secret'),
  isSuperadmin: true,
});
const ada = createTestAccount(dbApi, {
  email: 'ada@example.com',
  name: 'Ada',
  passwordHash: await hashPassword('ada-secret'),
  isSuperadmin: false,
});
const bob = createTestAccount(dbApi, {
  email: 'bob@example.com',
  name: 'Bob',
  passwordHash: await hashPassword('bob-secret'),
  isSuperadmin: false,
});

grantTestPermissions(dbApi, ada.id, ['missions:read', 'kanban:read', 'users:read', 'plugin:scoped-plugin']);
grantTestPermissions(dbApi, bob.id, ['missions:read', 'kanban:read']);

const PLUGIN_ID = 'scoped-plugin';
const pluginOwner = `plugin:${PLUGIN_ID}`;

const adaMission = randomUUID();
const adminMission = randomUUID();
const pluginMission = randomUUID();
dbApi.createMission(adaMission, 'ada.agent', 'ada work', undefined, ada.id);
dbApi.createMission(adminMission, 'admin.agent', 'admin work', undefined, admin.id);
dbApi.createMission(pluginMission, 'job.agent', 'plugin job', { channel: pluginOwner }, pluginOwner);

const adaTask = randomUUID();
const adminTask = randomUUID();
dbApi.createTask(adaTask, 'ada task', 'ada.agent', { ownerUserId: ada.id });
dbApi.createTask(adminTask, 'admin task', 'admin.agent', { ownerUserId: admin.id });

function adaIdentity() {
  return {
    viewer: { id: ada.id, isSuperadmin: false, permissions: dbApi.listPermissionsForUser(ada.id) },
    user: { id: ada.id, email: ada.email, name: ada.name, is_superadmin: false },
    ownerUserId: ada.id,
  };
}

function sessionFor(userId: string): string {
  const raw = issueSessionToken();
  dbApi.createSession({
    tokenHash: hashSessionToken(raw),
    userId,
    expiresAt: Date.now() + 60_000,
  });
  return raw;
}

test('a job list sees only plugin:<id> missions, never a user\'s', async () => {
  const root = new Context();
  const { ctx } = await pluginFiber(root);
  const plugin = createPluginContext(ctx, {
    manifest: manifestOf(PLUGIN_ID, ['missions:read', 'kanban:read']),
    version: '1.0.0',
  }, daemonHost(root));

  assert.equal(plugin.user(), undefined);
  const listed = await plugin.missions.list({ limit: 100 }) as { id: string; owner_user_id: string | null }[];
  assert.deepEqual(listed.map((m) => m.id).sort(), [pluginMission]);
  assert.equal(listed[0]?.owner_user_id, pluginOwner);
  assert.equal(await plugin.missions.get(adaMission), undefined);
  assert.ok(await plugin.missions.get(pluginMission));

  const tasks = await plugin.kanban.list() as { id: string }[];
  assert.equal(tasks.some((t) => t.id === adaTask), false);
  assert.equal(tasks.some((t) => t.id === adminTask), false);
  await root.fiber.dispose();
});

test('in a router-like request the plugin sees the caller\'s missions', async () => {
  const root = new Context();
  const { ctx } = await pluginFiber(root);
  const plugin = createPluginContext(ctx, {
    manifest: manifestOf(PLUGIN_ID, ['missions:read', 'kanban:read', 'users:read']),
    version: '1.0.0',
  }, daemonHost(root));

  await runPluginRequest(adaIdentity(), async () => {
    assert.deepEqual(plugin.user(), {
      id: ada.id,
      email: ada.email,
      name: ada.name,
      is_superadmin: false,
    });
    const listed = await plugin.missions.list({ limit: 100 }) as { id: string }[];
    assert.deepEqual(listed.map((m) => m.id).sort(), [adaMission]);
    assert.equal(await plugin.missions.get(adminMission), undefined);
    assert.ok(await plugin.missions.get(adaMission));
    const tasks = await plugin.kanban.list() as { id: string }[];
    assert.equal(tasks.some((t) => t.id === adaTask), true);
    assert.equal(tasks.some((t) => t.id === adminTask), false);
  });

  assert.equal(plugin.user(), undefined, 'leaving the request drops the caller');
  await root.fiber.dispose();
});

test('assertPermission throws without the manifesto permission', async () => {
  const root = new Context();
  const { ctx } = await pluginFiber(root);
  const plugin = createPluginContext(ctx, {
    manifest: manifestOf(PLUGIN_ID, []),
    version: '1.0.0',
  }, daemonHost(root));

  assert.throws(() => plugin.assertPermission('users:read'), PluginPermissionError);
  await root.fiber.dispose();
});

test('assertPermission throws when the caller lacks the grant', async () => {
  const root = new Context();
  const { ctx } = await pluginFiber(root);
  const plugin = createPluginContext(ctx, {
    manifest: manifestOf(PLUGIN_ID, ['users:read']),
    version: '1.0.0',
  }, daemonHost(root));

  await runPluginRequest({
    viewer: { id: bob.id, isSuperadmin: false, permissions: dbApi.listPermissionsForUser(bob.id) },
    user: { id: bob.id, email: bob.email, name: bob.name, is_superadmin: false },
    ownerUserId: bob.id,
  }, () => {
    assert.throws(() => plugin.assertPermission('users:read'), PluginCallerError);
  });

  await runPluginRequest(adaIdentity(), () => {
    plugin.assertPermission('users:read');
    plugin.assertPermission(`plugin:${PLUGIN_ID}`);
  });
  await root.fiber.dispose();
});

test('plugin routes carry the caller and hide the API without plugin:<id>', async () => {
  const app = express();
  const TOKEN = 'witness-plugin-identity';
  app.use(createDaemonAuthMiddleware({ token: TOKEN, required: true }));
  const root = new Context();
  await root.plugin(createHttpPlugin(app));
  const { ctx, dispose } = await pluginFiber(root);
  const plugin = createPluginContext(ctx, {
    manifest: manifestOf(PLUGIN_ID, ['missions:read', 'users:read']),
    version: '1.0.0',
  }, daemonHost(root));

  plugin.router().get('/whoami', async (_req, res) => {
    const user = plugin.user();
    const missions = await plugin.missions.list({ limit: 100 });
    res.json({ user, missions: (missions as { id: string }[]).map((m) => m.id) });
  });

  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}${PLUGIN_ROUTE_PREFIX}/${PLUGIN_ID}/whoami`;

  const adaCookie = sessionFor(ada.id);
  const adaRes = await fetch(url, { headers: { cookie: `${SESSION_COOKIE}=${adaCookie}` } });
  assert.equal(adaRes.status, 200);
  const adaBody = await adaRes.json() as { user: { id: string }; missions: string[] };
  assert.equal(adaBody.user.id, ada.id);
  assert.deepEqual(adaBody.missions.sort(), [adaMission]);

  const bobCookie = sessionFor(bob.id);
  const bobRes = await fetch(url, { headers: { cookie: `${SESSION_COOKIE}=${bobCookie}` } });
  assert.equal(bobRes.status, 404, 'without plugin:<id> the route does not confirm existence');

  const adminCookie = sessionFor(admin.id);
  const adminRes = await fetch(url, { headers: { cookie: `${SESSION_COOKIE}=${adminCookie}` } });
  assert.equal(adminRes.status, 200);
  const adminBody = await adminRes.json() as { user: { is_superadmin: boolean }; missions: string[] };
  assert.equal(adminBody.user.is_superadmin, true);
  assert.equal(adminBody.missions.includes(adaMission), true);
  assert.equal(adminBody.missions.includes(adminMission), true);

  server.close();
  await dispose();
  await root.fiber.dispose();
});

test('ctx.caller() tells a person from a mission or a service, and names neither (API 20)', async () => {
  const { issueMissionApiToken } = await import('../users/api-tokens.js');
  const { setLicenseState } = await import('../license/runtime.js');
  const { paidTestLicense } = await import('../../tests/helpers/paid-license.js');
  const app = express();
  const TOKEN = 'witness-plugin-caller';
  app.use(createDaemonAuthMiddleware({ token: TOKEN, required: true }));
  const root = new Context();
  await root.plugin(createHttpPlugin(app));
  const { ctx, dispose } = await pluginFiber(root);
  const plugin = createPluginContext(ctx, {
    manifest: manifestOf(PLUGIN_ID, ['missions:read']),
    version: '1.0.0',
  }, daemonHost(root));

  plugin.router().get('/caller', (_req, res) => {
    res.json({ caller: plugin.caller() ?? null, user: plugin.user()?.id ?? null });
  });

  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}${PLUGIN_ROUTE_PREFIX}/${PLUGIN_ID}/caller`;
  try {
    const session = await fetch(url, { headers: { cookie: `${SESSION_COOKIE}=${sessionFor(ada.id)}` } });
    assert.equal(session.status, 200);
    assert.deepEqual(await session.json(), { caller: { kind: 'person' }, user: ada.id });

    // A developer account's mission holds every right of its account, so its
    // token reaches the plugin as the same user: only `caller` says no person
    // is behind it (TODO #1195). An ordinary mission's token stops at the
    // `plugin:<id>` curtain before the plugin hears of it.
    setLicenseState({ ...paidTestLicense(), planId: 'internal', expiresAt: new Date(Date.now() + 86_400_000).toISOString() });
    try {
      const missionToken = issueMissionApiToken(adminMission);
      const mission = await fetch(url, { headers: { authorization: `Bearer ${missionToken}` } });
      assert.equal(mission.status, 200);
      const missionBody = await mission.json() as { caller: unknown; user: string };
      assert.deepEqual(missionBody, { caller: { kind: 'mission' }, user: admin.id });
      assert.equal(JSON.stringify(missionBody.caller).includes(adminMission), false, 'the mission is not named');
    } finally {
      setLicenseState(paidTestLicense());
    }

    const daemon = await fetch(url, { headers: { authorization: `Bearer ${TOKEN}` } });
    assert.equal(daemon.status, 200);
    assert.deepEqual((await daemon.json() as { caller: unknown }).caller, { kind: 'service' });

    const anonymous = await fetch(url);
    assert.equal(anonymous.status, 401, 'an anonymous request is refused before the plugin, as before');
  } finally {
    server.close();
    await dispose();
    await root.fiber.dispose();
  }
});

test('ctx.caller() is undefined outside a request and for an identity no request made', async () => {
  const root = new Context();
  const { ctx, dispose } = await pluginFiber(root);
  const plugin = createPluginContext(ctx, {
    manifest: manifestOf(PLUGIN_ID, ['missions:read']),
    version: '1.0.0',
  }, daemonHost(root));
  try {
    assert.equal(plugin.caller(), undefined, 'a job has no caller');
    assert.equal(runPluginRequest(adaIdentity(), () => plugin.caller()), undefined, 'a callback for an account has none either');
    const first = runPluginRequest({ ...adaIdentity(), caller: { kind: 'person' } }, () => plugin.caller());
    assert.deepEqual(first, { kind: 'person' });
    if (first) (first as { kind: string }).kind = 'mission';
    assert.deepEqual(runPluginRequest({ ...adaIdentity(), caller: { kind: 'person' } }, () => plugin.caller()), { kind: 'person' });
  } finally {
    await dispose();
    await root.fiber.dispose();
  }
});

test('the caller of each credential: a session or a device is a person, a mission token a mission, the rest a service', () => {
  const user = { id: 'ada', email: 'ada@example.com', name: 'Ada', is_superadmin: true };
  const of = (auth: unknown) => identityFromRequest({ auth } as Parameters<typeof identityFromRequest>[0]).caller;
  assert.deepEqual(of({ kind: 'session', user, isSuperadmin: true }), { kind: 'person' });
  assert.deepEqual(of({ kind: 'device', user, isSuperadmin: true, deviceId: 'd' }), { kind: 'person' });
  assert.deepEqual(of({ kind: 'api-token', user, isSuperadmin: true, permissions: ['*'], missionId: 'm' }), { kind: 'mission' });
  assert.deepEqual(of({ kind: 'api-token', user: null, isSuperadmin: false, actorId: 'plugin:x', permissions: [] }), { kind: 'service' });
  assert.deepEqual(of({ kind: 'daemon-token', user, isSuperadmin: true }), { kind: 'service' });
  assert.equal(of(undefined), undefined, 'the anonymous request of a machine with no account has no caller');
});
