/**
 * `/api/projects/:slug/extra-dirs` (TODO #1168): who may give a project
 * folders outside its working directories, and which folders.
 *
 * Access first: an anonymous caller is refused on every verb whether or not
 * auth is required, and so are the daemon token and a mission token (an agent
 * never opens a folder to its project), and a person without
 * `agents:privileged-config`. Then the folders: the Timon home, its ancestors
 * and a missing folder are refused with the reason, a project meta edit never
 * reaches the list, and a launch merges the project's folders with the
 * agent's. Real auth middleware, isolated TIMON_HOME, witness on :0.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { grantTestPermissions, postTestAccount } from '../../../tests/helpers/accounts.js';

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-project-extra-dirs-'));
await import('../../../tests/helpers/paid-license.js');
await import('../../../tests/helpers/claude-provider.js');
process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';
const TOKEN = 'witness-daemon-token';
writeFileSync(join(process.env.TIMON_HOME, 'daemon-token'), TOKEN, { encoding: 'utf8', mode: 0o600 });

const { createDaemonAuthMiddleware } = await import('../http/auth.js');
const { registerRoutes: registerUserRoutes } = await import('../users/routes.js');
const { registerRoutes: registerAgentRoutes } = await import('../agents/routes.js');
const { registerRoutes: registerProjectRoutes } = await import('./routes.js');
const { registerProjectExtraDirsRoutes } = await import('./extra-dirs-routes.js');
const { dbApi } = await import('../../db.js');
const { SESSION_COOKIE } = await import('../../users/session.js');
const { issueMissionApiToken } = await import('../../users/api-tokens.js');
const { TIMON_HOME } = await import('../../paths.js');
const { createProject } = await import('../../projects.js');
const { mergeExtraDirs, missionExtraDirs, projectExtraDirs } = await import('../../project-extra-dirs.js');

async function serve(required: boolean): Promise<{ base: string; close: () => void }> {
  const app = express();
  app.use(createDaemonAuthMiddleware({ token: TOKEN, required }));
  app.use(express.json());
  registerUserRoutes(app, { setupPolicy: 'free' });
  registerAgentRoutes(app);
  registerProjectRoutes(app);
  registerProjectExtraDirsRoutes(app);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  assert.notEqual(port, 3001, 'the witness must not take the production port');
  return { base: `http://127.0.0.1:${port}`, close: () => { server.close(); } };
}

const strict = await serve(true);
const open = await serve(false);
test.after(() => { strict.close(); open.close(); });

type Result = { status: number; json: Record<string, unknown>; res: Response };

async function call(method: string, path: string, opts: { body?: unknown; bearer?: string; cookie?: string; base?: string } = {}): Promise<Result> {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (opts.bearer) headers.authorization = `Bearer ${opts.bearer}`;
  if (opts.cookie) headers.cookie = `${SESSION_COOKIE}=${encodeURIComponent(opts.cookie)}`;
  const res = await fetch(`${opts.base ?? strict.base}${path}`, {
    method,
    headers,
    ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
  });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try { json = text ? JSON.parse(text) as Record<string, unknown> : {}; } catch { json = { raw: text }; }
  return { status: res.status, json, res };
}

function sessionCookie(res: Response): string {
  for (const line of res.headers.getSetCookie()) {
    const match = new RegExp(`(?:^|,\\s*)${SESSION_COOKIE}=([^;]+)`).exec(line);
    if (match?.[1]) return decodeURIComponent(match[1]);
  }
  throw new Error('no session cookie');
}

const ok = (r: Result): void => assert.equal(r.status, 200, JSON.stringify(r.json));
const dirsOf = (r: Result) => r.json.extra_dirs as Array<{ path: string; mode: string }>;

const setup = await call('POST', '/api/auth/setup', { body: { email: 'admin@example.com', name: 'Admin', password: 'admin-secret' } });
assert.equal(setup.status, 201);
const adminCookie = sessionCookie(setup.res);
const adminId = dbApi.getUserByEmail('admin@example.com')!.id;
await postTestAccount(dbApi, { email: 'mgr@example.com', name: 'Manager', password: 'mgr-secret' });
const managerId = dbApi.getUserByEmail('mgr@example.com')!.id;
grantTestPermissions(dbApi, managerId, ['projects:manage', 'projects:read', 'agents:read']);
const managerCookie = sessionCookie((await call('POST', '/api/auth/login', { body: { email: 'mgr@example.com', password: 'mgr-secret' } })).res);

createProject('lib', { name: 'Library' });
ok(await call('POST', '/api/agents', { bearer: TOKEN, body: { name: 'lib.coder', system_prompt: 'p', config: { role: 'coder', project: 'lib' } } }));

function missionToken(agent: string, userId: string): string {
  const id = randomUUID();
  dbApi.createMission(id, agent, 'work', undefined, userId);
  return issueMissionApiToken(id);
}

const data = mkdtempSync(join(tmpdir(), 'timon-project-extra-dirs-data-'));
const repo = mkdtempSync(join(tmpdir(), 'timon-project-extra-dirs-repo-'));
const ROUTE = '/api/projects/lib/extra-dirs';

test('an anonymous caller is refused on every verb, whether or not auth is required', async () => {
  for (const base of [strict.base, open.base]) {
    assert.equal((await call('GET', ROUTE, { base })).status, 401);
    assert.equal((await call('POST', ROUTE, { base, body: { path: data, mode: 'read' } })).status, 401);
    assert.equal((await call('PUT', ROUTE, { base, body: { extra_dirs: [] } })).status, 401);
    assert.equal((await call('DELETE', ROUTE, { base, body: { path: data } })).status, 401);
  }
  assert.equal((await call('POST', ROUTE, { bearer: 'wrong-token', body: { path: data, mode: 'read' } })).status, 401);
  assert.deepEqual(projectExtraDirs('lib'), []);
});

test('an agent never opens a folder to a project: mission tokens and the daemon token are refused', async () => {
  // The admin's account holds every permission, agents:privileged-config included.
  const fromProject = missionToken('lib.coder', adminId);
  for (const bearer of [fromProject, TOKEN]) {
    for (const [method, body] of [['POST', { path: data, mode: 'write' }], ['PUT', { extra_dirs: [{ path: data, mode: 'write' }] }], ['DELETE', { path: data }]] as const) {
      const r = await call(method, ROUTE, { bearer, body });
      assert.equal(r.status, 403, `${method}: ${JSON.stringify(r.json)}`);
    }
  }
  assert.deepEqual(projectExtraDirs('lib'), []);
  // Reading stays open to a holder of projects:read, a mission included.
  ok(await call('GET', ROUTE, { bearer: fromProject }));
});

test('a person without agents:privileged-config cannot open a folder to a project', async () => {
  const r = await call('POST', ROUTE, { cookie: managerCookie, body: { path: data, mode: 'read' } });
  assert.equal(r.status, 403, JSON.stringify(r.json));
  assert.match(String(r.json.reason ?? ''), /agents:privileged-config/);
  assert.deepEqual(projectExtraDirs('lib'), []);
  ok(await call('GET', ROUTE, { cookie: managerCookie }));
});

test('a person adds, changes and removes a folder; the list is normalised', async () => {
  let r = await call('POST', ROUTE, { cookie: adminCookie, body: { path: data, mode: 'read' } });
  ok(r);
  assert.deepEqual(dirsOf(r), [{ path: data, mode: 'read' }]);
  assert.deepEqual(r.json.dropped, []);
  r = await call('POST', ROUTE, { cookie: adminCookie, body: { path: `${data}/`, mode: 'write' } });
  ok(r);
  assert.deepEqual(dirsOf(r), [{ path: data, mode: 'write' }], 'the same folder changes mode, no duplicate');
  r = await call('POST', ROUTE, { cookie: adminCookie, body: { path: repo, mode: 'read' } });
  ok(r);
  assert.deepEqual(projectExtraDirs('lib'), [{ path: data, mode: 'write' }, { path: repo, mode: 'read' }]);
  r = await call('DELETE', ROUTE, { cookie: adminCookie, body: { path: repo } });
  ok(r);
  assert.deepEqual(projectExtraDirs('lib'), [{ path: data, mode: 'write' }]);
  r = await call('GET', ROUTE, { cookie: adminCookie });
  ok(r);
  assert.deepEqual(dirsOf(r), [{ path: data, mode: 'write' }]);
});

test('the Timon home, an ancestor of it and a missing folder are refused with the reason', async () => {
  const before = projectExtraDirs('lib');
  for (const path of [TIMON_HOME, join(TIMON_HOME, 'agents'), dirname(TIMON_HOME), join(data, 'missing')]) {
    mkdirSync(join(TIMON_HOME, 'agents'), { recursive: true });
    const r = await call('POST', ROUTE, { cookie: adminCookie, body: { path, mode: 'read' } });
    assert.equal(r.status, 400, `${path}: ${JSON.stringify(r.json)}`);
    assert.equal(r.json.code ?? r.json.error, 'extra_dir_refused');
  }
  assert.deepEqual(projectExtraDirs('lib'), before);
});

test('an unknown project is a 404, and a malformed body a 400', async () => {
  assert.equal((await call('GET', '/api/projects/nope/extra-dirs', { cookie: adminCookie })).status, 404);
  assert.equal((await call('POST', '/api/projects/nope/extra-dirs', { cookie: adminCookie, body: { path: data, mode: 'read' } })).status, 404);
  assert.equal((await call('POST', ROUTE, { cookie: adminCookie, body: { path: data, mode: 'all' } })).status, 400);
  assert.equal((await call('PUT', ROUTE, { cookie: adminCookie, body: { extra_dirs: [], extra: 1 } })).status, 400);
});

test('a project meta edit never reaches the list', async () => {
  const before = projectExtraDirs('lib');
  const r = await call('PUT', '/api/projects/lib/meta', { bearer: TOKEN, body: { name: 'Library 2', extra_dirs: [{ path: repo, mode: 'write' }] } });
  assert.ok(r.status < 500, JSON.stringify(r.json));
  assert.deepEqual(projectExtraDirs('lib'), before);
});

test('a launch merges the agent\'s and the project\'s folders, write winning', async () => {
  ok(await call('POST', '/api/agents/lib.coder/extra-dirs', { bearer: TOKEN, body: { path: data, mode: 'read' } }));
  ok(await call('POST', ROUTE, { cookie: adminCookie, body: { path: repo, mode: 'read' } }));
  const dirs = missionExtraDirs('lib.coder', 'lib');
  assert.deepEqual(new Map(dirs.map((d) => [d.path, d.mode])), new Map([[data, 'write'], [repo, 'read']]));
  assert.deepEqual(missionExtraDirs('lib.coder', null), [{ path: data, mode: 'read' }], 'no project, the agent\'s alone');
  assert.deepEqual(
    mergeExtraDirs([{ path: join(data, 'a'), mode: 'write' }], [{ path: `${join(data, 'a')}/`, mode: 'read' }, { path: repo, mode: 'read' }]),
    [{ path: resolve(data, 'a'), mode: 'write' }, { path: resolve(repo), mode: 'read' }],
  );
});
