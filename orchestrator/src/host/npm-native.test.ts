import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findExecutableBinary, npmNativeBehind, npmNativeOrigin, resolvePinnedBinary, withNpmNativeEnv } from './binary-path.js';
import { setDeclaredBinariesSource } from './declared-binaries.js';
import { binaryProblems, type ProviderBinaryDeclaration } from '../backends/provider-declarations.js';

// Real files, POSIX links and modes: the Windows layout is simulated on top of a POSIX folder below.
const POSIX_HOST = process.platform === 'win32' && 'the fixtures rely on POSIX links and modes';

const LINUX_TRIPLE = ['vendor', 'x86_64-unknown-linux-musl', 'bin', 'codex'];

type Layout = 'platform-nested' | 'platform-hoisted' | 'in-package' | 'none';

/**
 * A global npm prefix holding `@openai/codex` as npm installs it: `<prefix>/bin/codex` links to the
 * launcher, the native build sits in the platform package (nested or hoisted) or in the package itself.
 */
function npmInstall(root: string, layout: Layout): { prefix: string; bin: string; pkg: string; native: string | null } {
  const prefix = join(root, 'prefix');
  const modules = join(prefix, 'lib', 'node_modules');
  const pkg = join(modules, '@openai', 'codex');
  mkdirSync(join(pkg, 'bin'), { recursive: true });
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: '@openai/codex', bin: { codex: 'bin/codex.js' } }));
  writeFileSync(join(pkg, 'bin', 'codex.js'), '#!/usr/bin/env node\nimport "node:child_process";\n');
  chmodSync(join(pkg, 'bin', 'codex.js'), 0o755);
  mkdirSync(join(prefix, 'bin'), { recursive: true });
  symlinkSync(join('..', 'lib', 'node_modules', '@openai', 'codex', 'bin', 'codex.js'), join(prefix, 'bin', 'codex'));
  const carrier = layout === 'platform-nested' ? join(pkg, 'node_modules', '@openai', 'codex-linux-x64')
    : layout === 'platform-hoisted' ? join(modules, '@openai', 'codex-linux-x64')
      : layout === 'in-package' ? pkg : null;
  if (!carrier) return { prefix, bin: join(prefix, 'bin'), pkg, native: null };
  const native = join(carrier, ...LINUX_TRIPLE);
  mkdirSync(join(native, '..'), { recursive: true });
  writeFileSync(native, '\u007fELF native build');
  chmodSync(native, 0o755);
  mkdirSync(join(carrier, 'vendor', 'x86_64-unknown-linux-musl', 'codex-path'), { recursive: true });
  return { prefix, bin: join(prefix, 'bin'), pkg, native };
}

function fixture(t: { after(fn: () => void): void }, layout: Layout) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'timon-npm-native-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const install = npmInstall(root, layout);
  const options = { platform: 'linux' as const, arch: 'x64', path: install.bin, homeDir: join(root, 'home'), env: {}, timonHome: join(root, 'timon') };
  return { root, ...install, options };
}

test('codex installed with npm resolves to the native build of its platform package, not the Node launcher', { skip: POSIX_HOST }, (t) => {
  const f = fixture(t, 'platform-nested');
  assert.equal(findExecutableBinary('codex', f.options), f.native);
  // A pin to the launcher lands on the same file: version, sign-in, doctor and missions run one program.
  assert.equal(resolvePinnedBinary('codex', join(f.bin, 'codex'), f.options), f.native);
});

test('the native build is found where the launcher itself would look: hoisted beside it, or in the package', { skip: POSIX_HOST }, (t) => {
  for (const layout of ['platform-hoisted', 'in-package'] as const) {
    const f = fixture(t, layout);
    assert.equal(findExecutableBinary('codex', f.options), f.native, layout);
  }
});

test('without a native build for this machine, the launcher stays what runs', { skip: POSIX_HOST }, (t) => {
  const f = fixture(t, 'none');
  assert.equal(findExecutableBinary('codex', f.options), join(f.bin, 'codex'));
  const g = fixture(t, 'platform-nested');
  // A target the declaration does not list (an arch Codex does not build for).
  assert.equal(findExecutableBinary('codex', { ...g.options, arch: 'ia32' }), join(g.bin, 'codex'));
  // A native file that is not executable is no build to start.
  chmodSync(g.native!, 0o644);
  assert.equal(findExecutableBinary('codex', g.options), join(g.bin, 'codex'));
});

test('a launcher of another package, or a native program, is never swapped', { skip: POSIX_HOST }, (t) => {
  const f = fixture(t, 'platform-nested');
  writeFileSync(join(f.pkg, 'package.json'), JSON.stringify({ name: '@someone/codex-fork' }));
  assert.equal(findExecutableBinary('codex', f.options), join(f.bin, 'codex'));
  const native = join(f.root, 'standalone', 'codex');
  mkdirSync(join(native, '..'), { recursive: true });
  writeFileSync(native, '\u007fELF standalone');
  chmodSync(native, 0o755);
  assert.equal(npmNativeBehind('codex', native, f.options), null);
});

test('the native build gets what the launcher gave it: the package root, the npm marker, its bundled tools first on PATH', { skip: POSIX_HOST }, (t) => {
  const f = fixture(t, 'platform-nested');
  const origin = npmNativeOrigin(f.native!, f.options);
  assert.ok(origin);
  assert.equal(origin.packageRoot, f.pkg);
  const env = withNpmNativeEnv({ PATH: '/usr/bin', KEEP: 'x' }, f.native!, f.options);
  assert.equal(env?.CODEX_MANAGED_BY_NPM, '1');
  assert.equal(env?.CODEX_MANAGED_PACKAGE_ROOT, f.pkg);
  assert.equal(env?.KEEP, 'x');
  const tools = join(f.pkg, 'node_modules', '@openai', 'codex-linux-x64', 'vendor', 'x86_64-unknown-linux-musl', 'codex-path');
  assert.equal(env?.PATH, `${tools}:/usr/bin`);
  // Applied twice (the host's spawn after the mission's own environment), the PATH does not grow.
  assert.equal(withNpmNativeEnv(env, f.native!, f.options)?.PATH, env?.PATH);
  // Any other program keeps the environment it was given, the very object.
  const plain = { PATH: '/usr/bin' };
  assert.equal(withNpmNativeEnv(plain, join(f.bin, 'codex'), f.options), plain);
  assert.equal(withNpmNativeEnv(undefined, '/usr/bin/git', f.options), undefined);
  for (const layout of ['platform-hoisted', 'in-package'] as const) {
    const g = fixture(t, layout);
    assert.equal(npmNativeOrigin(g.native!, g.options)?.packageRoot, g.pkg, layout);
  }
});

test('Windows: the npm shim leads to the launcher, and the native .exe of the platform package runs instead', { skip: POSIX_HOST }, (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'timon-npm-native-win-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const npm = join(root, 'Roaming', 'npm');
  const pkg = join(npm, 'node_modules', '@openai', 'codex');
  mkdirSync(join(pkg, 'bin'), { recursive: true });
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: '@openai/codex' }));
  writeFileSync(join(pkg, 'bin', 'codex.js'), '#!/usr/bin/env node\n');
  writeFileSync(join(npm, 'codex.cmd'), [
    '@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start', 'SETLOCAL', 'CALL :find_dp0',
    'IF EXIST "%dp0%\\node.exe" (', '  SET "_prog=%dp0%\\node.exe"', ') ELSE (', '  SET "_prog=node"',
    '  SET PATHEXT=%PATHEXT:;.JS;=;%', ')',
    'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*',
  ].join('\r\n'));
  const exe = join(pkg, 'node_modules', '@openai', 'codex-win32-x64', 'vendor', 'x86_64-pc-windows-msvc', 'bin', 'codex.exe');
  mkdirSync(join(exe, '..'), { recursive: true });
  writeFileSync(exe, 'MZ native build');
  const options = { platform: 'win32' as const, arch: 'x64', path: '', homeDir: root, env: { APPDATA: join(root, 'Roaming') }, timonHome: join(root, 'timon') };
  assert.equal(findExecutableBinary('codex', options), exe);
  assert.equal(npmNativeOrigin(exe, options)?.env.CODEX_MANAGED_BY_NPM, '1');
});

test('a provider plugin can declare its own npm launcher, and only for the name it declares', { skip: POSIX_HOST }, (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'timon-npm-native-acme-')));
  t.after(() => { rmSync(root, { recursive: true, force: true }); setDeclaredBinariesSource(() => []); });
  const pkg = join(root, 'node_modules', 'acme-cli');
  mkdirSync(join(pkg, 'bin'), { recursive: true });
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'acme-cli' }));
  writeFileSync(join(pkg, 'bin', 'acme.js'), '#!/usr/bin/env node\n');
  chmodSync(join(pkg, 'bin', 'acme.js'), 0o755);
  mkdirSync(join(root, 'bin'));
  symlinkSync(join(pkg, 'bin', 'acme.js'), join(root, 'bin', 'acme'));
  const native = join(pkg, 'dist', 'acme-linux');
  mkdirSync(join(native, '..'), { recursive: true });
  writeFileSync(native, '\u007fELF acme');
  chmodSync(native, 0o755);
  const declaration: ProviderBinaryDeclaration = {
    names: ['acme'],
    npmNative: { package: 'acme-cli', executable: { 'linux-x64': ['dist', 'acme-linux'] }, env: { ACME_LAUNCHER: 'npm' } },
  };
  assert.deepEqual(binaryProblems(declaration), []);
  setDeclaredBinariesSource(() => [declaration]);
  const options = { platform: 'linux' as const, arch: 'x64', path: join(root, 'bin'), homeDir: join(root, 'home'), env: {}, timonHome: join(root, 'timon') };
  assert.equal(findExecutableBinary('acme', options), native);
  assert.deepEqual(npmNativeOrigin(native, options)?.env, { ACME_LAUNCHER: 'npm' });
  // A path asked for as such is the program the caller named.
  assert.equal(findExecutableBinary(join(root, 'bin', 'acme'), options), join(root, 'bin', 'acme'));
});
