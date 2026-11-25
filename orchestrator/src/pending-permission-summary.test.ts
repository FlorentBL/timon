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

process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';
await import('../tests/helpers/claude-provider.js');
const { requestPermission, listPending, resolvePermission, pendingPermissionSummary } = await import('./permissions.js');
const { db, dbApi } = await import('./db.js');
const kanban = await import('./plugins-bundled/kanban/routes.js');
const missions = await import('./plugins-bundled/missions/routes.js');

const MIN = 60_000;
const SECRET = 'curl -H "Authorization: Bearer s3cr3t-witness" https://example.invalid';

const app = express();
kanban.registerRoutes(app);
missions.registerRoutes(app);
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
after(() => server.close());
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

async function getJson(path: string): Promise<Record<string, unknown>> {
  const response = await fetch(`${base}${path}`);
  assert.equal(response.status, 200, path);
  return await response.json() as Record<string, unknown>;
}

/** An autonomous mission running a task, so its cards arm the short delay. */
function runningTask(): { taskId: string; missionId: string } {
  const taskId = randomUUID(), missionId = randomUUID();
  dbApi.createMission(missionId, 'acme.coder', 'work', { channel: 'routine' });
  dbApi.createTask(taskId, 'Waits on a card', 'acme.coder');
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
  assert.equal(((await getJson(`/api/tasks/${taskId}`)).task as Record<string, unknown>).pending_permission, undefined);
  assert.equal((await getJson(`/api/missions/${missionId}?view=status`)).pending_permission, null);
});

test('a task that no longer runs says nothing, even if its last mission still holds a card', async () => {
  const { taskId, missionId } = runningTask();
  const pending = openCard(missionId, 'Bash', { command: 'ls' });
  db.prepare("UPDATE tasks SET status = 'BLOCKED' WHERE id = ?").run(taskId);
  assert.equal(((await getJson(`/api/tasks/${taskId}`)).task as Record<string, unknown>).pending_permission, undefined);
  await closeAll(missionId, [pending]);
});
