import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { packagedCliLauncher, writePackagedCli } from './packaged-cli.mjs';

for (const platform of ['linux', 'darwin']) {
  test(`${platform} launcher resolves symlinks, preserves cwd/arguments/status without Node on PATH`, { skip: process.platform === 'win32' }, () => {
    // The child reports `process.cwd()`, which is canonical: on macOS the
    // temporary folder `/var/…` is really `/private/var/…`.
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'timon-cli-')));
    try {
      const app = join(home, "Timon's app $test");
      const root = platform === 'darwin' ? join(app, 'Contents') : app;
      const resources = join(root, platform === 'darwin' ? 'Resources' : 'resources');
      const runtime = join(resources, 'node', 'node');
      const cli = join(resources, 'orchestrator', 'bin', 'timon');
      mkdirSync(dirname(runtime), { recursive: true });
      mkdirSync(dirname(cli), { recursive: true });
      symlinkSync(process.execPath, runtime);
      writeFileSync(cli, 'console.log(JSON.stringify({args:process.argv.slice(2),cwd:process.cwd(),electron:process.env.ELECTRON_RUN_AS_NODE ?? null}));process.exit(17);');
      const launcher = writePackagedCli(app, platform);
      const bin = join(home, 'bin');
      mkdirSync(bin);
      for (const command of ['dirname', 'readlink']) {
        symlinkSync(join('/usr/bin', command), join(bin, command));
      }
      const middle = join(home, 'middle');
      symlinkSync(relative(home, launcher), middle);
      const command = join(bin, 'timon');
      symlinkSync(middle, command);
      const args = ['two words', "apostrophe's", '$HOME', '"quote"', '', '--json', ';echo bad'];
      const result = spawnSync(command, args, { cwd: home, env: { ...process.env, TIMON_HOME: home, PATH: bin }, encoding: 'utf8' });
      assert.equal(result.status, 17, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), { args, cwd: home, electron: null });
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
}

test('Windows launcher scopes its environment and uses the shipped Node with relative quoted paths', () => {
  const script = packagedCliLauncher('win32');
  assert.ok(script.includes('setlocal DisableDelayedExpansion\r\n'));
  assert.ok(script.includes('"%~dp0..\\resources\\node\\node.exe" "%~dp0..\\resources\\orchestrator\\bin\\timon" %*'));
  assert.ok(script.includes('exit /b %errorlevel%'));
  assert.ok(!script.includes('ELECTRON_RUN_AS_NODE'));
});

test('macOS pkg installs idempotently and refuses an unrelated command', { skip: process.platform === 'win32' }, () => {
  const home = mkdtempSync(join(tmpdir(), 'timon-pkg-'));
  try {
    const applications = join(home, 'Applications');
    const bin = join(home, 'bin');
    const launcher = join(applications, 'Timon.app', 'Contents', 'cli', 'timon');
    mkdirSync(dirname(launcher), { recursive: true });
    writeFileSync(launcher, 'fixture');
    const original = readFileSync(new URL('./macos-cli-scripts/postinstall', import.meta.url), 'utf8');
    const script = original.replaceAll('/Applications', applications).replaceAll('/usr/local/bin', bin);
    const run = () => spawnSync('/bin/sh', ['-c', script], { env: { ...process.env, TIMON_HOME: home }, encoding: 'utf8' });
    assert.equal(run().status, 0);
    assert.equal(run().status, 0);
    assert.equal(readFileSync(join(bin, 'timon'), 'utf8'), 'fixture');
    rmSync(join(bin, 'timon'));
    writeFileSync(join(bin, 'timon'), 'unrelated');
    assert.match(run().stderr, /another installation/);
    assert.equal(readFileSync(join(bin, 'timon'), 'utf8'), 'unrelated');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('deb/rpm hooks install, preserve on upgrade, remove only the owned CLI link', { skip: process.platform === 'win32' }, () => {
  const home = mkdtempSync(join(tmpdir(), 'timon-deb-'));
  try {
    const bin = join(home, 'bin');
    const opt = join(home, 'opt');
    const stubs = join(home, 'stubs');
    for (const dir of [bin, stubs, join(opt, 'Timon', 'cli')]) mkdirSync(dir, { recursive: true });
    for (const tool of ['update-mime-database', 'update-desktop-database', 'setpriv', 'chmod']) {
      writeFileSync(join(stubs, tool), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    }
    const alternativesLog = join(home, 'alternatives.log');
    writeFileSync(join(stubs, 'update-alternatives'), `#!/bin/sh\necho "$*" >> '${alternativesLog}'\nexit 0\n`, { mode: 0o755 });
    const launcher = join(opt, 'Timon', 'cli', 'timon');
    writeFileSync(launcher, 'launcher');
    const run = (hook: string) => {
      const script = readFileSync(new URL(`./linux-cli-after-${hook}.tpl`, import.meta.url), 'utf8')
        .replaceAll('${sanitizedProductName}', 'Timon').replaceAll('${executable}', 'timon-desktop')
        .replaceAll('/usr/bin', bin).replaceAll('/opt', opt)
        // No AppArmor on this machine, whatever the one running the test has.
        .replaceAll('/etc/apparmor.d', join(home, 'no-apparmor.d'));
      return spawnSync('/bin/bash', ['-c', script], { env: { ...process.env, TIMON_HOME: home, PATH: `${stubs}:/usr/bin:/bin` }, encoding: 'utf8' });
    };
    assert.equal(run('install').status, 0);
    assert.equal(run('install').status, 0);
    assert.equal(run('remove').status, 0);
    assert.equal(readFileSync(join(bin, 'timon'), 'utf8'), 'launcher');
    rmSync(launcher);
    assert.equal(run('remove').status, 0);
    assert.throws(() => readFileSync(join(bin, 'timon')));
    writeFileSync(join(bin, 'timon'), 'unrelated');
    assert.match(run('install').stderr, /another installation/);
    assert.equal(run('remove').status, 0);
    assert.equal(readFileSync(join(bin, 'timon'), 'utf8'), 'unrelated');
    // A source checkout's `npm link` symlink is neither replaced nor removed.
    rmSync(join(bin, 'timon'));
    const checkout = join(home, 'checkout-timon');
    writeFileSync(launcher, 'launcher');
    symlinkSync(checkout, join(bin, 'timon'));
    assert.match(run('install').stderr, /another installation/);
    rmSync(launcher);
    assert.equal(run('remove').status, 0);
    assert.equal(readlinkSync(join(bin, 'timon')), checkout);
    // Only the app launcher goes through update-alternatives, never the CLI.
    const calls = readFileSync(alternativesLog, 'utf8').trim().split('\n');
    assert.ok(calls.some((call) => call.startsWith('--install ') && call.includes('timon-desktop')));
    assert.ok(calls.some((call) => call.startsWith('--remove timon-desktop ')));
    assert.ok(calls.every((call) => !call.includes('cli') && !call.split(' ').includes('timon') && !call.includes(`${join(bin, 'timon')} `)));
  } finally { rmSync(home, { recursive: true, force: true }); }
});

/**
 * TODO #1233. Ubuntu 23.10 and later refuse user namespaces to unprivileged programs AppArmor
 * does not name, so Chromium's sandbox needs a profile or a setuid helper. The hooks run here
 * on a fake root: AppArmor, `setpriv` and `chmod` are stubs that record their calls.
 */
type HookMachine = {
  apparmor: 'running' | 'absent' | 'off';
  /** What `apparmor_parser` answers: to the check of the profile, to its load. */
  parses?: boolean;
  loads?: boolean;
  /** Whether an ordinary user can create a user namespace with its maps. */
  userns?: boolean;
};

function hookMachine(home: string, machine: HookMachine) {
  const bin = join(home, 'bin');
  const opt = join(home, 'opt');
  const stubs = join(home, 'stubs');
  const apparmorDir = join(home, 'etc', 'apparmor.d');
  const enabled = join(home, 'sys', 'apparmor-enabled');
  const calls = join(home, 'calls.log');
  for (const dir of [bin, stubs, join(opt, 'Timon', 'cli'), dirname(enabled)]) mkdirSync(dir, { recursive: true });
  if (machine.apparmor !== 'absent') mkdirSync(apparmorDir, { recursive: true });
  writeFileSync(enabled, machine.apparmor === 'running' ? 'Y\n' : 'N\n');
  writeFileSync(join(opt, 'Timon', 'timon-desktop'), 'electron');
  writeFileSync(join(opt, 'Timon', 'cli', 'timon'), 'launcher');
  const stub = (name: string, body: string) => writeFileSync(join(stubs, name), `#!/bin/sh\necho "${name} $*" >> '${calls}'\n${body}\n`, { mode: 0o755 });
  for (const tool of ['update-alternatives', 'update-mime-database', 'update-desktop-database', 'chmod']) stub(tool, 'exit 0');
  stub('ischroot', 'exit 1');
  stub('setpriv', `exit ${machine.userns ? 0 : 1}`);
  stub('apparmor_parser', [
    'case "$1" in',
    `  --skip-kernel-load) exit ${machine.parses === false ? 1 : 0} ;;`,
    `  --replace) exit ${machine.loads === false ? 1 : 0} ;;`,
    'esac',
    'exit 0',
  ].join('\n'));
  const run = (hook: 'install' | 'remove') => {
    const script = readFileSync(new URL(`./linux-cli-after-${hook}.tpl`, import.meta.url), 'utf8')
      .replaceAll('${sanitizedProductName}', 'Timon').replaceAll('${executable}', 'timon-desktop')
      .replaceAll('/usr/bin', bin).replaceAll('/opt', opt)
      .replaceAll('/etc/apparmor.d', apparmorDir).replaceAll('/sys/module/apparmor/parameters/enabled', enabled);
    return spawnSync('/bin/bash', ['-c', script], { env: { ...process.env, TIMON_HOME: home, PATH: `${stubs}:/usr/bin:/bin` }, encoding: 'utf8' });
  };
  const log = () => { try { return readFileSync(calls, 'utf8').trim().split('\n'); } catch { return []; } };
  return { run, log, profile: join(apparmorDir, 'timon-desktop'), executable: join(opt, 'Timon', 'timon-desktop'), sandbox: join(opt, 'Timon', 'chrome-sandbox') };
}

const POSIX_HOOKS = process.platform === 'win32' && 'the package hooks are bash scripts';

test('TODO #1233: the deb hook gives the executable, and only it, user namespaces through AppArmor', { skip: POSIX_HOOKS }, () => {
  const home = mkdtempSync(join(tmpdir(), 'timon-apparmor-'));
  try {
    const m = hookMachine(home, { apparmor: 'running' });
    const installed = m.run('install');
    assert.equal(installed.status, 0, installed.stderr);
    const profile = readFileSync(m.profile, 'utf8');
    assert.match(profile, /^# Written by the Timon package: removed with it\.$/m);
    assert.match(profile, /^abi <abi\/4\.0>,$/m);
    assert.ok(profile.includes(`profile timon-desktop ${m.executable} flags=(unconfined) {`), profile);
    assert.match(profile, /^ {2}userns,$/m);
    // The one right granted: no file, network or capability rule.
    assert.deepEqual(profile.split('\n').map((line) => line.trim()).filter((line) => /^[a-z]/.test(line) && !/^(abi|include|profile)\b/.test(line)), ['userns,']);
    const calls = m.log();
    const check = calls.findIndex((call) => call.startsWith('apparmor_parser --skip-kernel-load'));
    const load = calls.indexOf(`apparmor_parser --replace --write-cache --skip-read-cache ${m.profile}`);
    assert.ok(check >= 0 && load > check, calls.join('\n'));
    // Upgrade: the executable is still there, the profile stays.
    assert.equal(m.run('remove').status, 0);
    assert.ok(existsSync(m.profile));
    // Final removal: unloaded, then deleted.
    rmSync(m.executable);
    rmSync(join(home, 'opt', 'Timon', 'cli', 'timon'));
    const removed = m.run('remove');
    assert.equal(removed.status, 0, removed.stderr);
    assert.equal(existsSync(m.profile), false);
    assert.ok(m.log().includes(`apparmor_parser --remove ${m.profile}`));
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('TODO #1233: without AppArmor, or one that cannot read or load the profile, the install still succeeds', { skip: POSIX_HOOKS }, () => {
  for (const machine of [
    { apparmor: 'absent' }, { apparmor: 'off' }, { apparmor: 'running', parses: false }, { apparmor: 'running', loads: false },
  ] satisfies HookMachine[]) {
    const home = mkdtempSync(join(tmpdir(), 'timon-apparmor-'));
    try {
      const m = hookMachine(home, machine);
      const installed = m.run('install');
      assert.equal(installed.status, 0, `${JSON.stringify(machine)}: ${installed.stderr}`);
      const loaded = machine.apparmor === 'running' && machine.parses !== false;
      // A profile AppArmor cannot parse is never left in its folder: it would fail at every boot.
      assert.equal(existsSync(m.profile), loaded, JSON.stringify(machine));
      if (machine.apparmor !== 'running') assert.ok(!m.log().some((call) => call.startsWith('apparmor_parser')), JSON.stringify(machine));
      if (machine.loads === false) assert.match(installed.stderr, /loads at the next boot/);
      if (machine.parses === false) assert.match(installed.stderr, /does not read it/);
      rmSync(m.executable);
      assert.equal(m.run('remove').status, 0, JSON.stringify(machine));
      assert.equal(existsSync(m.profile), false, JSON.stringify(machine));
    } finally { rmSync(home, { recursive: true, force: true }); }
  }
});

test('TODO #1233: a profile of the same name the package did not write is neither replaced nor removed', { skip: POSIX_HOOKS }, () => {
  const home = mkdtempSync(join(tmpdir(), 'timon-apparmor-'));
  try {
    const m = hookMachine(home, { apparmor: 'running' });
    writeFileSync(m.profile, 'profile timon-desktop /somewhere/else {}\n');
    const installed = m.run('install');
    assert.equal(installed.status, 0);
    assert.match(installed.stderr, /belongs to someone else/);
    rmSync(m.executable);
    assert.equal(m.run('remove').status, 0);
    assert.equal(readFileSync(m.profile, 'utf8'), 'profile timon-desktop /somewhere/else {}\n');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('TODO #1233: chrome-sandbox keeps its setuid bit unless an ordinary user, not root, can create a user namespace', { skip: POSIX_HOOKS }, () => {
  for (const userns of [false, true]) {
    const home = mkdtempSync(join(tmpdir(), 'timon-apparmor-'));
    try {
      const m = hookMachine(home, { apparmor: 'running', userns });
      assert.equal(m.run('install').status, 0);
      const calls = m.log();
      assert.ok(calls.includes('setpriv --reuid=65534 --regid=65534 --clear-groups -- unshare --user --map-root-user true'), calls.join('\n'));
      assert.ok(calls.includes(`chmod ${userns ? '0755' : '4755'} ${m.sandbox}`), calls.join('\n'));
    } finally { rmSync(home, { recursive: true, force: true }); }
  }
});

test('the package hooks use only the macros the package builder defines', () => {
  // electron-builder expands every `${name}` and fails the build on one it does not know.
  for (const hook of ['install', 'remove']) {
    const script = readFileSync(new URL(`./linux-cli-after-${hook}.tpl`, import.meta.url), 'utf8');
    const macros = new Set([...script.matchAll(/\$\{([a-zA-Z]+)\}/g)].map((match) => match[1]));
    assert.deepEqual([...macros].filter((name) => !['executable', 'sanitizedProductName', 'productFilename'].includes(name ?? '')), [], hook);
  }
});
