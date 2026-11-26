/**
 * The refusal of a browser command nobody answers (`built-in-browser.ts`): on a server it names
 * the browser host and its repair, and tells an agent not to insist.
 */
import './test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { browserUnavailableRefusal, builtInBrowserRefusal, resetBrowserUnavailableRefusal } from './built-in-browser.js';
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

test('the refusal is read once per few seconds, and a report that throws falls back on the desktop message', () => {
  resetBrowserUnavailableRefusal();
  let reads = 0;
  const read = () => { reads += 1; return serverDown; };
  assert.equal(browserUnavailableRefusal(1_000, read).code, 'browser_host_stopped');
  assert.equal(browserUnavailableRefusal(3_000, read).code, 'browser_host_stopped');
  assert.equal(reads, 1);
  resetBrowserUnavailableRefusal();
  assert.equal(browserUnavailableRefusal(10_000, () => { throw new Error('systemd away'); }).code, 'browser_desktop_unavailable');
  resetBrowserUnavailableRefusal();
});
