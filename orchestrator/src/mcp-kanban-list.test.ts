/**
 * The `kanban_list` MCP tool (`bin/timon-mcp-catalog.mjs`): short rows of the
 * caller's project, bounded, and an explicit envelope when the list is cut.
 * A whole home's tasks with full texts once reached several MB per call.
 */
import './test-home.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadMcpCatalog } from './remote-mcp/catalog.js';

type Sent = { method: string; path: string };
type Env = { project?: string };

function recorder(answer: unknown) {
  const sent: Sent[] = [];
  const call = async (method: string, path: string) => {
    sent.push({ method, path });
    return answer;
  };
  return { sent, call };
}

const ctx = (call: (m: string, p: string) => Promise<unknown>, env: Env = {}) => ({ call, env, hostFiles: true });

const TASK = {
  id: 't1', title: 'one', status: 'BLOCKED', type: 'code', agent_name: 'acme.coder', project: 'acme',
  priority: 3, deps: '["t0"]', description: 'x'.repeat(5_000), done_comment: 'y'.repeat(5_000),
  blocked_reason: 'z'.repeat(500), group_id: null, mission_id: 'm1', created_at: 1, updated_at: 2,
  effective_backend: 'codex',
};

test('the schema declares project, limit and full', async () => {
  const { TOOLS } = await loadMcpCatalog();
  const tool = TOOLS.find((t) => t.name === 'kanban_list') as { inputSchema: { properties: Record<string, unknown> } } | undefined;
  for (const key of ['status', 'project', 'limit', 'full']) assert.ok(tool?.inputSchema.properties[key], key);
});

test('by default: the caller\'s project, a limit, no full text', async () => {
  const { runTool } = await loadMcpCatalog();
  const { sent, call } = recorder({ tasks: [TASK], total: 1, truncated: false });
  const rows = await runTool('kanban_list', {}, ctx(call, { project: 'acme' })) as Array<Record<string, unknown>>;
  assert.deepEqual(sent, [{ method: 'GET', path: '/api/tasks?limit=100&project=acme' }]);
  assert.equal(rows.length, 1);
  const row = rows[0]!;
  assert.equal(row.description, undefined);
  assert.equal(row.done_comment, undefined);
  assert.equal(row.effective_backend, undefined);
  assert.equal('group_id' in row, false, 'empty columns are left out');
  assert.deepEqual(row.deps, ['t0']);
  assert.equal(row.agent_name, 'acme.coder');
  assert.ok((row.blocked_reason as string).length <= 201);
});

test('project, status and limit are passed on; * lists every project', async () => {
  const { runTool } = await loadMcpCatalog();
  const { sent, call } = recorder({ tasks: [], total: 0, truncated: false });
  await runTool('kanban_list', { project: 'beta', status: 'PENDING', limit: 7 }, ctx(call, { project: 'acme' }));
  await runTool('kanban_list', { project: '*' }, ctx(call, { project: 'acme' }));
  await runTool('kanban_list', { limit: 100_000 }, ctx(call));
  assert.deepEqual(sent.map((s) => s.path), [
    '/api/tasks?limit=7&status=PENDING&project=beta',
    '/api/tasks?limit=100',
    '/api/tasks?limit=500',
  ]);
});

test('full is opt-in and stays bounded', async () => {
  const { runTool } = await loadMcpCatalog();
  const { sent, call } = recorder({ tasks: [TASK], total: 1, truncated: false });
  const rows = await runTool('kanban_list', { full: true }, ctx(call)) as Array<Record<string, unknown>>;
  await runTool('kanban_list', { full: true, limit: 400 }, ctx(call));
  assert.deepEqual(sent.map((s) => s.path), ['/api/tasks?limit=20&full=1', '/api/tasks?limit=50&full=1']);
  assert.equal(rows[0]!.description, TASK.description);
});

test('a cut list says so: truncated, shown, total, hint', async () => {
  const { runTool } = await loadMcpCatalog();
  const { call } = recorder({ tasks: [TASK], total: 42, truncated: true });
  const out = await runTool('kanban_list', { limit: 1 }, ctx(call)) as {
    truncated: boolean; shown: number; total: number; hint: string; items: unknown[];
  };
  assert.equal(out.truncated, true);
  assert.equal(out.shown, 1);
  assert.equal(out.total, 42);
  assert.match(out.hint, /limit/);
  assert.equal(out.items.length, 1);
});
