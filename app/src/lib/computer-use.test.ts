/**
 * Computer use, screen side: the status answer is read defensively, and the
 * human stop / resume only ever call the UI proxy (never an agent command).
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchComputerStatus, parseComputerStatus, sendComputerControl } from './computer-use';

test('parseComputerStatus reads active, bare or wrapped in result', () => {
  assert.deepEqual(parseComputerStatus({ active: true }), { active: true, stopped: false });
  assert.deepEqual(parseComputerStatus({ ok: true, result: { active: true, stopped: true } }), { active: true, stopped: true });
  assert.deepEqual(parseComputerStatus({ active: 'yes' }), { active: false, stopped: false });
  assert.deepEqual(parseComputerStatus(null), { active: false, stopped: false });
});

test('status and controls go through the UI proxy; failures read as idle / refused', async () => {
  const calls: Array<{ url: string; method: string }> = [];
  const real = globalThis.fetch;
  let status = 200;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? 'GET' });
    return new Response(JSON.stringify({ active: true }), { status });
  }) as typeof fetch;
  try {
    assert.equal((await fetchComputerStatus()).active, true);
    assert.equal(await sendComputerControl('stop'), true);
    assert.equal(await sendComputerControl('resume'), true);
    status = 503; // desktop absent
    assert.equal((await fetchComputerStatus()).active, false);
    assert.equal(await sendComputerControl('stop'), false);
    globalThis.fetch = (async () => { throw new Error('offline'); }) as typeof fetch;
    assert.equal((await fetchComputerStatus()).active, false);
    assert.deepEqual(calls.slice(0, 3), [
      { url: '/api/ui/computer/status', method: 'GET' },
      { url: '/api/ui/computer/stop', method: 'POST' },
      { url: '/api/ui/computer/resume', method: 'POST' },
    ]);
  } finally {
    globalThis.fetch = real;
  }
});
