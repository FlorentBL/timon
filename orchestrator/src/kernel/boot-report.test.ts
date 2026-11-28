/**
 * The kernel boot's sentences (TODO #545): the plugin failure title lands in
 * every tester's notification centre, so it must be English.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { builtInBrowserBootLines, kernelBootSummary, pluginFailureNotification } from './boot-report.js';
import type { EntryDecision } from './registry.js';

const FRENCH = /[àâäçéèêëîïôöùûüÿœæ]|a échoué|profil=|édition=|capacités=|désactivé|actif\(s\)/i; // french-ok: the French the boot report used to print

function decision(id: string, disabled: boolean, reason: string | null = null): EntryDecision {
  return { id, name: `@timon/${id}`, tier: 'opt', disabled, reason, missing: [], config: {} };
}

test('a failing plugin raises an English alert that names it', () => {
  const n = pluginFailureNotification('acme-widget', 'boom');
  assert.equal(n.title, 'Plugin acme-widget failed');
  assert.equal(n.body, 'boom');
  assert.equal(n.source, 'plugin:acme-widget');
  assert.equal(n.type, 'alert');
  assert.deepEqual(n.message, { code: 'plugin_failed', params: { id: 'acme-widget' } });
  assert.doesNotMatch(n.title, FRENCH);
});

test('the boot summary is English and lists what is off, and why', () => {
  const line = kernelBootSummary({
    profile: 'expert',
    edition: 'pro',
    licenseStatus: 'valid',
    licenseReason: null,
    capabilities: ['systemd', 'docker'],
    decisions: [decision('kanban', false), decision('telegram', true, 'disabled in config')],
  });
  assert.equal(
    line,
    '[kernel] profile=expert edition=pro licence=valid capabilities=[systemd, docker]'
    + ' — 1 module(s) active, 1 disabled: telegram (disabled in config)',
  );
  assert.doesNotMatch(line, FRENCH);
});

test('the licence reason follows its status, and nothing is listed when every module runs', () => {
  const line = kernelBootSummary({
    profile: 'lite', edition: 'free', licenseStatus: 'expired', licenseReason: 'offline',
    capabilities: [], decisions: [decision('kanban', false)],
  });
  assert.equal(line, '[kernel] profile=lite edition=free licence=expired:offline capabilities=[] — 1 module(s) active');
});

test('the start-up log names who provides the built-in browser, or why nobody does and the repair', () => {
  assert.deepEqual(builtInBrowserBootLines({ provider: 'host', server: true, unit: 'timon-browser-x', problems: [] }),
    ['[browser] built-in browser provided by the browser host (timon-browser-x)']);
  const lines = builtInBrowserBootLines({
    provider: 'none', server: true, unit: 'timon-browser-x', problems: [
      { id: 'host-unit-missing', blocking: true, message: 'the browser host service is not installed.', fix: 'timon service install' },
      { id: 'no-fonts', blocking: false, message: 'no font is installed.', fix: 'sudo apt-get install fonts-liberation' },
    ],
  });
  assert.deepEqual(lines, [
    '[browser] built-in browser unavailable',
    '[browser] the browser host service is not installed. Fix: timon service install',
    '[browser] warning: no font is installed. Fix: sudo apt-get install fonts-liberation',
  ]);
  for (const line of lines) assert.doesNotMatch(line, FRENCH);
});
