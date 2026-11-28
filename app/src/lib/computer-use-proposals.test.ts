import assert from 'node:assert/strict';
import test from 'node:test';
import { appsAfter, enabledAfter, openAppName, parseComputerUseProposal } from './computer-use-proposals';

const payload = {
  agent: 'support.tim', addApps: [{ app: 'discord', mode: 'foreground' }, { app: 'notepad', mode: 'background' }], removeApps: ['SLACK'], enable: true,
  before: { enabled: false, apps: [{ app: 'Notepad', mode: 'foreground' }, { app: 'Slack', mode: 'foreground' }], defaultMode: 'foreground' }, expiresAt: 5,
};

test('a stored proposal is read, and anything else is not', () => {
  assert.equal(parseComputerUseProposal(payload)?.agent, 'support.tim');
  assert.equal(parseComputerUseProposal({ ...payload, before: null }), null);
  assert.equal(parseComputerUseProposal({ ...payload, addApps: [1] }), null);
  assert.equal(parseComputerUseProposal('x'), null);
});

test('a card drawn before the modes existed reads as the foreground; modes are read from newer ones', () => {
  const old = parseComputerUseProposal({ agent: 'a', addApps: ['Discord'], removeApps: [], before: { enabled: true, apps: ['Notepad'] }, expiresAt: 1 })!;
  assert.deepEqual(old.addApps, [{ app: 'Discord', mode: 'foreground' }]);
  assert.deepEqual(old.before.apps, [{ app: 'Notepad', mode: 'foreground' }]);
  const modes = parseComputerUseProposal(payload)!;
  assert.deepEqual(modes.addApps.map((a) => a.mode), ['foreground', 'background']);
  assert.equal(parseComputerUseProposal({ ...payload, addApps: [{ app: 3 }] }), null);
});

test('the list after adds without a duplicate (case apart), removes by name, and the switch follows enable', () => {
  const p = parseComputerUseProposal(payload)!;
  assert.deepEqual(appsAfter(p), [{ app: 'Notepad', mode: 'background' }, { app: 'discord', mode: 'foreground' }], 'a listed application changes mode, the first spelling stays');
  assert.equal(enabledAfter(p), true);
  assert.equal(enabledAfter({ ...p, enable: undefined }), false);
});

test('an open window names an application as the system does, only when it is unambiguous and different', () => {
  const windows = [{ app: 'Discord' }, { app: 'Discord' }, { app: 'Slack' }, { app: 'Notes' }, { app: 'Notepad' }];
  assert.equal(openAppName('discord', windows), 'Discord');
  assert.equal(openAppName('Discord', windows), null, 'already spelled that way');
  assert.equal(openAppName('Note', windows), null, 'two applications match');
  assert.equal(openAppName('Zoom', windows), null, 'not open: kept as written');
  assert.equal(openAppName('slack.exe', windows), 'Slack');
});
