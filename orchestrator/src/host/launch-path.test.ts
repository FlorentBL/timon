import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accessSync, chmodSync, constants, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix, sep, win32 } from 'node:path';
import {
  checkDaemonNode, chooseLaunchNode, daemonNode, designatesDaemonRuntime, launchPath, nodeInDir, nodeInterpreter, nodelessBackends,
  nodelessBackendText, pathKeyOf, runsOnNode, withLaunchPath,
} from './launch-path.js';
import { binaryCandidates } from './binary-path.js';

const nvmBin = posix.join('/Users', 'sam', '.nvm', 'versions', 'node', 'v22.11.0', 'bin');
const servicePath = [posix.join('/Users', 'sam', '.local', 'bin'), '/usr/bin', '/bin'].join(posix.delimiter); // portability: simulated macOS PATH
const nodeAt = (dirs: string[]) => (dir: string) => dirs.includes(dir);

test('a CLI resolved under nvm puts its folder, and the node beside it, first', () => {
  const path = launchPath(servicePath, {
    platform: 'darwin', binary: posix.join(nvmBin, 'codex'), hasNode: nodeAt([nvmBin]), node: posix.join('/usr', 'local', 'bin', 'node'),
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
    platform: 'darwin', binary: claude, hasNode: () => false, node: posix.join(nvmBin, 'node'),
  });
  assert.deepEqual(path.split(posix.delimiter), [...servicePath.split(posix.delimiter), nvmBin]);
});

test('no node anywhere leaves PATH as it was', () => {
  assert.equal(launchPath(servicePath, { platform: 'darwin', hasNode: () => false, node: null }), servicePath);
});

test('the Electron runtime is never offered as node', () => {
  const electron = posix.join('/Applications', 'Timon.app', 'Contents', 'MacOS', 'Timon');
  assert.equal(chooseLaunchNode({
    platform: 'darwin', findNode: () => electron, selfExecutable: electron, runtime: () => ({ node: null, problem: null }),
  }), null);
});

test('Windows: codex.cmd in %APPDATA%\\npm brings its folder, node comes from nvm-windows', () => {
  const npm = win32.join('C:\\', 'Users', 'sam', 'AppData', 'Roaming', 'npm');
  const nvmLink = win32.join('C:\\', 'nvm4w', 'nodejs');
  const system = ['C:\\Windows\\system32', 'C:\\Windows'].join(win32.delimiter);
  const path = launchPath(system, {
    platform: 'win32', binary: win32.join(npm, 'codex.cmd'), hasNode: nodeAt([nvmLink]),
    node: win32.join(nvmLink, 'node.exe'),
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

test('#1102 review: an `env node` script is started with the node the host chose, never looked up on PATH', () => {
  const node = posix.join('/usr', 'local', 'bin', 'node');
  const script = posix.join('/usr', 'lib', 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
  const read = (text: string) => () => text;
  assert.deepEqual(nodeInterpreter(script, node, 'linux', read('#!/usr/bin/env node\nrequire("x");')), { file: node, args: [] });
  assert.deepEqual(nodeInterpreter(script, node, 'darwin', read('#!/usr/bin/env -S node --no-warnings=ExperimentalWarning\r\n')),
    { file: node, args: ['--no-warnings=ExperimentalWarning'] });
  // Left to the file's own line: no node chosen, a native binary, an absolute interpreter, another one, or Windows (the host runs a shim's script).
  assert.equal(nodeInterpreter(script, null, 'linux', read('#!/usr/bin/env node\n')), null);
  assert.equal(nodeInterpreter(script, node, 'linux', read('\u007fELF\u0002')), null);
  assert.equal(nodeInterpreter(script, node, 'linux', read('#!/opt/node/bin/node\n')), null);
  assert.equal(nodeInterpreter(script, node, 'linux', read('#!/usr/bin/env bun\n')), null);
  assert.equal(nodeInterpreter(script, node, 'linux', read('#!/usr/bin/env nodejs\n')), null);
  // Without `-S`, Linux hands `env` its options as one word: the line keeps its own behaviour.
  assert.equal(nodeInterpreter(script, node, 'linux', read('#!/usr/bin/env node --flag\n')), null);
  assert.equal(nodeInterpreter('codex', node, 'linux', read('#!/usr/bin/env node\n')), null, 'an unresolved name');
  assert.equal(nodeInterpreter('C:\\npm\\codex.cmd', 'C:\\nodejs\\node.exe', 'win32', read('@ECHO off\r\nnode x')), null);
  assert.equal(nodeInterpreter(script, node, 'linux', () => { throw new Error('EACCES'); }), null);
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
  const fnm = posix.join('/home', 'sam', '.local', 'share', 'fnm', 'node-versions', 'v22.1.0', 'installation', 'bin', 'node');
  const runtime = () => ({ node: bundled, problem: null });
  const choose = (found: string | null, extra: Partial<Parameters<typeof chooseLaunchNode>[0]> = {}) =>
    chooseLaunchNode({ platform: 'linux', findNode: () => found, runtime, isRuntime: (file) => file === bundled, ...extra });
  // The machine's own node wins.
  assert.equal(choose(fnm), fnm);
  // None on the machine, or a search that throws: the daemon's runtime.
  assert.equal(choose(null), bundled);
  assert.equal(chooseLaunchNode({ platform: 'linux', findNode: () => { throw new Error('ENOENT'); }, runtime }), bundled);
  // Electron is never offered, whichever way it arrives.
  const electron = posix.join('/opt', 'Timon', 'timon');
  assert.equal(choose(electron, { selfExecutable: electron, runtime: () => ({ node: electron, problem: null }) }), null);
  assert.equal(choose(electron, { selfExecutable: electron }), bundled);
  // Its folder goes last on a PATH that offers no node.
  const linuxPath = ['/usr/bin', '/bin'].join(posix.delimiter); // portability: simulated Linux PATH
  assert.deepEqual(launchPath(linuxPath, { platform: 'linux', hasNode: () => false, node: bundled }).split(posix.delimiter),
    [...linuxPath.split(posix.delimiter), posix.dirname(bundled)]);
  // A node already on PATH, in a sound absolute folder: nothing added.
  assert.equal(launchPath(linuxPath, { platform: 'linux', hasNode: () => true, nodeStands: () => true, node: bundled }), linuxPath);
});

test('#1102 review: the daemon\'s runtime found by the search, or on PATH, stands only once checked', () => {
  const runtimeDir = posix.join('/opt', 'Timon', 'resources', 'node');
  const runtimeFile = posix.join(runtimeDir, 'node');
  const real = posix.join('/opt', 'Timon', 'resources', 'node-v22', 'node');
  const isRuntime = (file: string) => file === runtimeFile || file === real;
  // The search returns it as an ordinary candidate (its folder is on the daemon's PATH).
  const replaced = () => ({ node: null, problem: 'replaced' as const });
  assert.equal(chooseLaunchNode({ platform: 'linux', findNode: () => runtimeFile, isRuntime, runtime: replaced }), null);
  // Checked: the path that check vouched for is the one handed on, not the one the search wrote.
  assert.equal(chooseLaunchNode({ platform: 'linux', findNode: () => runtimeFile, isRuntime, runtime: () => ({ node: real, problem: null }) }), real);
  // The replaced runtime's folder already on the CLI's PATH: the chosen node goes ahead of it.
  const path = [runtimeDir, '/usr/bin'].join(posix.delimiter); // portability: simulated Linux PATH
  const chosen = posix.join('/usr', 'local', 'bin', 'node');
  assert.deepEqual(launchPath(path, {
    platform: 'linux', hasNode: () => true, node: chosen, nodeStands: (file) => !isRuntime(file),
  }).split(posix.delimiter), [posix.dirname(chosen), runtimeDir, '/usr/bin']); // portability: simulated Linux PATH
  // Still sound: left first.
  assert.equal(launchPath(path, { platform: 'linux', hasNode: () => true, node: chosen, nodeStands: () => true }), path);
});

test('#1102 review: designatesDaemonRuntime knows the runtime by its path then and now', () => {
  const execPath = posix.join('/usr', 'local', 'bin', 'node');
  const startupReal = posix.join('/usr', 'local', 'lib', 'node-v22', 'bin', 'node');
  const other = posix.join('/usr', 'bin', 'node');
  const links: Record<string, string> = { [execPath]: startupReal, [other]: startupReal };
  const realpath = (file: string) => { const to = links[file]; if (to) return to; throw new Error('ENOENT'); };
  const deps = { execPath, startupReal, realpath };
  assert.equal(designatesDaemonRuntime(execPath, 'linux', deps), true);
  assert.equal(designatesDaemonRuntime(startupReal, 'linux', deps), true);
  assert.equal(designatesDaemonRuntime(other, 'linux', deps), true, 'another link to the same file');
  assert.equal(designatesDaemonRuntime(posix.join('/opt', 'node', 'bin', 'node'), 'linux', deps), false);
  assert.equal(designatesDaemonRuntime(win32.join('C:\\', 'PROGRAM FILES', 'Timon', 'resources', 'node', 'NODE.EXE'), 'win32', {
    execPath: win32.join('C:\\', 'Program Files', 'Timon', 'resources', 'node', 'node.exe'), startupReal: null, realpath: (file) => file,
  }), true);
});

test('#1102 review: the chosen node goes ahead of any relative PATH entry', () => {
  const bundled = posix.join('/opt', 'Timon', 'resources', 'node', 'node');
  const probed: string[] = [];
  const hasNode = (dir: string) => { probed.push(dir); return true; };
  // `bin` and `./tools` are read against the mission's folder by a child's `node` lookup: the mission writes there.
  const path = ['bin', './tools', '/usr/bin'].join(posix.delimiter); // portability: simulated Linux PATH
  assert.deepEqual(launchPath(path, { platform: 'linux', hasNode, nodeStands: () => true, node: bundled }).split(posix.delimiter),
    [posix.dirname(bundled), 'bin', './tools', '/usr/bin']); // portability: simulated Linux PATH
  assert.deepEqual(probed, [], 'a relative entry is never probed');
  // A sound absolute folder with a node before them is the mission's own choice for its children.
  const absoluteFirst = ['/usr/bin', 'bin'].join(posix.delimiter); // portability: simulated Linux PATH
  assert.equal(launchPath(absoluteFirst, { platform: 'linux', hasNode, nodeStands: () => true, node: bundled }), absoluteFirst);
  const relativeOnly = ['bin', './tools'].join(posix.delimiter);
  assert.deepEqual(launchPath(relativeOnly, { platform: 'linux', hasNode, node: bundled }).split(posix.delimiter),
    [posix.dirname(bundled), 'bin', './tools']);
  const windows = ['tools', 'C:\\Windows'].join(';');
  const winProbed: string[] = [];
  const winPath = launchPath(windows, { platform: 'win32', hasNode: (dir) => { winProbed.push(dir); return false; }, node: win32.join('C:\\', 'nodejs', 'node.exe') });
  assert.deepEqual(winPath.split(';'), [win32.join('C:\\', 'nodejs'), 'tools', 'C:\\Windows']);
  assert.deepEqual(winProbed, []);
});

test('#1102: daemonNode is the runtime only when it is a node, never Electron', () => {
  // The name alone rules these out, before any file is looked at.
  const none = { node: null, problem: null };
  const bundled = posix.join('/opt', 'Timon', 'resources', 'node', 'node');
  assert.deepEqual(checkDaemonNode({ execPath: bundled, electron: '33.0.0', platform: 'linux' }), none);
  assert.deepEqual(checkDaemonNode({ execPath: posix.join('/opt', 'Timon', 'timon'), platform: 'linux' }), none);
  assert.deepEqual(checkDaemonNode({ execPath: posix.join('/usr', 'bin', 'nodejs'), platform: 'linux' }), none);
  assert.deepEqual(checkDaemonNode({ execPath: 'node', platform: 'linux' }), none);
  assert.deepEqual(checkDaemonNode({ execPath: win32.join('C:\\', 'Program Files', 'Timon', 'Timon.exe'), platform: 'win32' }), none);
  // A Windows package's node.exe, its file as the disk reports it.
  const windows = win32.join('C:\\', 'Program Files', 'Timon', 'resources', 'node', 'node.exe');
  const identity = { dev: 1, ino: 2, size: 3, mtimeMs: 4 };
  const deps = { realpath: (file: string) => file, stat: () => ({ ...identity, isFile: () => true }), executable: () => true, startup: identity };
  assert.equal(daemonNode({ execPath: windows, platform: 'win32' }, deps), windows);
  assert.deepEqual(checkDaemonNode({ execPath: windows, platform: 'win32' }, { ...deps, startup: { ...identity, ino: 9 } }),
    { node: null, problem: 'replaced' });
});

test('#1102 review: the daemon\'s Node is checked on disk before it stands in', { skip: process.platform === 'win32' && 'POSIX modes and links' }, (t) => {
  const base = mkdtempSync(join(tmpdir(), 'timon-daemon-node-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const real = join(base, 'resources', 'node', 'node');
  mkdirSync(join(real, '..'), { recursive: true });
  writeFileSync(real, '#!/bin/sh\n');
  chmodSync(real, 0o755);
  const facts = { execPath: real, platform: process.platform };
  const identity = () => { const s = statSync(real); return { dev: s.dev, ino: s.ino, size: s.size, mtimeMs: s.mtimeMs }; };
  // The temporary folder's parents prove nothing either way here: their owners differ from one runner to the next.
  const startup = identity();
  const strict = { startup, soundTree: () => false };
  assert.deepEqual(checkDaemonNode(facts, strict), { node: real, problem: null });
  // Reached through a link (`/usr/local/bin/node`): the file it leads to is the one a CLI gets.
  const link = join(base, 'bin', 'node');
  mkdirSync(join(link, '..'));
  symlinkSync(real, link);
  assert.equal(daemonNode({ ...facts, execPath: link }, strict), real);
  assert.deepEqual(launchPath('/usr/bin', { platform: 'linux', hasNode: () => false, node: daemonNode({ ...facts, execPath: link }, strict) }) // portability: simulated Linux PATH
    .split(posix.delimiter), ['/usr/bin', join(base, 'resources', 'node')]); // portability: simulated Linux PATH
  // No longer executable.
  chmodSync(real, 0o644);
  assert.deepEqual(checkDaemonNode(facts, strict), { node: null, problem: 'not-executable' });
  chmodSync(real, 0o755);
  // No identity captured at startup: refused, unless only root or the daemon could have put the file there.
  assert.deepEqual(checkDaemonNode(facts, { startup: null, soundTree: () => false }), { node: null, problem: 'unverified' });
  assert.deepEqual(checkDaemonNode(facts, { startup: null, soundTree: () => true }), { node: real, problem: null });
  // Another file at the same path: refused, unless its folders prove the same (the system's package manager upgraded it).
  writeFileSync(real, '#!/bin/sh\necho someone else\n');
  assert.deepEqual(checkDaemonNode(facts, strict), { node: null, problem: 'replaced' });
  assert.deepEqual(checkDaemonNode(facts, { startup, soundTree: (file) => file === real }), { node: real, problem: null });
  // The link now leads to the Electron binary: refused, with or without a startup identity to compare.
  const electron = join(base, 'timon');
  writeFileSync(electron, '\u007fELF');
  chmodSync(electron, 0o755);
  rmSync(link);
  symlinkSync(electron, link);
  assert.deepEqual(checkDaemonNode({ ...facts, execPath: link }, strict), { node: null, problem: 'replaced' });
  assert.deepEqual(checkDaemonNode({ ...facts, execPath: link }, { startup: null, soundTree: () => false }), { node: null, problem: 'unverified' });
  assert.deepEqual(checkDaemonNode({ ...facts, execPath: link }, { startup: null, soundTree: () => true }), { node: null, problem: 'not-node' });
  // Gone.
  rmSync(real);
  assert.deepEqual(checkDaemonNode(facts, strict), { node: null, problem: 'missing' });
  // The diagnostic says so instead of counting on it.
  const codex = join(base, 'codex');
  const nodeless = nodelessBackends(['codex'], {
    platform: 'linux', resolve: (name) => (name === 'codex' ? codex : null), read: () => '#!/usr/bin/env node\n', hasNode: () => false,
    runtimeNode: null, runtimeProblem: 'missing',
  });
  assert.deepEqual(nodeless, [{ name: 'codex', path: codex, runtimeProblem: 'missing' }]);
  assert.match(nodelessBackendText(nodeless[0]!), /started on was removed, replaced or made non-executable/);
  assert.doesNotMatch(nodelessBackendText({ name: 'codex', path: codex }), /started on/);
  assert.match(nodelessBackendText({ name: 'codex', path: codex, runtimeProblem: 'unverified' }), /could not be identified when it started/);
  // The runtime found by the search is no node of the machine's: only its check vouches for it.
  const runtimeFile = join(base, 'runtime', 'node');
  assert.deepEqual(nodelessBackends(['codex'], {
    platform: 'linux', resolve: (name) => (name === 'codex' ? codex : name === 'node' ? runtimeFile : null), read: () => '#!/usr/bin/env node\n',
    hasNode: () => false, runtimeNode: null, runtimeProblem: 'replaced', isRuntime: (file) => file === runtimeFile,
  }), [{ name: 'codex', path: codex, runtimeProblem: 'replaced' }]);
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
  const path = launchPath('/usr/bin', { platform: 'linux', binary: launcher, hasNode, node: resolve('node') }); // portability: simulated Linux PATH
  assert.deepEqual(path.split(':'), [join(home, '.npm-global', 'bin'), '/usr/bin', fnmBin]); // portability: simulated Linux PATH
});
