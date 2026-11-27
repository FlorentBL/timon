import assert from 'node:assert/strict';
import test from 'node:test';
import { ComputerCommandError, parseAllowedApps, parseComputerCommand } from './computer-use-protocol.js';
import type { SystemCommand } from './computer-use-input.js';
import { focusWindow, isAppAllowed, listWindows, readForegroundApp, windowApp } from './computer-use-windows.js';

test('the allow-list compares case-insensitively with the bundle id, the displayed name or the executable', () => {
  const app = { bundle: 'com.microsoft.VSCode', name: 'Visual Studio Code', exe: 'Code' };
  for (const entry of ['com.microsoft.vscode', 'VISUAL STUDIO CODE', 'code', ' Code ', 'code.exe']) assert.equal(isAppAllowed(app, [entry]), true, entry);
  assert.equal(isAppAllowed({ name: 'Notepad', exe: 'notepad' }, ['Notepad.EXE']), true);
  assert.equal(isAppAllowed(app, ['Cod']), false, 'no partial match');
  assert.equal(isAppAllowed(app, []), false, 'an empty list allows nothing');
  assert.equal(isAppAllowed(app, ['', '  ']), false);
  assert.equal(isAppAllowed(null, ['code']), false);
});

test('Windows: reads go through the worker, as one JSON line', async () => {
  const seen: SystemCommand[] = [];
  const exec = async (command: SystemCommand) => {
    seen.push(command);
    const query = JSON.parse(command.worker!.input) as { q: string };
    if (query.q === 'foreground') return { stdout: '{"name":"Notepad","exe":"notepad"}' };
    if (query.q === 'windows') return { stdout: '[{"id":"197284","title":"a.txt - Notepad","app":"Notepad","exe":"notepad","focused":true}]' };
    return { stdout: '{"ok":true}' };
  };
  assert.deepEqual(await readForegroundApp('win32', exec), { name: 'Notepad', exe: 'notepad' });
  assert.deepEqual(await listWindows('win32', exec), [{ id: '197284', title: 'a.txt - Notepad', app: 'Notepad', focused: true }]);
  assert.deepEqual(await windowApp('win32', exec, '197284'), { name: 'Notepad', exe: 'notepad' });
  assert.equal(await focusWindow('win32', exec, '197284'), true);
  assert.ok(seen.every((c) => c.file === 'powershell.exe' && c.worker?.reply === true));
  assert.equal(JSON.parse(seen.at(-1)!.env!.TIMON_CU_QUERY!).id, '197284', 'the one-shot form carries the same request');
});

test('Linux: xdotool lists visible windows, names their application and activates one', async () => {
  const calls: string[] = [];
  const exec = async (command: SystemCommand) => {
    calls.push([command.file, ...command.args].join(' '));
    const [verb, id] = command.args;
    if (command.file === 'ps') return { stdout: 'firefox\n' };
    if (verb === 'getactivewindow') return { stdout: '4242\n' };
    if (verb === 'search') return { stdout: '4242\n9001\n; rm -rf /\n' };
    if (verb === 'getwindowname') return { stdout: id === '4242' ? 'Docs - Firefox\n' : 'Terminal\n' };
    if (verb === 'getwindowpid') return { stdout: id === '4242' ? '77\n' : '78\n' };
    if (verb === 'getwindowclassname') return { stdout: id === '4242' ? 'Navigator\n' : 'XTerm\n' };
    return { stdout: '' };
  };
  const windows = await listWindows('linux', exec);
  assert.deepEqual(windows.map((w) => [w.id, w.title, w.app, w.focused]), [['4242', 'Docs - Firefox', 'Navigator', true], ['9001', 'Terminal', 'XTerm', false]]);
  assert.ok(!calls.some((line) => line.includes('rm -rf')), 'a line that is not a window number is never used');
  assert.deepEqual(await readForegroundApp('linux', exec), { name: 'Navigator', exe: 'firefox' });
  assert.equal(await focusWindow('linux', exec, '9001'), true);
  assert.equal(calls.at(-1), 'xdotool windowactivate --sync 9001');
});

test('macOS: the foreground application and the window list come from fixed JXA scripts', async () => {
  const exec = async (command: SystemCommand) => {
    assert.equal(command.file, 'osascript');
    return { stdout: command.args[3]!.includes('frontmostApplication') ? '{"bundle":"com.apple.Safari","name":"Safari","exe":"Safari"}' : '[]' };
  };
  assert.deepEqual(await readForegroundApp('darwin', exec), { bundle: 'com.apple.Safari', name: 'Safari', exe: 'Safari' });
  assert.deepEqual(await listWindows('darwin', exec), []);
  assert.equal(await focusWindow('darwin', async (command) => { assert.equal(command.args.at(-1), '[12,3]'); return { stdout: 'ok' }; }, '12:3'), true);
  assert.equal(await focusWindow('darwin', exec, 'a:b'), false, 'a malformed id never reaches the script');
});

test('a failing or garbled read gives no application', async () => {
  assert.equal(await readForegroundApp('darwin', async () => { throw new Error('boom'); }), null);
  assert.equal(await readForegroundApp('win32', async () => ({ stdout: 'not json' })), null);
  assert.deepEqual(await listWindows('win32', async () => ({ stdout: '[{"id":"../x","title":"t","app":"A"}]' })), [], 'an id that is not plain is dropped');
});

test('the new commands and the allowed list are validated', () => {
  assert.deepEqual(parseComputerCommand('list_windows', {}), { command: 'list_windows' });
  assert.deepEqual(parseComputerCommand('focus_window', { id: '12:3' }), { command: 'focus_window', id: '12:3' });
  for (const id of [undefined, '', '../x', 'a b', 5]) assert.throws(() => parseComputerCommand('focus_window', { id }), ComputerCommandError);
  assert.deepEqual(parseAllowedApps(undefined), []);
  assert.deepEqual(parseAllowedApps(['Notepad']), ['Notepad']);
  assert.throws(() => parseAllowedApps('Notepad'), ComputerCommandError);
  assert.throws(() => parseAllowedApps([1]), ComputerCommandError);
});
