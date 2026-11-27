/**
 * The Computer use switch survives a round trip through the agent editor.
 *
 * Found in a live test: the switch was saved but read back as off, because the
 * agent's details and the agent list left the field out; and switching it off
 * sent no key, which a save reads as "keep what is stored", so it stayed on.
 */
import './test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { getAgent, upsertAgent, listAgents } = await import('./agent.js');

test('computer_use is read back after a save, and an explicit false turns it off', () => {
  const name = 'cu-roundtrip';
  upsertAgent({ name, system_prompt: 'x', config: { backend: 'claude', computer_use: true } });
  assert.equal(getAgent(name)?.computer_use, true, 'the details carry the stored switch');
  assert.equal(listAgents().find((agent) => agent.name === name)?.computer_use, true, 'so does the list');

  // A save that does not mention it keeps it, as for the other preserved keys.
  upsertAgent({ name, system_prompt: 'x', config: { backend: 'claude' } });
  assert.equal(getAgent(name)?.computer_use, true);

  upsertAgent({ name, system_prompt: 'x', config: { backend: 'claude', computer_use: false } });
  assert.equal(getAgent(name)?.computer_use, false, 'switching it off is stored');
  assert.equal(listAgents().find((agent) => agent.name === name)?.computer_use, false);
});

test('an agent that never had it reads as off', () => {
  upsertAgent({ name: 'cu-never', system_prompt: 'x', config: { backend: 'claude' } });
  assert.equal(getAgent('cu-never')?.computer_use, false);
});

test('computer_use_apps is read back by the details and the list, kept by a save that omits it, and replaced when sent', () => {
  const name = 'cu-apps-roundtrip';
  upsertAgent({ name, system_prompt: 'x', config: { backend: 'claude', computer_use: true, computer_use_apps: ['com.apple.TextEdit', 'Notepad'] } });
  assert.deepEqual(getAgent(name)?.computer_use_apps, ['com.apple.TextEdit', 'Notepad']);
  assert.deepEqual(listAgents().find((agent) => agent.name === name)?.computer_use_apps, ['com.apple.TextEdit', 'Notepad']);

  upsertAgent({ name, system_prompt: 'x', config: { backend: 'claude', computer_use: true } });
  assert.deepEqual(getAgent(name)?.computer_use_apps, ['com.apple.TextEdit', 'Notepad'], 'a save without the key keeps it');

  upsertAgent({ name, system_prompt: 'x', config: { backend: 'claude', computer_use: true, computer_use_apps: [] } });
  assert.deepEqual(getAgent(name)?.computer_use_apps, []);
  assert.deepEqual(listAgents().find((agent) => agent.name === name)?.computer_use_apps, []);
});

test('an agent that never had a list reads an empty one', () => {
  upsertAgent({ name: 'cu-apps-never', system_prompt: 'x', config: { backend: 'claude' } });
  assert.deepEqual(getAgent('cu-apps-never')?.computer_use_apps, []);
});

test('computer_use_mode is read back by the details and the list, kept by a save that omits it, and defaults to foreground', () => {
  const name = 'cu-mode-roundtrip';
  upsertAgent({ name, system_prompt: 'x', config: { backend: 'claude', computer_use: true } });
  assert.equal(getAgent(name)?.computer_use_mode, 'foreground');
  upsertAgent({ name, system_prompt: 'x', config: { backend: 'claude', computer_use: true, computer_use_mode: 'background' } });
  assert.equal(getAgent(name)?.computer_use_mode, 'background');
  assert.equal(listAgents().find((agent) => agent.name === name)?.computer_use_mode, 'background');
  upsertAgent({ name, system_prompt: 'x', config: { backend: 'claude', computer_use: true } });
  assert.equal(getAgent(name)?.computer_use_mode, 'background', 'a save without the key keeps it');
  upsertAgent({ name, system_prompt: 'x', config: { backend: 'claude', computer_use: true, computer_use_mode: 'foreground' } });
  assert.equal(getAgent(name)?.computer_use_mode, 'foreground');
});
