import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runByReasonKey, runByTitle, taskRunAgent } from './task-runner';
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
  for (const key of ['assigned', 'titlePlanned', 'detail', 'detailPlanned']) {
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
