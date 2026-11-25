/**
 * The notice of a path the mission fence refused names the fence, the path and
 * the setting, with the gesture that fits where the path is.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fenceRefusalEndsTurn, fenceRefusalNotice, fenceSuspicionNotice } from './fence-refusal-notice';
import { setLocale } from './i18n';
import './i18n-test-locales';

const BASE = { path: '/home/u/.timon/provider-runs/p/m/config.toml', display: '~/.timon/provider-runs/p/m/config.toml', access: 'read', mechanism: 'landlock', backend: 'codex' };

test('a path of the Timon home: a defect of Timon, with the workaround', () => {
  setLocale('en');
  const notice = fenceRefusalNotice({ ...BASE, stage: 'launch', timonHome: true, grantable: false });
  assert.match(notice, /Mission not started/);
  assert.match(notice, /Landlock/);
  assert.match(notice, /read ~\/\.timon\/provider-runs\/p\/m\/config\.toml/);
  assert.match(notice, /defect of Timon/);
  assert.match(notice, /Settings → System → Security/);
  assert.doesNotMatch(notice, /chatPage\./, 'unresolved i18n key');
  assert.equal(fenceRefusalEndsTurn({ stage: 'launch' }), true);
});

test('a folder an exception may open: the exception, from the next mission', () => {
  setLocale('en');
  const notice = fenceRefusalNotice({ ...BASE, display: '~/.cache/tool', access: 'write', mechanism: 'seatbelt', stage: 'run', timonHome: false, grantable: true });
  assert.doesNotMatch(notice, /Mission not started/);
  assert.match(notice, /write to ~\/\.cache\/tool/);
  assert.match(notice, /macOS sandbox/);
  assert.match(notice, /writable exceptions/);
  assert.equal(fenceRefusalEndsTurn({ stage: 'run' }), false);
});

test('a credential folder or a damaged payload: a readable sentence, never "undefined"', () => {
  setLocale('en');
  const notice = fenceRefusalNotice({ display: '~/.ssh/id_ed25519', timonHome: false, grantable: false });
  assert.match(notice, /always keeps this folder from missions/);
  const damaged = fenceRefusalNotice({});
  assert.doesNotMatch(damaged, /undefined|chatPage\./);
});

test('a refusal naming no path: the words of the CLI, the fence as the likely cause, and where it is set', () => {
  setLocale('en');
  const notice = fenceSuspicionNotice({ said: 'Operation not permitted (os error 1)', mechanism: 'seatbelt', backend: 'codex' });
  assert.match(notice, /codex CLI stopped on “Operation not permitted \(os error 1\)” without naming a path/);
  assert.match(notice, /macOS sandbox/);
  assert.match(notice, /extra folders/);
  assert.match(notice, /Settings → System → Security/);
  assert.doesNotMatch(fenceSuspicionNotice({}), /undefined|chatPage\./);
  setLocale('fr');
  assert.match(fenceSuspicionNotice({ said: 'EPERM', mechanism: 'landlock', backend: 'codex' }), /clôture des missions \(Landlock\)/);
  setLocale('en');
});
