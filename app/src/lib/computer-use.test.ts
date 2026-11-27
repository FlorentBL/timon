/**
 * Computer use, screen side: the status answer is read defensively, and the
 * human stop / resume only ever call the UI proxy (never an agent command).
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  COMPUTER_UNREACHABLE, fetchComputerSetup, fetchComputerStatus, parseComputerSetup, parseComputerStatus, requestComputerPermissions,
  restartComputerApp, sendComputerControl,
} from './computer-use';

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
  for (const command of ['status', 'stop', 'resume', 'request_permissions', 'restart_app']) {
    assert.equal(uiComputerPath('POST', command), `/api/computer/${command}`);
  }
  for (const command of ['click', 'type', 'key', 'screenshot', 'move', 'drag', 'scroll', 'wait', '..%2Fstatus', '']) {
    assert.equal(uiComputerPath('POST', command), null, command);
    assert.equal(uiComputerPath('GET', command), null, command);
  }
  assert.equal(uiComputerPath('GET', 'stop'), null);
  assert.equal(uiComputerPath('GET', 'resume'), null);
  // Setup commands change the machine: never a GET (a link or a prefetch could fire them).
  assert.equal(uiComputerPath('GET', 'request_permissions'), null);
  assert.equal(uiComputerPath('GET', 'restart_app'), null);
});

test('the UI status poll (GET) is relayed upstream as POST /api/computer/status, the only route the daemon has', async () => {
  const { uiComputerUpstream } = await import('./computer-use');
  assert.deepEqual(uiComputerUpstream('GET', 'status'), { method: 'POST', path: '/api/computer/status' });
  for (const command of ['status', 'stop', 'resume', 'request_permissions', 'restart_app']) {
    assert.deepEqual(uiComputerUpstream('POST', command), { method: 'POST', path: `/api/computer/${command}` });
  }
  assert.equal(uiComputerUpstream('GET', 'stop'), null);
  assert.equal(uiComputerUpstream('GET', 'click'), null);
});

test('parseComputerSetup keeps only known prerequisites and reads anything else as unreachable', () => {
  const setup = parseComputerSetup({ ok: true, result: { platform: 'darwin', available: false, needsRestart: true, checks: { desktop: 'ok', screen: 'missing', accessibility: 'ok', bogus: 'ok', inputTool: 'maybe' } } });
  assert.deepEqual(setup, { reachable: true, platform: 'darwin', available: false, needsRestart: true, checks: { desktop: 'ok', screen: 'missing', accessibility: 'ok' } });
  assert.deepEqual(parseComputerSetup(null), COMPUTER_UNREACHABLE);
  assert.deepEqual(parseComputerSetup({ active: true }), COMPUTER_UNREACHABLE, 'an older desktop without checks');
});

test('the setup calls go through the UI proxy and fail soft', async () => {
  const real = globalThis.fetch;
  const calls: Array<{ url: string; method: string }> = [];
  let status = 200;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? 'GET' });
    return new Response(JSON.stringify({ checks: { desktop: 'ok' }, available: true }), { status });
  }) as typeof fetch;
  try {
    assert.equal((await fetchComputerSetup()).available, true);
    assert.equal(await requestComputerPermissions(), true);
    assert.equal(await restartComputerApp(), true);
    assert.deepEqual(calls, [
      { url: '/api/ui/computer/status', method: 'GET' },
      { url: '/api/ui/computer/request_permissions', method: 'POST' },
      { url: '/api/ui/computer/restart_app', method: 'POST' },
    ]);
    status = 503;
    assert.deepEqual(await fetchComputerSetup(), COMPUTER_UNREACHABLE);
    assert.equal(await requestComputerPermissions(), false);
    globalThis.fetch = (async () => { throw new Error('offline'); }) as typeof fetch;
    assert.equal(await restartComputerApp(), false);
  } finally {
    globalThis.fetch = real;
  }
});
