import assert from 'node:assert/strict';
import test from 'node:test';
import { A11yError } from './computer-use-a11y.js';
import { MAC_A11Y_SCRIPT, darwinA11yBackend, macRole } from './computer-use-a11y-darwin.js';
import type { SystemCommand } from './computer-use-input.js';

function setup(answer: string | Error) {
  const calls: SystemCommand[] = [];
  const backend = darwinA11yBackend(async (command) => {
    calls.push(command);
    if (answer instanceof Error) throw answer;
    return { stdout: answer };
  });
  return { backend, calls };
}

test('probe reports the Accessibility grant of the process', async () => {
  assert.equal(await setup('true\n').backend.probe(), 'ok');
  assert.equal(await setup('false').backend.probe(), 'missing');
  assert.equal(await setup(new Error('boom')).backend.probe(), 'missing');
});

test('tree runs the fixed script with the request as one JSON argument', async () => {
  const hostile = '1:2"); do shell script "x';
  const { backend, calls } = setup(JSON.stringify({ ok: true, truncated: false, nodes: [] }));
  await assert.rejects(backend.tree({ windowId: hostile, maxDepth: 3, maxNodes: 10 }), (e: unknown) => e instanceof A11yError && e.kind === 'stale');
  assert.equal(calls.length, 0);
  await backend.tree({ windowId: '123:45', maxDepth: 3, maxNodes: 10 });
  const command = calls[0]!;
  assert.equal(command.file, 'osascript');
  assert.deepEqual(command.args.slice(0, 3), ['-l', 'JavaScript', '-e']);
  assert.equal(command.args[3], MAC_A11Y_SCRIPT);
  assert.deepEqual(JSON.parse(command.args[4]!), { op: 'tree', pid: 123, number: 45, maxDepth: 3, maxNodes: 10 });
  assert.match(MAC_A11Y_SCRIPT, /AXManualAccessibility/);
});

test('tree parses nodes and normalises the roles', async () => {
  const { backend } = setup(JSON.stringify({ ok: true, truncated: true, nodes: [
    { path: '0', role: 'AXWindow', sub: '', name: 'Form', value: '', enabled: true, actions: [], bounds: { x: 1, y: 2, width: 3, height: 4 } },
    { path: '0.0', role: 'AXTextField', sub: '', name: 'Nom', value: 'abc', enabled: true, actions: ['focus', 'set_value', 'bogus'], focused: true },
    { path: '0.1', role: 'AXRadioButton', sub: 'AXTabButton', name: 'T', enabled: false, actions: [] },
    { path: '0.2', role: 'AXWeird', sub: '', name: '', enabled: true, actions: [] },
    { role: 'AXButton' },
  ] }));
  const raw = await backend.tree({ windowId: '1:2', maxDepth: 8, maxNodes: 400 });
  assert.equal(raw.truncated, true);
  assert.deepEqual(raw.nodes.map((n) => [n.path, n.role]), [['0', 'window'], ['0.0', 'textfield'], ['0.1', 'tab'], ['0.2', 'other']]);
  assert.deepEqual(raw.nodes[0]!.bounds, { x: 1, y: 2, width: 3, height: 4 });
  assert.deepEqual(raw.nodes[1], { path: '0.0', role: 'textfield', name: 'Nom', value: 'abc', enabled: true, focused: true, actions: ['focus', 'set_value'] });
  assert.equal(raw.nodes[2]!.enabled, false);
  assert.equal(macRole('AXPopUpButton', ''), 'combobox');
});

test('tree turns a missing window into a stale error and garbage into a failure', async () => {
  await assert.rejects(setup('{"error":"stale"}').backend.tree({ windowId: '1:2', maxDepth: 1, maxNodes: 1 }), (e: unknown) => e instanceof A11yError && e.kind === 'stale');
  await assert.rejects(setup('not json').backend.tree({ windowId: '1:2', maxDepth: 1, maxNodes: 1 }), (e: unknown) => e instanceof A11yError && e.kind === 'failed');
  await assert.rejects(setup(new Error('spawn failed')).backend.tree({ windowId: '1:2', maxDepth: 1, maxNodes: 1 }), (e: unknown) => e instanceof A11yError && e.kind === 'failed');
});

test('act sends the value as data and maps the answers', async () => {
  const value = 'x"); quit(); ("';
  const { backend, calls } = setup('{"ok":true}');
  await backend.act({ windowId: '7:8', path: '0.0.1', action: 'set_value', value });
  assert.deepEqual(JSON.parse(calls[0]!.args[4]!), { op: 'act', pid: 7, number: 8, path: '0.0.1', action: 'set_value', value });
  assert.equal(calls[0]!.args[3], MAC_A11Y_SCRIPT);
  await assert.rejects(setup('{"error":"stale"}').backend.act({ windowId: '7:8', path: '0.9', action: 'press' }), (e: unknown) => e instanceof A11yError && e.kind === 'stale');
  await assert.rejects(
    setup('{"error":"unsupported","actions":["press","nope"]}').backend.act({ windowId: '7:8', path: '0.1', action: 'expand' }),
    (e: unknown) => e instanceof A11yError && e.kind === 'unsupported' && e.actions.join() === 'press',
  );
  await assert.rejects(setup('{"error":"failed","code":-25200}').backend.act({ windowId: '7:8', path: '0.1', action: 'press' }), (e: unknown) => e instanceof A11yError && e.kind === 'failed');
});
