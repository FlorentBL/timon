/**
 * TODO #1094: a task whose mission waits on an Allow / Deny card said nothing of
 * it in `timon task get`, `timon status`, `kanban_get` or `mission_status`. The
 * task and mission details now carry the card's tool and clock, never its
 * command, input or files.
 */
import './test-home.js';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import express from 'express';
import { grantTestPermissions, postTestAccount } from '../tests/helpers/accounts.js';

process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';
await import('../tests/helpers/paid-license.js');
await import('../tests/helpers/claude-provider.js');
const { requestPermission, listPending, resolvePermission, pendingPermissionSummary, pendingPermissionSummaries } = await import('./permissions.js');
const { db, dbApi } = await import('./db.js');
const { createDaemonAuthMiddleware } = await import('./plugins-bundled/http/auth.js');
const { registerRoutes: registerUserRoutes } = await import('./plugins-bundled/users/routes.js');
const { SESSION_COOKIE } = await import('./users/session.js');
const kanban = await import('./plugins-bundled/kanban/routes.js');
const missions = await import('./plugins-bundled/missions/routes.js');

const MIN = 60_000;
const SECRET = 'curl -H "Authorization: Bearer s3cr3t-witness" https://example.invalid';

// The real auth middleware: the field is checked behind the same gate as production.
const app = express();
app.use(createDaemonAuthMiddleware({ token: 'witness-daemon-token', required: true }));
app.use(express.json());
registerUserRoutes(app, { setupPolicy: 'free' });
kanban.registerRoutes(app);
missions.registerRoutes(app);
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
after(() => server.close());
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

async function call(method: string, path: string, opts: { cookie?: string; body?: unknown } = {}): Promise<Response> {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (opts.cookie) headers.cookie = `${SESSION_COOKIE}=${encodeURIComponent(opts.cookie)}`;
  return fetch(`${base}${path}`, { method, headers, ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }) });
}

function sessionCookie(res: Response): string {
  for (const line of res.headers.getSetCookie()) {
    const match = new RegExp(`(?:^|,\\s*)${SESSION_COOKIE}=([^;]+)`).exec(line);
    if (match?.[1]) return decodeURIComponent(match[1]);
  }
  throw new Error('no session cookie');
}

const setup = await call('POST', '/api/auth/setup', { body: { email: 'admin@example.com', name: 'Admin', password: 'admin-secret' } });
assert.equal(setup.status, 201);
const adminCookie = sessionCookie(setup);
const adminId = dbApi.getUserByEmail('admin@example.com')!.id;

async function signIn(name: string, permissions: readonly string[]): Promise<string> {
  const email = `${name}@example.com`;
  const created = await postTestAccount(dbApi, { email, name, password: `${name}-secret` });
  assert.equal(created.status, 201);
  grantTestPermissions(dbApi, created.json.user!.id, [...permissions]);
  return sessionCookie(await call('POST', '/api/auth/login', { body: { email, password: `${name}-secret` } }));
}

/** Reads every task, not the missions behind them. */
const tasksOnly = await signIn('tasks-only', ['kanban:read', 'tasks:read:all']);
/** Reads every task and every mission. */
const both = await signIn('both', ['kanban:read', 'tasks:read:all', 'missions:read:all']);

async function getJson(path: string, cookie = adminCookie): Promise<Record<string, unknown>> {
  const response = await call('GET', path, { cookie });
  assert.equal(response.status, 200, path);
  return await response.json() as Record<string, unknown>;
}

/** An autonomous mission running a task, so its cards arm the short delay. */
function runningTask(): { taskId: string; missionId: string } {
  const taskId = randomUUID(), missionId = randomUUID();
  dbApi.createMission(missionId, 'acme.coder', 'work', { channel: 'routine' }, adminId);
  dbApi.createTask(taskId, 'Waits on a card', 'acme.coder', { ownerUserId: adminId });
  db.prepare("UPDATE tasks SET status = 'IN_PROGRESS', mission_id = ? WHERE id = ?").run(missionId, taskId);
  return { taskId, missionId };
}

function openCard(missionId: string, toolName: string, input: unknown): Promise<unknown> {
  return requestPermission({ mission_id: missionId, agent: 'acme.coder', tool_name: toolName, input, tool_use_id: `tu-${randomUUID()}` });
}

async function closeAll(missionId: string, pending: Promise<unknown>[]): Promise<void> {
  for (const card of listPending(missionId)) resolvePermission(card.id, { behavior: 'deny', message: 'test over' });
  await Promise.all(pending);
}

test('no card, no summary', () => {
  const { missionId } = runningTask();
  assert.equal(pendingPermissionSummary(missionId), null);
  assert.equal(pendingPermissionSummary(null), null);
});

test('the summary names the oldest card, its age and the time left, and counts the others', async () => {
  const { missionId } = runningTask();
  const first = openCard(missionId, 'Bash', { command: SECRET });
  const card = listPending(missionId)[0]!;
  const second = openCard(missionId, 'Write', { file_path: '/tmp/x', content: 'y' });

  const summary = pendingPermissionSummary(missionId, card.created_at + 2 * MIN);
  assert.deepEqual(summary, {
    kind: 'permission',
    tool_name: 'Bash',
    since: card.created_at,
    expires_at: card.created_at + 5 * MIN,
    remaining_ms: 3 * MIN,
    count: 2,
  });
  assert.equal(pendingPermissionSummary(missionId, card.created_at + 9 * MIN)?.remaining_ms, 0, 'never negative');
  await closeAll(missionId, [first, second]);
  assert.equal(pendingPermissionSummary(missionId), null, 'gone once answered');
});

test('a form is a question, and a chat card never expires', async () => {
  const chat = randomUUID();
  dbApi.createMission(chat, 'acme.main', 'hello', { channel: 'chat' });
  const pending = openCard(chat, 'Bash', { command: 'ls' });
  const summary = pendingPermissionSummary(chat);
  assert.equal(summary?.expires_at, null);
  assert.equal(summary?.remaining_ms, null);
  await closeAll(chat, [pending]);

  const form = openCard(chat, 'ask_user', {
    questions: [{ question: 'Which branch?', header: 'branch', options: [{ label: 'main' }, { label: 'dev' }] }],
  });
  assert.equal(pendingPermissionSummary(chat)?.kind, 'question');
  await closeAll(chat, [form]);
});

test('task get, the task list and the mission status carry the summary, not the command', async () => {
  const { taskId, missionId } = runningTask();
  const pending = openCard(missionId, 'Bash', { command: SECRET });

  const detail = (await getJson(`/api/tasks/${taskId}`)).task as Record<string, unknown>;
  const fromDetail = detail.pending_permission as Record<string, unknown>;
  assert.equal(fromDetail.tool_name, 'Bash');
  assert.equal(fromDetail.count, 1);

  const list = (await getJson('/api/tasks')).tasks as Array<Record<string, unknown>>;
  const row = list.find((t) => t.id === taskId);
  assert.equal((row?.pending_permission as { tool_name?: string } | undefined)?.tool_name, 'Bash');

  const status = await getJson(`/api/missions/${missionId}?view=status`);
  assert.equal((status.pending_permission as { tool_name?: string }).tool_name, 'Bash');

  for (const body of [detail, row, status]) {
    assert.ok(!JSON.stringify(body).includes('s3cr3t-witness'), 'the command stays on the card');
  }

  await closeAll(missionId, [pending]);
  assert.equal(((await getJson(`/api/tasks/${taskId}`)).task as Record<string, unknown>).pending_permission, null);
  assert.equal((await getJson(`/api/missions/${missionId}?view=status`)).pending_permission, null);
});

test('a task that no longer runs says nothing, even if its last mission still holds a card', async () => {
  const { taskId, missionId } = runningTask();
  const pending = openCard(missionId, 'Bash', { command: 'ls' });
  db.prepare("UPDATE tasks SET status = 'BLOCKED' WHERE id = ?").run(taskId);
  assert.equal(((await getJson(`/api/tasks/${taskId}`)).task as Record<string, unknown>).pending_permission, undefined);
  await closeAll(missionId, [pending]);
});

test('the grouped pass gives each mission the summary of its own cards', async () => {
  const a = runningTask(), b = runningTask();
  const pending = [
    openCard(a.missionId, 'Bash', { command: 'ls' }),
    openCard(a.missionId, 'Write', { file_path: '/tmp/x', content: 'y' }),
    openCard(b.missionId, 'Edit', { file_path: '/tmp/y' }),
  ];
  const now = Date.now();
  const all = pendingPermissionSummaries(now);
  assert.deepEqual(all.get(a.missionId), pendingPermissionSummary(a.missionId, now), 'same answer as the one-mission read');
  assert.equal(all.get(a.missionId)?.count, 2);
  assert.equal(all.get(a.missionId)?.tool_name, 'Bash');
  assert.equal(all.get(b.missionId)?.count, 1);
  assert.equal(all.get(b.missionId)?.tool_name, 'Edit');
  await closeAll(a.missionId, pending.slice(0, 2));
  await closeAll(b.missionId, pending.slice(2));
  assert.equal(pendingPermissionSummaries().size, 0);
});

test('an anonymous request is refused', async () => {
  const { taskId, missionId } = runningTask();
  for (const path of ['/api/tasks', `/api/tasks/${taskId}`, `/api/missions/${missionId}?view=status`]) {
    assert.equal((await call('GET', path)).status, 401, path);
  }
});

test('reading a task does not read its mission: the summary needs missions:read:all too', async () => {
  const { taskId, missionId } = runningTask();
  const pending = openCard(missionId, 'Bash', { command: SECRET });

  // tasks:read:all alone: the other account's task is listed, its mission's card is not.
  const detail = (await getJson(`/api/tasks/${taskId}`, tasksOnly)).task as Record<string, unknown>;
  assert.equal(detail.id, taskId, 'the task itself stays readable');
  assert.equal(detail.pending_permission, null);
  const row = ((await getJson('/api/tasks', tasksOnly)).tasks as Array<Record<string, unknown>>).find((t) => t.id === taskId);
  assert.ok(row, 'the task is listed');
  assert.equal(row.pending_permission, null);
  assert.equal((await call('GET', `/api/missions/${missionId}?view=status`, { cookie: tasksOnly })).status, 404,
    'the mission route hides the mission the same way');

  // Both rights: the summary is there, on the detail and on the list.
  const seen = (await getJson(`/api/tasks/${taskId}`, both)).task as Record<string, unknown>;
  assert.equal((seen.pending_permission as { tool_name?: string } | null)?.tool_name, 'Bash');
  const listed = ((await getJson('/api/tasks', both)).tasks as Array<Record<string, unknown>>).find((t) => t.id === taskId);
  assert.equal((listed?.pending_permission as { tool_name?: string } | null)?.tool_name, 'Bash');
  assert.equal(((await getJson(`/api/missions/${missionId}?view=status`, both)).pending_permission as { tool_name?: string }).tool_name, 'Bash');

  await closeAll(missionId, [pending]);
});
