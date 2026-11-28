import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { A11yError } from './computer-use-a11y.js';
import { linuxA11yBackend } from './computer-use-a11y-linux.js';
import type { SystemCommand } from './computer-use-input.js';

/** A scripted executor: xdotool answers about window 42, the python reader answers `reply`. */
function setup(reply: unknown | Error, xdotoolFails = false) {
  const calls: SystemCommand[] = [];
  const exec = async (command: SystemCommand): Promise<{ stdout: string }> => {
    calls.push(command);
    if (command.file === 'xdotool') {
      if (xdotoolFails) throw new Error('no window');
      return { stdout: command.args[0] === 'getwindowpid' ? '1234\n' : 'Form\n' };
    }
    if (reply instanceof Error) throw reply;
    return { stdout: typeof reply === 'string' ? reply : JSON.stringify(reply) };
  };
  return { backend: linuxA11yBackend(exec), calls };
}
const request = (calls: SystemCommand[]): Record<string, unknown> => JSON.parse(calls.filter((c) => c.file === 'python3').at(-1)!.args[2]!) as Record<string, unknown>;

test('probe is ok when the reader reaches the bus, missing otherwise', async () => {
  assert.equal(await setup({ ok: true }).backend.probe(), 'ok');
  assert.equal(await setup(new Error('No module named gi')).backend.probe(), 'missing');
  assert.equal(await setup('not json').backend.probe(), 'missing');
});

test('tree sends one fixed script and the arguments as JSON, never inside the script', async () => {
  const { backend, calls } = setup({ truncated: true, nodes: [{ path: '0', role: 'window', name: 'Form', enabled: true, actions: [] }] });
  const tree = await backend.tree({ windowId: '42', maxDepth: 5, maxNodes: 10, query: "x'; rm -rf /" });
  assert.equal(tree.truncated, true);
  assert.equal(tree.nodes.length, 1);
  const python = calls.filter((c) => c.file === 'python3');
  assert.equal(python[0]!.args[0], '-c');
  assert.ok(!python[0]!.args[1]!.includes('rm -rf'));
  assert.deepEqual(request(calls), { op: 'tree', pid: 1234, title: 'Form', maxDepth: 5, maxNodes: 10 });
});

test('act passes the value as data and maps the reader refusals', async () => {
  const ok = setup({ ok: true });
  await ok.backend.act({ windowId: '42', path: '0.0.1', action: 'set_value', value: '"; import os' });
  assert.deepEqual(request(ok.calls), { op: 'act', pid: 1234, title: 'Form', path: '0.0.1', action: 'set_value', value: '"; import os' });

  await assert.rejects(setup({ error: 'stale' }).backend.act({ windowId: '42', path: '0.1', action: 'press' }), (e: unknown) => e instanceof A11yError && e.kind === 'stale');
  await assert.rejects(
    setup({ error: 'unsupported', actions: ['focus', 'bogus'] }).backend.act({ windowId: '42', path: '0.1', action: 'press' }),
    (e: unknown) => e instanceof A11yError && e.kind === 'unsupported' && e.actions.join() === 'focus',
  );
  await assert.rejects(setup({ error: 'failed' }).backend.act({ windowId: '42', path: '0.1', action: 'press' }), (e: unknown) => e instanceof A11yError && e.kind === 'failed');
});

test('a bad or vanished window is stale, and a reader crash is a failure', async () => {
  const bad = setup({ ok: true });
  await assert.rejects(bad.backend.tree({ windowId: '4; ls', maxDepth: 3, maxNodes: 3 }), (e: unknown) => e instanceof A11yError && e.kind === 'stale');
  assert.equal(bad.calls.length, 0);
  await assert.rejects(setup({}, true).backend.tree({ windowId: '42', maxDepth: 3, maxNodes: 3 }), (e: unknown) => e instanceof A11yError && e.kind === 'stale');
  await assert.rejects(setup(new Error('boom')).backend.tree({ windowId: '42', maxDepth: 3, maxNodes: 3 }), (e: unknown) => e instanceof A11yError && e.kind === 'failed');
  await assert.rejects(setup({ truncated: false }).backend.tree({ windowId: '42', maxDepth: 3, maxNodes: 3 }), (e: unknown) => e instanceof A11yError && e.kind === 'failed');
});

test('the embedded python script is valid python', (t) => {
  const { calls, backend } = setup({ ok: true });
  void backend.probe();
  const script = calls[0]!.args[1]!;
  const check = spawnSync('python3', ['-I', '-c', 'import sys; compile(sys.stdin.read(), "a11y", "exec")'], { input: script });
  if (check.error) { t.skip('python3 is not installed'); return; }
  assert.equal(check.status, 0, check.stderr.toString());
});
