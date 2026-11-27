import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { BackendCatalog } from './backends';
import { runByReasonKey, runByTitle, taskRunAgent, taskRunView } from './task-runner';
import en from '../locales/en/core.json';
import fr from '../locales/fr/core.json';

test('the chat of a rerouted task is the one of the agent that ran it', () => {
  assert.equal(taskRunAgent({ agent_name: 'acme.builder-ui' }), 'acme.builder-ui');
  assert.equal(taskRunAgent({ agent_name: 'acme.builder-ui', run_by: { agent: 'acme.builder', source: 'pinned', reason: 'pinned' } }), 'acme.builder');
});

test('every routing reason has a sentence in both locales, an unknown one the generic sentence', () => {
  const lookup = (dict: unknown, key: string): unknown =>
    key.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], dict);
  for (const reason of ['pinned', 'missing', 'other_project', 'orchestrator', 'other_role', null, 'something_new']) {
    const key = runByReasonKey(reason);
    assert.equal(typeof lookup(en, key), 'string', `en ${key}`);
    assert.equal(typeof lookup(fr, key), 'string', `fr ${key}`);
  }
  assert.equal(runByReasonKey('something_new'), 'kanbanPage.runBy.reasonUnknown');
  for (const key of ['assigned', 'titlePlanned', 'detail', 'detailPlanned', 'on']) {
    assert.equal(typeof lookup(en, `kanbanPage.runBy.${key}`), 'string', `en ${key}`);
    assert.equal(typeof lookup(fr, `kanbanPage.runBy.${key}`), 'string', `fr ${key}`);
  }
  assert.equal(typeof lookup(fr, 'kanbanPage.runBy.title'), 'string');
});

// #1109: a task no mission ran yet says who WILL run it, not who ran it.
test('the tooltip tells a planned reroute from one that already ran', () => {
  const ran = runByTitle('acme.reviewer', { agent: 'acme.researcher', source: 'role', reason: 'other_role' });
  const planned = runByTitle('acme.reviewer', { agent: 'acme.researcher', source: 'role', reason: 'other_role', planned: true });
  assert.match(ran, /acme\.reviewer/);
  assert.match(ran, /acme\.researcher/);
  assert.notEqual(ran, planned);
  assert.match(planned, /will be run by acme\.researcher/);
});

const CATALOG = {
  defaultBackend: 'claude',
  backends: [
    { id: 'claude', label: 'Claude', brand: 'anthropic', models: [{ slug: 'claude-opus-4-7', label: 'Opus' }] },
    { id: 'claude@perso', label: 'Claude · Perso', instanceOf: 'claude', models: [], account: { id: 'perso', name: 'Perso', state: 'active' } },
  ],
} as BackendCatalog;

// #1203: every row that lists a task names its runner and its model, as the card does.
test('a task row shows the agent and the model that really run it', () => {
  const view = taskRunView(CATALOG, {
    agent_name: 'acme.builder-ui',
    run_by: { agent: 'acme.builder', source: 'pinned', reason: 'pinned', planned: true },
    effective_backend: 'claude@perso',
    effective_model: 'claude-opus-4-7',
  });
  assert.equal(view.agent, 'acme.builder');
  assert.equal(view.rerouted, true);
  assert.equal(view.model, 'opus');
  assert.equal(view.mark.empty, false);
  assert.match(view.title, /acme\.builder on Perso \/ claude-opus-4-7/);
  assert.match(view.title, /will be run by acme\.builder/);
});

test('a row with no model names the backend, and a row the daemon sent nothing for names only the agent', () => {
  const backendOnly = taskRunView(CATALOG, { agent_name: 'acme.coder', effective_backend: 'claude@perso', effective_model: null });
  assert.equal(backendOnly.model, 'Perso');
  assert.equal(backendOnly.rerouted, false);
  assert.match(backendOnly.title, /Perso default/);
  const bare = taskRunView(CATALOG, { agent_name: 'acme.coder' });
  assert.equal(bare.model, null);
  assert.equal(bare.mark.empty, true);
  assert.equal(bare.title, 'acme.coder');
});
