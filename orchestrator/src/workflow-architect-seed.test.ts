import './test-home.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { upsertAgent, getAgent, deleteAgent } = await import('./agent.js');
await import('../tests/helpers/claude-provider.js');
const { dbApi } = await import('./db.js');
const { projectDir } = await import('./paths.js');
const { seedWorkflowArchitect } = await import('./agent-seed.js');

const ARCHITECT = 'timon.workflow-architect';
const cwd = mkdtempSync(join(tmpdir(), 'timon-architect-seed-'));

function reset(): void {
  for (const name of [ARCHITECT, '_main', 'timon.coder']) {
    if (getAgent(name)) deleteAgent(name);
  }
  dbApi.deleteProjectRow('timon');
  rmSync(projectDir('timon'), { recursive: true, force: true });
}

test('a project-less main agent gives a project-less architect, and no timon project', () => {
  reset();
  upsertAgent({ name: '_main', system_prompt: 'main', config: { cwd, role: 'orchestrator' } });
  seedWorkflowArchitect();
  const architect = getAgent(ARCHITECT);
  assert.ok(architect);
  assert.equal(architect?.project ?? null, null);
  assert.equal(dbApi.getProjectRow('timon'), undefined);
});

test('the architect seeded with the old hard-coded slug leaves the ghost timon project', () => {
  reset();
  upsertAgent({ name: '_main', system_prompt: 'main', config: { cwd, role: 'orchestrator' } });
  upsertAgent({ name: ARCHITECT, system_prompt: 'architect prompt', config: { cwd, project: 'timon', role: 'orchestrator' } });
  // What its first finished mission did on an install seeded before the fix.
  dbApi.touchProjectActivity('timon');
  seedWorkflowArchitect();
  const architect = getAgent(ARCHITECT);
  assert.equal(architect?.project ?? null, null);
  assert.equal(architect?.system_prompt, 'architect prompt', 'the repair keeps the prompt');
  assert.equal(dbApi.getProjectRow('timon'), undefined);
});

test('a real timon project keeps the architect and its row', () => {
  reset();
  upsertAgent({ name: '_main', system_prompt: 'main', config: { cwd, role: 'orchestrator' } });
  upsertAgent({ name: ARCHITECT, system_prompt: 'architect prompt', config: { cwd, project: 'timon', role: 'orchestrator' } });
  dbApi.upsertProject('timon', { cwd });
  mkdirSync(projectDir('timon'), { recursive: true });
  seedWorkflowArchitect();
  assert.equal(getAgent(ARCHITECT)?.project, 'timon');
  assert.equal(dbApi.getProjectRow('timon')?.cwd, cwd);
});

test('a timon project another agent belongs to is not a ghost', () => {
  reset();
  upsertAgent({ name: '_main', system_prompt: 'main', config: { cwd, role: 'orchestrator' } });
  upsertAgent({ name: ARCHITECT, system_prompt: 'architect prompt', config: { cwd, project: 'timon', role: 'orchestrator' } });
  upsertAgent({ name: 'timon.coder', system_prompt: 'coder', config: { cwd, project: 'timon', role: 'coder' } });
  dbApi.touchProjectActivity('timon');
  seedWorkflowArchitect();
  assert.equal(getAgent(ARCHITECT)?.project, 'timon');
  assert.ok(dbApi.getProjectRow('timon'));
});
