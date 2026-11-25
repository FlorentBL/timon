/**
 * #1109 — the board shows who REALLY runs a task, and on what.
 *
 * A `research` task named after a codex reviewer was handed by the dispatcher
 * to the claude researcher holding the role, while the card still read
 * "reviewer · gpt-5.6-sol". These lock the three readings: the dispatcher's
 * plan for a waiting task, the mission once one ran it, and the warning given
 * to whoever creates a task its named agent will not run.
 */
import '../../test-home.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { test, after } from 'node:test';
import express from 'express';

const { upsertAgent } = await import('../../agent.js');
const { dbApi } = await import('../../db.js');
const { frozenTaskLlm } = await import('../../dispatcher.js');
const { registerRoutes, taskExecution } = await import('./routes.js');
const { createDaemonAuthMiddleware } = await import('../http/auth.js');

{
  const { mountOfficialProviders } = await import('../../../tests/helpers/official-providers.js');
  await mountOfficialProviders();
}

const CWD = process.env.TIMON_HOME!;
dbApi.upsertProject('acme', { cwd: CWD });
for (const [name, config] of [
  ['acme.reviewer', { role: 'reviewer', backend: 'codex', model: 'gpt-5.6-sol' }],
  ['acme.researcher', { role: 'researcher', backend: 'claude', model: 'sonnet' }],
] as const) {
  upsertAgent({ name, system_prompt: `# ${name}\n`, config: { cwd: CWD, project: 'acme', ...config } });
}

const app = express();
app.use(express.json());
app.use(createDaemonAuthMiddleware({ token: 'exec-test', required: false }));
registerRoutes(app);
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
after(() => server.close());
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

type Row = { id: string; effective_backend: string; effective_model: string | null; run_by?: Record<string, unknown> };

function researchTask(opts: { backend?: string; model?: string } = {}) {
  const id = randomUUID();
  dbApi.createTask(id, 'audit it', 'acme.reviewer', {
    type: 'research', project: 'acme', backendOverride: opts.backend ?? null, modelOverride: opts.model ?? null,
  });
  return id;
}

async function boardRow(id: string): Promise<Row> {
  const r = await fetch(`${base}/api/tasks`, { headers: { Authorization: 'Bearer exec-test' } });
  assert.equal(r.status, 200);
  const { tasks } = await r.json() as { tasks: Row[] };
  return tasks.find((t) => t.id === id)!;
}

test('a waiting rerouted task shows the agent and the model that will run it', async () => {
  const id = researchTask();
  const row = await boardRow(id);
  assert.equal(row.effective_backend, 'claude');
  assert.equal(row.effective_model, 'sonnet');
  assert.deepEqual(row.run_by, { agent: 'acme.researcher', source: 'role', reason: 'other_role', planned: true });

  const r = await fetch(`${base}/api/tasks/${id}`, { headers: { Authorization: 'Bearer exec-test' } });
  const { task } = await r.json() as { task: Row };
  assert.equal(task.effective_backend, 'claude');
  assert.equal(task.run_by?.agent, 'acme.researcher');
});

test('an override on the task still wins over the running agent\'s pair', () => {
  const id = researchTask({ backend: 'codex', model: 'gpt-5.6-sol' });
  const shown = taskExecution(dbApi.getTask(id)!);
  assert.equal(shown.backend, 'codex');
  assert.equal(shown.model, 'gpt-5.6-sol');
  assert.equal(shown.runner?.agent, 'acme.researcher');
});

test('a series rule applies to the rerouted task as it does at dispatch', () => {
  const seriesId = randomUUID();
  dbApi.setSeriesRole(seriesId, 'research', 'codex', 'gpt-5.6-sol');
  const id = randomUUID();
  dbApi.createTask(id, 'audit it', 'acme.reviewer', { type: 'research', project: 'acme', seriesId });
  assert.deepEqual(
    { backend: taskExecution(dbApi.getTask(id)!).backend, model: taskExecution(dbApi.getTask(id)!).model },
    { backend: 'codex', model: 'gpt-5.6-sol' },
  );
});

test('once a mission ran it, the board reads the mission, not the named agent', async () => {
  const id = researchTask();
  const missionId = randomUUID();
  dbApi.createMission(missionId, 'acme.researcher', 'audit it');
  dbApi.setMissionLlmOverrides(missionId, 'claude', 'opus');
  dbApi.assignTaskMission(id, missionId);
  dbApi.updateTaskStatus(id, 'DONE', { doneComment: 'ok' });

  const row = await boardRow(id);
  assert.equal(row.effective_backend, 'claude');
  assert.equal(row.effective_model, 'opus');
  assert.equal(row.run_by?.agent, 'acme.researcher');
  assert.equal(row.run_by?.planned, undefined, 'it ran: not a plan');

  // A mission with nothing frozen on it falls back on its own agent's config.
  const bare = randomUUID();
  dbApi.createMission(bare, 'acme.researcher', 'audit it');
  assert.deepEqual(
    taskExecution({ ...dbApi.getTask(id)!, mission_id: bare }),
    { backend: 'claude', model: 'sonnet', runner: { agent: 'acme.researcher', source: null, reason: null } },
  );
});

test('a task requeued to PENDING shows the dispatcher\'s plan again, not its old mission', () => {
  const id = researchTask();
  const old = randomUUID();
  dbApi.createMission(old, 'acme.reviewer', 'audit it');
  dbApi.assignTaskMission(id, old);
  dbApi.updateTaskStatus(id, 'PENDING');
  assert.equal(dbApi.getTask(id)!.mission_id, old, 'the old mission is still on the row');
  const shown = taskExecution(dbApi.getTask(id)!);
  assert.equal(shown.backend, 'claude');
  assert.equal(shown.runner?.planned, true);
});

test('creating a task another agent will run answers with a warning, and still creates it', async () => {
  const post = (body: Record<string, unknown>) => fetch(`${base}/api/tasks`, {
    method: 'POST',
    headers: { Authorization: 'Bearer exec-test', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const rerouted = await post({ title: 'audit', agent_name: 'acme.reviewer', type: 'research', project: 'acme' });
  assert.equal(rerouted.status, 201);
  const created = await rerouted.json() as { task: { id: string }; warnings?: string[] };
  assert.ok(dbApi.getTask(created.task.id), 'created as asked');
  assert.equal(created.warnings?.length, 1);
  assert.match(created.warnings![0]!, /will be run by acme\.researcher, not acme\.reviewer/);
  assert.match(created.warnings![0]!, /holds the reviewer role/);

  const direct = await post({ title: 'audit', agent_name: 'acme.researcher', type: 'research', project: 'acme' });
  assert.equal(direct.status, 201);
  assert.equal((await direct.json() as { warnings?: string[] }).warnings, undefined);
});

test('the dispatcher freezes the running agent\'s own pair when nothing above it decided', () => {
  assert.deepEqual(frozenTaskLlm({ backend: null, model: null }, { backend: 'claude', model: 'sonnet' }), { backend: 'claude', model: 'sonnet' });
  assert.deepEqual(frozenTaskLlm({ backend: 'codex', model: 'gpt-5.6-sol' }, { backend: 'claude', model: 'sonnet' }), { backend: 'codex', model: 'gpt-5.6-sol' });
  // A role backend that is not the agent's: the agent's model would not be served there.
  assert.deepEqual(frozenTaskLlm({ backend: 'codex', model: null }, { backend: 'claude', model: 'sonnet' }), { backend: 'codex', model: null });
  // An agent that names no backend: the launch freezes the default itself.
  assert.deepEqual(frozenTaskLlm({ backend: null, model: null }, {}), { backend: null, model: null });
});
