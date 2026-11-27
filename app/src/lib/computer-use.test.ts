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

test('the UI proxy only relays status, stop and resume, and refuses the agent commands', async () => {
  const { uiComputerPath } = await import('./computer-use');
  assert.equal(uiComputerPath('GET', 'status'), '/api/computer/status');
  for (const command of ['status', 'stop', 'resume']) {
    assert.equal(uiComputerPath('POST', command), `/api/computer/${command}`);
  }
  for (const command of ['click', 'type', 'key', 'screenshot', 'move', 'drag', 'scroll', 'wait', '..%2Fstatus', '']) {
    assert.equal(uiComputerPath('POST', command), null, command);
    assert.equal(uiComputerPath('GET', command), null, command);
  }
  assert.equal(uiComputerPath('GET', 'stop'), null);
  assert.equal(uiComputerPath('GET', 'resume'), null);
});

test('the UI status poll (GET) is relayed upstream as POST /api/computer/status, the only route the daemon has', async () => {
  const { uiComputerUpstream } = await import('./computer-use');
  assert.deepEqual(uiComputerUpstream('GET', 'status'), { method: 'POST', path: '/api/computer/status' });
  for (const command of ['status', 'stop', 'resume']) {
    assert.deepEqual(uiComputerUpstream('POST', command), { method: 'POST', path: `/api/computer/${command}` });
  }
  assert.equal(uiComputerUpstream('GET', 'stop'), null);
  assert.equal(uiComputerUpstream('GET', 'click'), null);
});
