/**
 * The refusal of a browser command nobody answers (`built-in-browser.ts`): on a server it names
 * the browser host and its repair, and tells an agent not to insist.
 */
import './test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  browserUnavailableRefusal, builtInBrowserProbe, builtInBrowserRefusal, sharedProbe, type BuiltInBrowserRead,
} from './built-in-browser.js';
import type { BuiltInBrowserReport } from './plugins/contract/system.js';

const serverDown: BuiltInBrowserReport = {
  provider: 'none', server: true, unit: 'timon-browser-abc',
  problems: [{ id: 'host-unit-stopped', blocking: true, message: 'the browser host service is stopped (failed).', fix: 'systemctl --user restart timon-browser-abc' }],
};

test('a server names its stopped browser host and the command, never the desktop app', () => {
  const body = builtInBrowserRefusal(serverDown);
  assert.equal(body.code, 'browser_host_stopped');
  assert.deepEqual(body.params, { command: 'systemctl --user restart timon-browser-abc' });
  assert.match(body.error, /built-in browser of this server is not running: the browser host service is stopped/);
  assert.match(body.error, /Do not retry the browser: tell the user/);
  assert.doesNotMatch(body.error, /Timon desktop/);
  assert.doesNotMatch(JSON.stringify(body), /provider\.json|token/i);
});

test('a live provider that does not answer still gets a repair on a server', () => {
  const body = builtInBrowserRefusal({ provider: 'host', server: true, unit: 'timon-browser-abc', problems: [] });
  assert.equal(body.code, 'browser_host_stopped');
  assert.equal(body.params?.command, 'systemctl --user restart timon-browser-abc');
});

test('a machine with a screen keeps the desktop message, and an agent is told not to insist', () => {
  const body = builtInBrowserRefusal({ provider: 'none', server: false, unit: null, problems: [] });
  assert.equal(body.code, 'browser_desktop_unavailable');
  assert.match(body.error, /^Open Timon desktop on the host machine/);
  assert.match(body.error, /Do not retry the browser/);
});

const read = (report: BuiltInBrowserReport, degraded = false): BuiltInBrowserRead => ({ report, degraded });

test('ten callers at once share one read, and the event loop keeps turning while it runs', async () => {
  let reads = 0;
  let ticked = false;
  const probe = builtInBrowserProbe(() => {
    reads += 1;
    // A read that takes 200 ms of waiting, as systemctl on a slow systemd.
    return new Promise((resolve) => setTimeout(() => resolve(read(serverDown)), 200));
  });
  const timer = setTimeout(() => { ticked = true; }, 50);
  const bodies = await Promise.all(Array.from({ length: 10 }, () => browserUnavailableRefusal(probe)));
  clearTimeout(timer);
  assert.equal(reads, 1);
  assert.equal(ticked, true, 'a 50 ms timer fired during the read');
  assert.ok(bodies.every((body) => body.code === 'browser_host_stopped'));
});

test('an answer is kept a few seconds, a partial one or a failure longer', async () => {
  let clock = 1_000;
  let reads = 0;
  let next: () => Promise<BuiltInBrowserRead> = async () => read(serverDown);
  const probe = builtInBrowserProbe(() => { reads += 1; return next(); }, () => clock);
  await browserUnavailableRefusal(probe);
  clock += 4_000;
  await browserUnavailableRefusal(probe);
  assert.equal(reads, 1, 'kept 5 s');
  clock += 2_000;
  next = async () => read(serverDown, true);
  await browserUnavailableRefusal(probe);
  assert.equal(reads, 2);
  clock += 20_000;
  await browserUnavailableRefusal(probe);
  assert.equal(reads, 2, 'a systemctl that timed out is not asked again for 30 s');
  clock += 11_000;
  next = async () => { throw new Error('systemd away'); };
  assert.equal((await browserUnavailableRefusal(probe)).code, 'browser_desktop_unavailable', 'a read that throws falls back on the desktop message');
  assert.equal(reads, 3);
  clock += 20_000;
  await browserUnavailableRefusal(probe);
  assert.equal(reads, 3, 'a failed read is kept 30 s too');
});

test('a read that never ends gives up at its deadline instead of holding every caller', async () => {
  const probe = sharedProbe<string>({
    read: () => new Promise<string>(() => {}),
    fallback: () => 'fallback',
    failed: () => false,
    ttlMs: 5_000, failureTtlMs: 30_000, deadlineMs: 30,
  });
  assert.equal(await probe.get(), 'fallback');
  assert.equal(probe.latest(), 'fallback');
});

test('latest() never waits: nothing before the first read, then the last answer while a new one runs', async () => {
  let clock = 0;
  let reads = 0;
  const probe = sharedProbe<number>({
    read: async () => { reads += 1; return reads; },
    fallback: () => -1, failed: () => false,
    ttlMs: 5_000, failureTtlMs: 30_000, deadlineMs: 1_000, now: () => clock,
  });
  assert.equal(probe.latest(), undefined);
  assert.equal(await probe.get(), 1, 'latest() started the read the next caller shares');
  clock += 6_000;
  assert.equal(probe.latest(), 1);
  assert.equal(await probe.get(), 2);
  probe.reset();
  assert.equal(probe.latest(), undefined);
});
