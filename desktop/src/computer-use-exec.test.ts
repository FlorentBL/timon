import assert from 'node:assert/strict';
import test from 'node:test';
import { createSystemExecutor } from './computer-use-exec.js';
import type { SystemCommand } from './computer-use-input.js';

// A node child stands in for PowerShell: it speaks the same line protocol.
const WORKER = `
console.log('ready');
require('readline').createInterface({ input: process.stdin }).on('line', (line) => {
  console.log(line === 'boom' ? 'error' : 'ok');
});`;
const ONE_SHOT = `process.stdout.write('one-shot')`;

const command = (input: string, workerScript = WORKER): SystemCommand => ({
  file: process.execPath, args: ['-e', ONE_SHOT], worker: { args: ['-e', workerScript], input },
});

test('requests reuse one persistent process and errors are reported', async () => {
  const executor = createSystemExecutor();
  try {
    assert.deepEqual(await executor.run(command('[]')), { stdout: '' });
    assert.deepEqual(await executor.run(command('[1]')), { stdout: '' });
    await assert.rejects(executor.run(command('boom')), /Input worker failed/);
    // A step failure does not poison the worker.
    assert.deepEqual(await executor.run(command('[]')), { stdout: '' });
  } finally { executor.dispose(); }
});

test('a worker that never says ready falls back to the one-shot command', async () => {
  const executor = createSystemExecutor();
  try {
    const result = await executor.run(command('[]', `process.exit(1)`));
    assert.equal(result.stdout, 'one-shot');
    // Given up for good: the next call does not wait for a worker again.
    assert.equal((await executor.run(command('[]', `process.exit(1)`))).stdout, 'one-shot');
  } finally { executor.dispose(); }
});

test('commands without a worker run as one-shot', async () => {
  const executor = createSystemExecutor();
  try {
    assert.equal((await executor.run({ file: process.execPath, args: ['-e', ONE_SHOT] })).stdout, 'one-shot');
  } finally { executor.dispose(); }
});

test('a read returns the worker answer line, and an error answer rejects', async () => {
  const executor = createSystemExecutor();
  const read = (input: string): SystemCommand => ({ file: process.execPath, args: ['-e', ONE_SHOT], worker: { args: ['-e', WORKER], input, reply: true } });
  try {
    assert.equal((await executor.run(read('[]'))).stdout, 'ok');
    await assert.rejects(executor.run(read('boom')), /Input worker failed/);
  } finally { executor.dispose(); }
});
