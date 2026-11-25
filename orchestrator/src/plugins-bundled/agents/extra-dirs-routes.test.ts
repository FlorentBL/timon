/**
 * `/api/agents/:name/extra-dirs` (TODO #505): who may give an agent folders
 * outside its working directory, and which folders.
 *
 * The access control first: an anonymous caller is refused whether or not
 * auth is required, a mission without `agents:privileged-config` is refused,
 * and no mission changes its own agent's folders. Then the folders: the Timon
 * home, its ancestors and a missing folder are refused with the reason, and
 * no other agent write (config PATCH, creation, prompt rewrite) sets or drops
 * the list. Real auth middleware, isolated TIMON_HOME, witness on :0.
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { grantTestPermissions, postTestAccount } from '../../../tests/helpers/accounts.js';
import { cli, session } from '../../../tests/helpers/mcp-cli-parity.js';

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-extra-dirs-'));
await import('../../../tests/helpers/paid-license.js');
await import('../../../tests/helpers/claude-provider.js');
process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';
const TOKEN = 'witness-daemon-token';
writeFileSync(join(process.env.TIMON_HOME, 'daemon-token'), TOKEN, { encoding: 'utf8', mode: 0o600 });

const { createDaemonAuthMiddleware } = await import('../http/auth.js');
const { registerRoutes: registerUserRoutes } = await import('../users/routes.js');
const { registerRoutes: registerAgentRoutes } = await import('./routes.js');
const { dbApi } = await import('../../db.js');
const { issueMissionApiToken } = await import('../../users/api-tokens.js');
const { agentConfig } = await import('../../paths.js');

async function serve(required: boolean): Promise<{ base: string; close: () => void }> {
  const app = express();
  app.use(createDaemonAuthMiddleware({ token: TOKEN, required }));
  app.use(express.json());
  registerUserRoutes(app, { setupPolicy: 'free' });
  registerAgentRoutes(app);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  assert.notEqual(port, 3001, 'the witness must not take the production port');
  return { base: `http://127.0.0.1:${port}`, close: () => { server.close(); } };
}

const strict = await serve(true);
const open = await serve(false);
test.after(() => { strict.close(); open.close(); });

type Result = { status: number; json: Record<string, unknown> };

async function call(method: string, path: string, opts: { body?: unknown; bearer?: string; base?: string } = {}): Promise<Result> {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (opts.bearer) headers.authorization = `Bearer ${opts.bearer}`;
  const res = await fetch(`${opts.base ?? strict.base}${path}`, {
    method,
    headers,
    ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
  });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try { json = text ? JSON.parse(text) as Record<string, unknown> : {}; } catch { json = { raw: text }; }
  return { status: res.status, json };
}

const ok = (r: Result): void => assert.equal(r.status, 200, JSON.stringify(r.json));
const dirsOf = (r: Result) => r.json.extra_dirs as Array<{ path: string; mode: string }>;
const storedOf = (agent: string): unknown => (JSON.parse(readFileSync(agentConfig(agent), 'utf8')) as { extra_dirs?: unknown }).extra_dirs;

const setup = await call('POST', '/api/auth/setup', { body: { email: 'admin@example.com', name: 'Admin', password: 'admin-secret' } });
assert.equal(setup.status, 201);
const adminId = (setup.json as { user: { id: string } }).user.id;
const made = await postTestAccount(dbApi, { email: 'mgr@example.com', name: 'Manager', password: 'mgr-secret' });
assert.equal(made.status, 201);
const managerId = (made.json as { user: { id: string } }).user.id;
grantTestPermissions(dbApi, managerId, ['agents:manage', 'agents:read', 'missions:read']);

function missionToken(agent: string, userId: string): string {
  const id = randomUUID();
  dbApi.createMission(id, agent, 'work', undefined, userId);
  return issueMissionApiToken(id);
}

for (const name of ['lib.reader', 'lib.helper', 'lib.manager']) {
  ok(await call('POST', '/api/agents', { bearer: TOKEN, body: { name, system_prompt: 'p', config: { role: 'coder' } } }));
}
const adminMission = missionToken('lib.helper', adminId);
const managerMission = missionToken('lib.manager', managerId);
const readerOwnMission = missionToken('lib.reader', adminId);

const projects = mkdtempSync(join(tmpdir(), 'timon-extra-dirs-projects-'));
const notes = mkdtempSync(join(tmpdir(), 'timon-extra-dirs-notes-'));
const ROUTE = '/api/agents/lib.reader/extra-dirs';

test('an anonymous caller is refused on every verb, whether or not auth is required', async () => {
  for (const base of [strict.base, open.base]) {
    assert.equal((await call('GET', ROUTE, { base })).status, 401);
    assert.equal((await call('POST', ROUTE, { base, body: { path: projects, mode: 'read' } })).status, 401);
    assert.equal((await call('PUT', ROUTE, { base, body: { extra_dirs: [] } })).status, 401);
    assert.equal((await call('DELETE', ROUTE, { base, body: { path: projects } })).status, 401);
  }
  assert.equal((await call('POST', ROUTE, { bearer: 'wrong-token', body: { path: projects, mode: 'read' } })).status, 401);
  assert.equal(storedOf('lib.reader'), undefined);
});

test('a mission without agents:privileged-config cannot give an agent folders', async () => {
  const r = await call('POST', ROUTE, { bearer: managerMission, body: { path: projects, mode: 'write' } });
  assert.equal(r.status, 403, JSON.stringify(r.json));
  assert.match(String(r.json.reason ?? ''), /agents:privileged-config/);
  assert.equal(storedOf('lib.reader'), undefined);
  // Reading is open to `agents:read`.
  ok(await call('GET', ROUTE, { bearer: managerMission }));
});

test('no mission changes the folders of its own agent, whatever its account holds', async () => {
  const r = await call('POST', ROUTE, { bearer: readerOwnMission, body: { path: projects, mode: 'write' } });
  assert.equal(r.status, 403, JSON.stringify(r.json));
  assert.match(String(r.json.reason ?? ''), /its own missions/);
  assert.equal(storedOf('lib.reader'), undefined);
});

test('the agent_extra_dirs tool and `timon agent extra-dirs` meet the same guard as the route', async () => {
  const tool = (token: string, args: Record<string, unknown>) => session(strict.base, [
    { method: 'tools/call', params: { name: 'agent_extra_dirs', arguments: { name: 'lib.reader', ...args } } },
  ], true, { TIMON_API_TOKEN: token });
  // An account without agents:privileged-config reads, but changes nothing.
  const [listed] = await tool(managerMission, {});
  assert.notEqual(listed!.result?.isError, true, listed!.result?.content?.[0]?.text);
  const [denied] = await tool(managerMission, { action: 'add', path: projects, mode: 'write' });
  assert.equal(denied!.result?.isError, true);
  assert.match(String(denied!.result?.content?.[0]?.text), /agents:privileged-config/);
  const [removal] = await tool(managerMission, { action: 'remove', path: projects });
  assert.equal(removal!.result?.isError, true);
  const fromCli = await cli(strict.base, ['agent', 'extra-dirs', 'add', 'lib.reader', projects, '--write'], { TIMON_API_TOKEN: managerMission });
  assert.equal(fromCli.code, 2, fromCli.out);
  assert.match(fromCli.out, /403/);
  // Its own agent stays out of reach, whatever the account holds.
  const [own] = await tool(readerOwnMission, { action: 'add', path: projects, mode: 'read' });
  assert.equal(own!.result?.isError, true);
  assert.match(String(own!.result?.content?.[0]?.text), /its own missions/);
  assert.equal(storedOf('lib.reader'), undefined);
});

test('a person adds, changes and removes a folder; the list is normalised', async () => {
  let r = await call('POST', ROUTE, { bearer: TOKEN, body: { path: projects, mode: 'read' } });
  ok(r);
  assert.deepEqual(dirsOf(r), [{ path: projects, mode: 'read' }]);
  assert.deepEqual(r.json.dropped, []);
  assert.equal(r.json.restarted, 0);
  r = await call('POST', ROUTE, { bearer: TOKEN, body: { path: `${projects}/`, mode: 'write' } });
  ok(r);
  assert.deepEqual(dirsOf(r), [{ path: projects, mode: 'write' }], 'the same folder changes mode, no duplicate');
  r = await call('POST', ROUTE, { bearer: TOKEN, body: { path: notes, mode: 'read' } });
  ok(r);
  assert.deepEqual(storedOf('lib.reader'), [{ path: projects, mode: 'write' }, { path: notes, mode: 'read' }]);
  r = await call('DELETE', ROUTE, { bearer: TOKEN, body: { path: projects } });
  ok(r);
  assert.deepEqual(dirsOf(r), [{ path: notes, mode: 'read' }]);
  r = await call('GET', ROUTE, { bearer: TOKEN });
  ok(r);
  assert.deepEqual(dirsOf(r), [{ path: notes, mode: 'read' }]);
  assert.equal(r.json.running, 0);
});

test('a mission of a privileged account may set another agent\'s folders', async () => {
  const r = await call('PUT', ROUTE, { bearer: adminMission, body: { extra_dirs: [{ path: notes, mode: 'write' }] } });
  ok(r);
  assert.deepEqual(dirsOf(r), [{ path: notes, mode: 'write' }]);
});

test('the Timon home, its ancestors, a missing folder and a relative path are refused with the reason', async () => {
  const home = process.env.TIMON_HOME!;
  mkdirSync(join(home, 'workspace', 'shared'), { recursive: true });
  const cases: Array<[string, RegExp]> = [
    [join(home, 'workspace', 'shared'), /Timon home/],
    [home, /Timon home/],
    [dirname(home), /Timon home/],
    [join(notes, 'gone'), /does not exist/],
    ['relative/folder', /absolute/],
  ];
  for (const [path, reason] of cases) {
    const r = await call('POST', ROUTE, { bearer: TOKEN, body: { path, mode: 'read' } });
    assert.equal(r.status, 400, `${path}: ${JSON.stringify(r.json)}`);
    assert.equal(r.json.code, 'extra_dir_refused');
    assert.match(String(r.json.error), reason, path);
  }
  const bad = await call('POST', ROUTE, { bearer: TOKEN, body: { path: notes, mode: 'admin' } });
  assert.equal(bad.status, 400);
  assert.deepEqual(storedOf('lib.reader'), [{ path: notes, mode: 'write' }], 'a refusal leaves the list as it was');
});

test('no other agent write sets or drops the folders', async () => {
  // The config PATCH ignores the key.
  ok(await call('PATCH', '/api/agents/lib.reader/config', { bearer: TOKEN, body: { extra_dirs: [{ path: projects, mode: 'write' }], model: 'opus' } }));
  assert.deepEqual(storedOf('lib.reader'), [{ path: notes, mode: 'write' }]);
  // A full rewrite (agent_update with a new prompt) keeps them.
  ok(await call('POST', '/api/agents', { bearer: TOKEN, body: { name: 'lib.reader', system_prompt: 'new prompt', config: { role: 'coder' } } }));
  assert.deepEqual(storedOf('lib.reader'), [{ path: notes, mode: 'write' }]);
  // A creation cannot bring any.
  ok(await call('POST', '/api/agents', { bearer: TOKEN, body: { name: 'lib.fresh', system_prompt: 'p', config: { role: 'coder', extra_dirs: [{ path: projects, mode: 'write' }] } } }));
  assert.equal(storedOf('lib.fresh'), undefined);
  // The agent list shows them to a reader.
  const list = await call('GET', '/api/agents', { bearer: TOKEN });
  const reader = (list.json.agents as Array<{ name: string; extra_dirs: unknown }>).find((a) => a.name === 'lib.reader');
  assert.deepEqual(reader?.extra_dirs, [{ path: notes, mode: 'write' }]);
});

test('an unknown agent is a 404', async () => {
  assert.equal((await call('GET', '/api/agents/nobody-here/extra-dirs', { bearer: TOKEN })).status, 404);
  assert.equal((await call('POST', '/api/agents/nobody-here/extra-dirs', { bearer: TOKEN, body: { path: notes, mode: 'read' } })).status, 404);
});
