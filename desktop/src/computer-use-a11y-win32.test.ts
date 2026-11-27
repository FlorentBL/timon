import assert from 'node:assert/strict';
import test from 'node:test';
import { A11yError } from './computer-use-a11y.js';
import { win32A11yBackend } from './computer-use-a11y-win32.js';
import { selectA11yBackend } from './computer-use-a11y-select.js';
import type { SystemCommand } from './computer-use-input.js';

function recorder(answer: unknown | (() => never)) {
  const seen: SystemCommand[] = [];
  const exec = async (command: SystemCommand) => {
    seen.push(command);
    if (typeof answer === 'function') return (answer as () => never)();
    return { stdout: typeof answer === 'string' ? answer : JSON.stringify(answer) };
  };
  return { seen, exec };
}
const request = (c: SystemCommand): Record<string, unknown> => JSON.parse(c.worker?.input ?? '{}');

test('a tree request travels as JSON to the persistent worker and the answer is read as raw nodes', async () => {
  const { seen, exec } = recorder({
    truncated: true,
    nodes: [
      { path: '0', role: 'window', name: 'Test', enabled: true, actions: [], bounds: { x: 1, y: 2, width: 3, height: 4 } },
      { path: '0.0', role: 'button', name: 'Valider', value: 'v', enabled: true, focused: true, actions: ['press', 'focus'] },
      { nope: true },
    ],
  });
  const tree = await win32A11yBackend(exec).tree({ windowId: '4242', maxDepth: 8, maxNodes: 400 });
  assert.equal(tree.truncated, true);
  assert.deepEqual(tree.nodes.map((n) => n.path), ['0', '0.0']);
  assert.deepEqual(tree.nodes[1], { path: '0.0', role: 'button', name: 'Valider', value: 'v', enabled: true, focused: true, actions: ['press', 'focus'] });
  assert.deepEqual(request(seen[0]), { q: 'a11y_tree', id: '4242', maxDepth: 8, maxNodes: 400 });
  assert.equal(seen[0].worker?.reply, true);
});

test('the script is fixed text: a hostile value or id appears only in the JSON request', async () => {
  const { seen, exec } = recorder({ ok: true });
  const evil = `'; Remove-Item C:\\ -Recurse; "`;
  await win32A11yBackend(exec).act({ windowId: '7', path: '0.1.2', action: 'set_value', value: evil });
  assert.equal(request(seen[0]).value, evil);
  const script = Buffer.from(seen[0].args[seen[0].args.length - 1], 'base64').toString('utf16le');
  assert.ok(!script.includes('Remove-Item'));
  assert.ok(!(seen[0].worker?.args.join(' ') ?? '').includes(evil));
  await assert.rejects(win32A11yBackend(exec).tree({ windowId: '1; calc', maxDepth: 1, maxNodes: 1 }), A11yError);
});

test('act maps the worker answers to the contract errors', async () => {
  const act = (answer: unknown) => win32A11yBackend(recorder(answer).exec).act({ windowId: '7', path: '0.1', action: 'press' });
  await act({ ok: true });
  await assert.rejects(act({ stale: true }), (e: A11yError) => e.kind === 'stale');
  await assert.rejects(act({ unsupported: true, actions: ['focus'] }), (e: A11yError) => e.kind === 'unsupported' && e.actions.join() === 'focus');
  await assert.rejects(act({}), (e: A11yError) => e.kind === 'failed');
  await assert.rejects(act('not json'), (e: A11yError) => e.kind === 'failed');
});

test('set_value sends its value; other actions send none', async () => {
  const { seen, exec } = recorder({ ok: true });
  const backend = win32A11yBackend(exec);
  await backend.act({ windowId: '7', path: '0.1', action: 'set_value', value: 'timon' });
  await backend.act({ windowId: '7', path: '0.1', action: 'press' });
  assert.equal(request(seen[0]).value, 'timon');
  assert.ok(!('value' in request(seen[1])));
});

test('probe reports ok when the worker loads UI Automation, missing otherwise', async () => {
  assert.equal(await win32A11yBackend(recorder({ ok: true }).exec).probe(), 'ok');
  assert.equal(await win32A11yBackend(recorder({ ok: false }).exec).probe(), 'missing');
  assert.equal(await win32A11yBackend(recorder(() => { throw new Error('no powershell'); }).exec).probe(), 'missing');
  assert.equal(await selectA11yBackend('win32', recorder({ ok: true }).exec).probe(), 'ok');
});

test('the worker script carries the UI Automation functions the requests need', async () => {
  const { seen, exec } = recorder({ ok: true });
  await win32A11yBackend(exec).probe();
  const script = seen[0].worker!.env!.TIMON_CU_SCRIPT!;
  for (const needle of ['UIAutomationClient', 'ControlViewWalker', 'CacheRequest', 'InvokePattern', 'ValuePattern', 'SelectionItemPattern', 'ExpandCollapsePattern', 'ScrollItemPattern', 'SetFocus', "'a11y_tree'", "'a11y_act'"]) {
    assert.ok(script.includes(needle), needle);
  }
});
