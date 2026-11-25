/**
 * The three levels of the Providers screen (`users/provider-access.ts`), on
 * every route behind it: overview, subscription accounts, programs (CLI
 * binaries, the vendors' CLIs, the ACP catalogue, a plugin's program), the
 * backends added by hand and the models. `none` is refused everywhere,
 * `accounts` everywhere but the overview (narrowed) and its own accounts,
 * `full` like the superadmin.
 */
import { createTestAccount, grantTestPermissions } from '../../../tests/helpers/accounts.js';
import '../../test-home.js';
import '../../../tests/helpers/paid-license.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import type { RequestAuth } from '../../users/identity.js';

const { dbApi } = await import('../../db.js');
const { createDaemonAuthMiddleware } = await import('../http/auth.js');
const { createBodyParser } = await import('../../kernel/body-parser.js');
const { attachPluginLoader } = await import('../../plugins/runtime.js');
const { createBackendAccount, grantBackendAccount } = await import('../../backends/accounts.js');
const { registerProviderOverviewRoutes } = await import('./provider-overview-routes.js');
const { registerAccountRoutes } = await import('./account-routes.js');
const { registerBinaryRoutes } = await import('./binary-routes.js');
const { registerProviderCliRoutes } = await import('./provider-cli-routes.js');
const { registerCustomBackendRoutes } = await import('./custom-routes.js');
const { registerAcpRegistryRoutes } = await import('../plugins/acp-registry-routes.js');
const { registerProviderRoutes } = await import('../plugins/provider-routes.js');
const { orchestratorRoot, readBuiltinList } = await import('../../plugins/builtin.js');
const { readManifest } = await import('../../plugins/manifest.js');
const { mountOfficialProviders } = await import('../../../tests/helpers/official-providers.js');
await mountOfficialProviders();

const DAEMON = 'daemon-provider-access-token';
function user(name: string, superadmin: boolean) {
  const id = randomUUID();
  return createTestAccount(dbApi, { id, email: `${name}-${id}@example.test`, name, passwordHash: 'x', isSuperadmin: superadmin });
}
const admin = user('admin', true);
const full = user('full', false);
const own = user('own', false);
const hidden = user('hidden', false);
grantTestPermissions(dbApi, full.id, ['providers:manage']);
grantTestPermissions(dbApi, own.id, ['providers:accounts']);
// Everything else, but not this screen: no other grant opens it.
grantTestPermissions(dbApi, hidden.id, ['settings', 'settings:write', 'plugins:manage', 'agents:manage', 'secrets:manage']);

const IDENTITIES: Record<string, RequestAuth> = {
  admin: { kind: 'session', user: admin, isSuperadmin: true },
  full: { kind: 'session', user: full, isSuperadmin: false },
  own: { kind: 'session', user: own, isSuperadmin: false },
  hidden: { kind: 'session', user: hidden, isSuperadmin: false },
};
type Caller = keyof typeof IDENTITIES | 'anonymous';

const ownAccount = createBackendAccount({ backend: 'claude', name: 'Own work', ownerUserId: own.id });
const adminAccount = createBackendAccount({ backend: 'claude', name: 'Admin pro', ownerUserId: admin.id });
const granted = createBackendAccount({ backend: 'claude', name: 'Shared team', ownerUserId: admin.id });
grantBackendAccount(granted.id, own.id, admin.id);

const app = express();
// The providers shipped in the release, as the loader lists them: `provider-claude` is one of them.
const root = orchestratorRoot();
const official = readBuiltinList(root).flatMap(({ source }) => {
  const res = readManifest(JSON.parse(readFileSync(join(resolve(root, source), 'package.json'), 'utf8')) as Record<string, unknown>);
  if (!res.ok || !res.manifest.kind.includes('provider')) return [];
  return [{ id: res.manifest.id, pkg: res.manifest.id, dir: '', version: '0.1.0', state: 'active', reason: null, error: null, signed: true, manifest: res.manifest, builtin: true }];
});
attachPluginLoader(app, { list: () => official } as never);
app.use((req, res, next) => {
  const as = req.header('x-test-as');
  if (as && IDENTITIES[as]) { req.auth = IDENTITIES[as]; next(); return; }
  createDaemonAuthMiddleware({ token: DAEMON, required: true })(req, res, next);
});
app.use(createBodyParser());
registerProviderOverviewRoutes(app, { acpAgents: async () => [] });
registerAccountRoutes(app);
registerBinaryRoutes(app);
registerProviderCliRoutes(app);
registerCustomBackendRoutes(app);
registerAcpRegistryRoutes(app);
registerProviderRoutes(app);
const server: Server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
test.after(() => { server.closeAllConnections(); server.close(); });

async function call(method: string, path: string, as: Caller, body?: unknown) {
  const headers: Record<string, string> = {};
  if (as !== 'anonymous') headers['x-test-as'] = as;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${base}${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await res.text();
  let json: unknown = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, json, text };
}

/** Setting or removing a program's path: a superadmin in a session, beyond any level of the screen. */
const PINNING = new Set(['PUT /api/host/binaries/claude', 'DELETE /api/host/binaries/claude']);

/** Routes of the sections other than Connection, and of adding a provider. Cheap to call: no network, no install. */
const FULL_ONLY: readonly [string, string, unknown?][] = [
  ['GET', '/api/host/binaries'],
  ['POST', '/api/host/binaries/recheck', {}],
  ['PUT', '/api/host/binaries/claude', { path: '/nowhere/claude' }],
  ['DELETE', '/api/host/binaries/claude'],
  ['GET', '/api/host/provider-clis'],
  ['POST', '/api/host/provider-clis/claude/install', {}],
  ['GET', '/api/backends/custom'],
  ['POST', '/api/backends/custom', { id: 'acme', label: 'Acme' }],
  ['DELETE', '/api/backends/custom/acme'],
  ['GET', '/api/backends/manage'],
  ['PATCH', '/api/backends/manage/claude', { enabled: false }],
  ['POST', '/api/uploads/backends', {}],
  ['GET', '/api/plugins/-/providers'],
  ['POST', '/api/plugins/-/providers/acme-provider/authorize', { paths: [] }],
  ['GET', '/api/plugins/-/providers/acp-registry'],
  ['POST', '/api/plugins/-/providers/acp-registry/install', { agentId: 'acme' }],
  ['POST', '/api/plugins/-/providers/acp-registry/acme/auth-methods', {}],
  ['DELETE', '/api/plugins/-/providers/acp-registry/acme'],
];
const CONNECTION: readonly [string, string, unknown?][] = [
  ['GET', '/api/providers/overview'],
  ['GET', '/api/providers/overview/provider-claude'],
  ['GET', '/api/backends/accounts'],
  ['POST', '/api/backends/accounts', { backend: 'claude', name: 'Probe' }],
  ['PATCH', `/api/backends/accounts/${ownAccount.id}`, { name: 'Own work' }],
  ['DELETE', '/api/backends/accounts/no-such-account'],
  ['POST', `/api/backends/accounts/${ownAccount.id}/login`, {}],
];

test('an anonymous request is refused on every route of the screen', async () => {
  for (const [method, path, body] of [...FULL_ONLY, ...CONNECTION]) {
    assert.equal((await call(method, path, 'anonymous', body)).status, 401, `${method} ${path}`);
  }
});

test('hidden: refused everywhere, whatever else the account holds', async () => {
  for (const [method, path, body] of [...FULL_ONLY, ...CONNECTION]) {
    const res = await call(method, path, 'hidden', body);
    assert.equal(res.status, 403, `${method} ${path}`);
  }
  // Refused before anything is written.
  assert.equal((await call('GET', '/api/backends/accounts', 'admin')).text.includes('Probe'), false);
});

test('own accounts: refused on every section but Connection', async () => {
  for (const [method, path, body] of FULL_ONLY) {
    const res = await call(method, path, 'own', body);
    assert.equal(res.status, 403, `${method} ${path}`);
    const refusal = res.json as { code?: string; permission?: unknown };
    if (PINNING.has(`${method} ${path}`)) {
      // Choosing the program the daemon runs is the superadmin's, whatever the level.
      assert.equal(refusal.code, 'operator_only', `${method} ${path}`);
      continue;
    }
    assert.equal(refusal.code, 'account_lacks_permission', `${method} ${path}`);
    assert.equal(refusal.permission, 'providers:manage', `${method} ${path}`);
  }
});

test('full access: pinning or unpinning a program stays the superadmin\'s', async () => {
  for (const [method, path, body] of FULL_ONLY.filter(([m, p]) => PINNING.has(`${m} ${p}`))) {
    const res = await call(method, path, 'full', body);
    assert.equal(res.status, 403, `${method} ${path}`);
    assert.equal((res.json as { code?: string }).code, 'operator_only', `${method} ${path}`);
  }
});

test('own accounts: the overview without anything of this machine, and only its own accounts', async () => {
  const res = await call('GET', '/api/providers/overview', 'own');
  assert.equal(res.status, 200);
  type Account = { id: string; mine: boolean };
  type Provider = {
    id: string; programs: unknown[]; secret: { names: string[] };
    connection: { signInCommand: string | null; signedIn: boolean | null; accounts: Account[] };
  };
  const providers = (res.json as { providers: Provider[] }).providers;
  const claude = providers.find((p) => p.id === 'provider-claude');
  assert.ok(claude, 'the list is read');
  assert.ok(providers.every((p) => p.programs.length === 0 && p.secret.names.length === 0), 'no program, no path, no vault name');
  assert.equal(claude.connection.signInCommand, null, 'the sign-in of this computer is the operator\'s');
  assert.equal(claude.connection.signedIn, null);
  assert.deepEqual(claude.connection.accounts.map((a) => a.id), [ownAccount.id], 'neither a granted account nor anyone else\'s');

  const one = await call('GET', '/api/providers/overview/provider-claude', 'own');
  assert.equal(one.status, 200);
  assert.deepEqual((one.json as { provider: Provider }).provider.programs, []);

  // The superadmin and the full level read the machine.
  for (const as of ['admin', 'full'] as const) {
    const wide = (await call('GET', '/api/providers/overview/provider-claude', as)).json as { provider: Provider };
    assert.ok(wide.provider.programs.length > 0, as);
    assert.notEqual(wide.provider.connection.signInCommand, null, as);
  }
});

test('own accounts: lists, adds, renames and deletes its own accounts, nobody else\'s', async () => {
  const listed = (await call('GET', '/api/backends/accounts', 'own')).json as { accounts: { id: string }[] };
  assert.deepEqual(listed.accounts.map((a) => a.id), [ownAccount.id]);

  const created = await call('POST', '/api/backends/accounts', 'own', { backend: 'claude', name: 'Second' });
  assert.equal(created.status, 201);
  const id = (created.json as { account: { id: string; ownerUserId: string } }).account.id;
  assert.equal((created.json as { account: { ownerUserId: string } }).account.ownerUserId, own.id);
  assert.equal((await call('PATCH', `/api/backends/accounts/${id}`, 'own', { name: 'Renamed' })).status, 200);
  assert.equal((await call('DELETE', `/api/backends/accounts/${id}`, 'own')).status, 200);

  // Someone else's: neither for another owner, nor on the superadmin's, nor on one granted to it.
  assert.equal((await call('POST', '/api/backends/accounts', 'own', { backend: 'claude', name: 'X', ownerUserId: admin.id })).status, 403);
  assert.equal((await call('PATCH', `/api/backends/accounts/${adminAccount.id}`, 'own', { name: 'Mine now' })).status, 404);
  assert.equal((await call('DELETE', `/api/backends/accounts/${adminAccount.id}`, 'own')).status, 404);
  assert.equal((await call('PATCH', `/api/backends/accounts/${granted.id}`, 'own', { name: 'Mine now' })).status, 403);
  assert.equal((await call('DELETE', `/api/backends/accounts/${granted.id}`, 'own')).status, 403);
  assert.equal((await call('PUT', `/api/backends/accounts/${ownAccount.id}/grants`, 'own', { userIds: [] })).status, 403);
});

test('full access: the sections the own level is refused', async () => {
  for (const path of ['/api/host/binaries', '/api/backends/custom', '/api/backends/manage', '/api/plugins/-/providers']) {
    assert.equal((await call('GET', path, 'full')).status, 200, path);
  }
  // Its accounts stay its own: another person's subscription is the superadmin's to see.
  const listed = (await call('GET', '/api/backends/accounts', 'full')).json as { accounts: { id: string }[] };
  assert.equal(listed.accounts.some((a) => a.id === adminAccount.id), false);
});
