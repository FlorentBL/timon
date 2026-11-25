import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accessSync, chmodSync, constants, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix, sep, win32 } from 'node:path';
import { daemonNode, launchPath, nodeInDir, nodelessBackends, nodelessBackendText, pathKeyOf, runsOnNode, withLaunchPath } from './launch-path.js';
import { binaryCandidates } from './binary-path.js';

const nvmBin = posix.join('/Users', 'sam', '.nvm', 'versions', 'node', 'v22.11.0', 'bin');
const servicePath = [posix.join('/Users', 'sam', '.local', 'bin'), '/usr/bin', '/bin'].join(posix.delimiter); // portability: simulated macOS PATH
const nodeAt = (dirs: string[]) => (dir: string) => dirs.includes(dir);

test('a CLI resolved under nvm puts its folder, and the node beside it, first', () => {
  const path = launchPath(servicePath, {
    platform: 'darwin', binary: posix.join(nvmBin, 'codex'), hasNode: nodeAt([nvmBin]),
    findNode: () => { throw new Error('node is already beside codex'); },
  });
  assert.deepEqual(path.split(posix.delimiter), [nvmBin, ...servicePath.split(posix.delimiter)]);
});

test('a CLI already on PATH changes nothing', () => {
  const path = launchPath(`${nvmBin}${posix.delimiter}/usr/bin`, { // portability: simulated PATH
    platform: 'darwin', binary: posix.join(nvmBin, 'codex'), hasNode: nodeAt([nvmBin]),
  });
  assert.equal(path, `${nvmBin}${posix.delimiter}/usr/bin`); // portability: simulated PATH
});

test('a native CLI still gets a node for the MCP servers it starts, appended last', () => {
  const claude = posix.join('/Users', 'sam', '.local', 'bin', 'claude');
  const path = launchPath(servicePath, {
    platform: 'darwin', binary: claude, hasNode: () => false, findNode: () => posix.join(nvmBin, 'node'),
  });
  assert.deepEqual(path.split(posix.delimiter), [...servicePath.split(posix.delimiter), nvmBin]);
});

test('no node anywhere leaves PATH as it was', () => {
  assert.equal(launchPath(servicePath, { platform: 'darwin', hasNode: () => false, findNode: () => null }), servicePath);
});

test('the Electron runtime is never offered as node', () => {
  const electron = posix.join('/Applications', 'Timon.app', 'Contents', 'MacOS', 'Timon');
  const path = launchPath(servicePath, {
    platform: 'darwin', hasNode: () => false, findNode: () => electron, selfExecutable: electron,
  });
  assert.equal(path, servicePath);
});

test('Windows: codex.cmd in %APPDATA%\\npm brings its folder, node comes from nvm-windows', () => {
  const npm = win32.join('C:\\', 'Users', 'sam', 'AppData', 'Roaming', 'npm');
  const nvmLink = win32.join('C:\\', 'nvm4w', 'nodejs');
  const system = ['C:\\Windows\\system32', 'C:\\Windows'].join(win32.delimiter);
  const path = launchPath(system, {
    platform: 'win32', binary: win32.join(npm, 'codex.cmd'), hasNode: nodeAt([nvmLink]),
    findNode: () => win32.join(nvmLink, 'node.exe'),
  });
  assert.deepEqual(path.split(win32.delimiter), [npm, ...system.split(win32.delimiter), nvmLink]);
});

test('Windows compares folders without case nor trailing separator', () => {
  const npm = win32.join('C:\\', 'Users', 'sam', 'AppData', 'Roaming', 'npm');
  const path = launchPath(`c:\\users\\SAM\\appdata\\roaming\\npm\\${win32.delimiter}C:\\Windows`, {
    platform: 'win32', binary: win32.join(npm, 'codex.cmd'), hasNode: () => true,
  });
  assert.equal(path.split(win32.delimiter).length, 2);
});

test('Windows: the existing Path key is rewritten, never doubled', () => {
  const npm = win32.join('C:\\', 'npm');
  const env = withLaunchPath({ Path: 'C:\\Windows', SystemRoot: 'C:\\Windows' }, {
    platform: 'win32', binary: win32.join(npm, 'codex.cmd'), hasNode: () => true,
  });
  assert.deepEqual(Object.keys(env).filter((key) => key.toUpperCase() === 'PATH'), ['Path']);
  assert.equal(env.Path, [npm, 'C:\\Windows'].join(win32.delimiter));
  assert.equal(pathKeyOf({ PATH: 'x' }, 'win32'), 'PATH');
  assert.equal(pathKeyOf({ Path: 'system', PATH: 'spec' }, 'win32'), 'PATH', 'the most specific layer wins');
  assert.equal(pathKeyOf({ Path: 'x' }, 'linux'), 'PATH');
});

test('withLaunchPath returns the same object when nothing changes', () => {
  const env = { PATH: servicePath };
  assert.equal(withLaunchPath(env, { platform: 'darwin', hasNode: () => true }), env);
});

test('runsOnNode reads the shebang, and the npm shim on Windows', () => {
  const read = (text: string) => () => text;
  assert.equal(runsOnNode('codex', 'darwin', read('#!/usr/bin/env node\nimport x;')), true);
  assert.equal(runsOnNode('codex', 'linux', read('#!/usr/bin/env -S node --no-warnings\n')), true);
  assert.equal(runsOnNode('claude', 'darwin', read('\u007fELF\u0002')), false);
  assert.equal(runsOnNode('tool', 'linux', read('#!/bin/sh\nexec node x')), false);
  assert.equal(runsOnNode('codex.cmd', 'win32', read('@ECHO off\r\nSET _prog=node\r\n')), true);
  assert.equal(runsOnNode('codex.exe', 'win32', read('MZ node')), false);
  assert.equal(runsOnNode('missing', 'linux', () => { throw new Error('ENOENT'); }), false);
});

test('nodeInDir finds an executable node on disk', { skip: process.platform === 'win32' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'launch-path-'));
  try {
    mkdirSync(join(dir, 'bin'));
    assert.equal(nodeInDir(join(dir, 'bin'), process.platform), false);
    writeFileSync(join(dir, 'bin', 'node'), '');
    chmodSync(join(dir, 'bin', 'node'), 0o644);
    assert.equal(nodeInDir(join(dir, 'bin'), process.platform), false);
    chmodSync(join(dir, 'bin', 'node'), 0o755);
    assert.equal(nodeInDir(join(dir, 'bin'), process.platform), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('nodelessBackends names a Node CLI only when no node is reachable', () => {
  const codex = posix.join(nvmBin, 'codex');
  const claude = posix.join('/Users', 'sam', '.local', 'bin', 'claude');
  const files: Record<string, string> = { [codex]: '#!/usr/bin/env node\n', [claude]: '\u007fELF' };
  const read = (file: string) => files[file] ?? '';
  const found = (node: string | null) => (name: string) => (name === 'node' ? node : name === 'codex' ? codex : name === 'claude' ? claude : null);
  assert.deepEqual(nodelessBackends(['claude', 'codex', 'grok'], { platform: 'darwin', resolve: found(null), read, hasNode: () => false }),
    [{ name: 'codex', path: codex }]);
  assert.deepEqual(nodelessBackends(['codex'], { platform: 'darwin', resolve: found(posix.join(nvmBin, 'node')), read, hasNode: () => false }), []);
  assert.deepEqual(nodelessBackends(['codex'], { platform: 'darwin', resolve: found(null), read, hasNode: nodeAt([nvmBin]) }), []);
  assert.match(nodelessBackendText({ name: 'codex', path: codex }), /codex .* runs on Node\.js/);
  // The daemon's own Node is what a launch falls back on: such a CLI starts.
  assert.deepEqual(nodelessBackends(['codex'], {
    platform: 'darwin', resolve: found(null), read, hasNode: () => false, runtimeNode: posix.join('/opt', 'Timon', 'resources', 'node', 'node'),
  }), []);
  // The text gives the gesture, not only the diagnosis.
  assert.match(nodelessBackendText({ name: 'codex', path: codex }), /host\.binaries\.node/);
});

test('#1102: the daemon\'s own Node is the last resort, after the machine\'s', () => {
  const bundled = posix.join('/opt', 'Timon', 'resources', 'node', 'node');
  const fnm = posix.join('/home', 'sam', '.local', 'share', 'fnm', 'node-versions', 'v22.1.0', 'installation', 'bin');
  const linuxPath = ['/usr/bin', '/bin'].join(posix.delimiter); // portability: simulated Linux PATH
  // The machine's own node wins.
  assert.deepEqual(launchPath(linuxPath, {
    platform: 'linux', hasNode: () => false, findNode: () => posix.join(fnm, 'node'), runtimeNode: bundled,
  }).split(posix.delimiter), [...linuxPath.split(posix.delimiter), fnm]);
  // None on the machine: the daemon's runtime.
  assert.deepEqual(launchPath(linuxPath, {
    platform: 'linux', hasNode: () => false, findNode: () => null, runtimeNode: bundled,
  }).split(posix.delimiter), [...linuxPath.split(posix.delimiter), posix.dirname(bundled)]);
  // A node already on PATH: nothing added.
  assert.equal(launchPath(linuxPath, { platform: 'linux', hasNode: () => true, findNode: () => null, runtimeNode: bundled }), linuxPath);
  // Electron is never offered, whichever way it arrives.
  const electron = posix.join('/opt', 'Timon', 'timon');
  assert.equal(launchPath(linuxPath, {
    platform: 'linux', hasNode: () => false, findNode: () => electron, runtimeNode: electron, selfExecutable: electron,
  }), linuxPath);
  assert.deepEqual(launchPath(linuxPath, {
    platform: 'linux', hasNode: () => false, findNode: () => electron, runtimeNode: bundled, selfExecutable: electron,
  }).split(posix.delimiter), [...linuxPath.split(posix.delimiter), posix.dirname(bundled)]);
});

test('#1102: daemonNode is the runtime only when it is a node, never Electron', () => {
  const bundled = posix.join('/opt', 'Timon', 'resources', 'node', 'node');
  assert.equal(daemonNode({ execPath: bundled, platform: 'linux' }), bundled);
  assert.equal(daemonNode({ execPath: bundled, electron: '33.0.0', platform: 'linux' }), null);
  assert.equal(daemonNode({ execPath: posix.join('/opt', 'Timon', 'timon'), platform: 'linux' }), null);
  assert.equal(daemonNode({ execPath: posix.join('/usr', 'bin', 'nodejs'), platform: 'linux' }), null);
  assert.equal(daemonNode({ execPath: 'node', platform: 'linux' }), null);
  const windows = win32.join('C:\\', 'Program Files', 'Timon', 'resources', 'node', 'node.exe');
  assert.equal(daemonNode({ execPath: windows, platform: 'win32' }), windows);
  assert.equal(daemonNode({ execPath: win32.join('C:\\', 'Program Files', 'Timon', 'Timon.exe'), platform: 'win32' }), null);
});

/**
 * What `npm install -g @openai/codex` leaves under a prefix: `bin/codex`, a link to the JS
 * launcher, and the native build in the package's `vendor` folder. No node beside it.
 */
function fakeCodexPackage(prefix: string): { launcher: string; native: string } {
  const pkg = join(prefix, 'lib', 'node_modules', '@openai', 'codex');
  const script = join(pkg, 'bin', 'codex.js');
  mkdirSync(join(pkg, 'bin'), { recursive: true });
  writeFileSync(script, '#!/usr/bin/env node\nrequire("./launch");\n');
  chmodSync(script, 0o755);
  const native = join(pkg, 'vendor', 'x86_64-unknown-linux-musl', 'codex', 'codex');
  mkdirSync(join(native, '..'), { recursive: true });
  writeFileSync(native, '\u007fELF');
  chmodSync(native, 0o755);
  mkdirSync(join(prefix, 'bin'), { recursive: true });
  const launcher = join(prefix, 'bin', 'codex');
  symlinkSync(script, launcher);
  return { launcher, native };
}

test('#1102: an npm codex with its node under fnm starts, and doctor stays quiet', { skip: process.platform === 'win32' && 'POSIX layout and links' }, (t) => {
  const home = mkdtempSync(join(tmpdir(), 'timon-fnm-codex-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const { launcher } = fakeCodexPackage(join(home, '.npm-global'));
  const options = { platform: 'linux' as const, path: '', homeDir: home, env: {} };
  // Only the fake home counts: a CI runner has its own node in /usr/local/bin.
  const resolve = (name: string) => binaryCandidates(name, options)
    .filter((file) => file.startsWith(home + sep))
    .find((file) => { try { accessSync(file, constants.X_OK); return statSync(file).isFile(); } catch { return false; } }) ?? null;
  assert.equal(resolve('codex'), launcher);
  assert.equal(runsOnNode(launcher, 'linux'), true);
  // No node on the machine yet: doctor names codex, and only the daemon's own Node would rescue it.
  assert.equal(resolve('node'), null);
  assert.deepEqual(nodelessBackends(['codex'], { platform: 'linux', resolve }), [{ name: 'codex', path: launcher }]);
  // fnm installs a node only its shell hook lists: the daemon finds it on its own.
  const fnmBin = join(home, '.local', 'share', 'fnm', 'node-versions', 'v22.1.0', 'installation', 'bin');
  mkdirSync(fnmBin, { recursive: true });
  writeFileSync(join(fnmBin, 'node'), '#!/bin/sh\n');
  chmodSync(join(fnmBin, 'node'), 0o755);
  assert.equal(resolve('node'), join(fnmBin, 'node'));
  assert.deepEqual(nodelessBackends(['codex'], { platform: 'linux', resolve }), []);
  // `/usr/bin` stands for a service PATH with no node: the host's own is not consulted.
  const hasNode = (dir: string) => dir.startsWith(home + sep) && nodeInDir(dir, 'linux');
  const path = launchPath('/usr/bin', { platform: 'linux', binary: launcher, hasNode, findNode: () => resolve('node') }); // portability: simulated Linux PATH
  assert.deepEqual(path.split(':'), [join(home, '.npm-global', 'bin'), '/usr/bin', fnmBin]); // portability: simulated Linux PATH
});
