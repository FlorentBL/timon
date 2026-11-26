/**
 * The built-in browser's unit on a Linux server with no screen (`browser-host-service.ts`).
 *
 * A temporary HOME and a simulated systemd: no test writes a real unit or calls a real
 * systemctl, and none reads the real `TIMON_HOME`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import {
  BROWSER_HOST_SETTING, browserHostEnabled, browserHostService, installedDesktopExecutable, LINUX_DESKTOP_EXECUTABLE, readStoredSetting,
} from './browser-host-service.js';
import { linuxGraphicalSession } from './desktop-session.js';
import { releaseSourceFile } from './packaged-handback.js';
import { browserHostUnit, packagedServiceOptions, renderBrowserHostUnit, runtimeDir, runtimeReleaseDir } from './packaged-service.js';
import {
  installService, removeServiceDefinition, startService, statusService, stopService, uninstallService, unitPath, type ServiceOpts,
} from './service-install.js';
import { servicesSharingHome } from './service-ownership.js';
import type { ExecResult } from './types.js';

/** The unit identity is read back as POSIX paths, which a Windows temporary directory is not. */
const POSIX_PATHS = process.platform === 'win32' && 'the systemd unit identity is read as POSIX paths';

const ok = (stdout = ''): ExecResult => ({ code: 0, stdout, stderr: '' });

type Machine = {
  /** What `systemctl --user show-environment` prints. */
  userEnv?: string;
  displayManager?: boolean;
  env?: NodeJS.ProcessEnv;
  configSettings?: Record<string, string | number | boolean>;
  stored?: string | null;
  version?: string;
  /** Directory of the installed package, under the temporary home. */
  packageDir?: string;
};

function machine(m: Machine = {}) {
  const homeDir = mkdtempSync(join(tmpdir(), 'timon-browser-host-'));
  const packageRoot = join(homeDir, m.packageDir ?? 'opt/Timon');
  const desktop = join(packageRoot, LINUX_DESKTOP_EXECUTABLE);
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(desktop, '');
  const calls: string[][] = [];
  const base: ServiceOpts = {
    platform: 'linux', homeDir, timonHome: join(homeDir, '.timon'), installDir: join(packageRoot, 'resources', 'orchestrator'),
    userName: 'tester', uid: 1000, heapMb: 4096, port: 3010, nodePath: desktop, exec: () => ok(),
  };
  const opts = packagedServiceOptions(base, desktop, 3110, m.version ?? '0.2.0');
  opts.exec = (name, args) => {
    calls.push([name, ...args]);
    if (name !== 'systemctl') return name === 'loginctl' ? { code: 1, stdout: '', stderr: 'not logged in or lingering' } : ok();
    if (args[1] === 'show-environment') return ok(m.userEnv ?? 'HOME=/home/tester\nPATH=/usr/bin\n');
    if (args[0] === 'is-active') return m.displayManager ? ok('active\n') : { code: 3, stdout: 'inactive\n', stderr: '' };
    if (args.includes('show')) {
      const unit = args[args.indexOf('show') + 1]!;
      if (!existsSync(unitPath(homeDir, unit))) return ok('LoadState=not-found\n');
      if (unit !== opts.unitName) return ok('LoadState=loaded\nActiveState=active\n');
      return ok(`LoadState=loaded\nNeedDaemonReload=no\nActiveState=active\nUnitFileState=enabled\nWorkingDirectory=${opts.installDir}\n`
        + `Environment="TIMON_HOME=${opts.timonHome}"\n`);
    }
    return ok();
  };
  const browserHost = browserHostService(opts, {
    executable: desktop, env: m.env ?? {}, configSettings: m.configSettings ?? {}, stored: () => m.stored ?? null,
  });
  const withHost: ServiceOpts = browserHost ? { ...opts, browserHost } : opts;
  const browserFile = unitPath(homeDir, browserHostUnit(opts.timonHome));
  const acts = () => calls.filter((call) => call[0] === 'systemctl' && !call.includes('show') && call[1] !== 'show-environment' && call[1] !== 'is-active')
    .map((call) => call.slice(1).join(' '));
  return { opts: withHost, calls, acts, desktop, browserFile, daemonFile: unitPath(homeDir, opts.unitName) };
}

test('the setting resolves environment, then config, then the settings table, then on', () => {
  const layers = (env: string | undefined, config: string | boolean | undefined, stored: string | null) => browserHostEnabled({
    env: env === undefined ? {} : { [BROWSER_HOST_SETTING]: env },
    configSettings: config === undefined ? {} : { [BROWSER_HOST_SETTING]: config },
    stored: (key) => (key === BROWSER_HOST_SETTING ? stored : null),
  });
  assert.equal(layers(undefined, undefined, null), true, 'on by default');
  assert.equal(layers(undefined, undefined, 'false'), false, 'the settings table');
  assert.equal(layers(undefined, true, 'false'), true, 'the config file over the table');
  assert.equal(layers(undefined, 'off', 'true'), false);
  assert.equal(layers('0', true, 'true'), false, 'the environment over everything');
  assert.equal(layers('yes', false, 'false'), true);
  // An empty or unreadable value is skipped, as the registry skips it.
  assert.equal(layers('', false, null), false);
  assert.equal(layers('maybe', 'perhaps', 'no'), false);
});

test('the settings table is read without migrating, and a missing database is no answer', () => {
  const dir = mkdtempSync(join(tmpdir(), 'timon-browser-host-db-'));
  const file = join(dir, 'timon.db');
  assert.equal(readStoredSetting(file, BROWSER_HOST_SETTING), null);
  const db = new Database(file);
  db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER)');
  db.prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)').run(BROWSER_HOST_SETTING, 'false', 1);
  db.close();
  assert.equal(readStoredSetting(file, BROWSER_HOST_SETTING), 'false');
  assert.equal(readStoredSetting(file, 'TIMON_SOMETHING_ELSE'), null);
  writeFileSync(join(dir, 'broken.db'), 'not a database');
  assert.equal(readStoredSetting(join(dir, 'broken.db'), BROWSER_HOST_SETTING), null);
});

test('a desktop session is seen through the shell, the user manager or a display manager', () => {
  const exec = (userEnv: string, manager: boolean) => (name: string, args: string[]): ExecResult => {
    assert.equal(name, 'systemctl');
    if (args[1] === 'show-environment') return ok(userEnv);
    return manager ? ok('active\n') : { code: 3, stdout: 'inactive\n', stderr: '' };
  };
  assert.equal(linuxGraphicalSession({}, exec('HOME=/h\n', false)), false, 'a server');
  assert.equal(linuxGraphicalSession({ DISPLAY: ':0' }, exec('', false)), true);
  assert.equal(linuxGraphicalSession({ WAYLAND_DISPLAY: 'wayland-0' }, exec('', false)), true);
  // An SSH login to a workstation: nothing in the shell, the desktop login exported it.
  assert.equal(linuxGraphicalSession({}, exec('HOME=/h\nWAYLAND_DISPLAY=wayland-0\n', false)), true);
  assert.equal(linuxGraphicalSession({}, exec('DISPLAY=:1\n', false)), true);
  assert.equal(linuxGraphicalSession({}, exec('HOME=/h\n', true)), true, 'a login screen');
  assert.equal(linuxGraphicalSession({}, () => { throw new Error('no systemctl'); }), false);
});

test('the host runs the installed package, never a staged copy nor an AppImage mount', () => {
  const home = mkdtempSync(join(tmpdir(), 'timon-browser-host-home-'));
  assert.equal(installedDesktopExecutable('/opt/Timon/timon-desktop', home, {}), '/opt/Timon/timon-desktop');
  assert.equal(installedDesktopExecutable('/opt/Timon/resources/node/node', home, {}), '/opt/Timon/timon-desktop');
  assert.equal(installedDesktopExecutable('/tmp/.mount_TimonX/timon-desktop', home, {}), null);
  assert.equal(installedDesktopExecutable('/opt/Timon/timon-desktop', home, { APPIMAGE: '/home/u/Timon.AppImage' }), null);
  // The service's own daemon runs a copy: the package it was copied from was recorded.
  const staged = join(runtimeReleaseDir(home, '0.2.0'), 'resources', 'node', 'node');
  assert.equal(installedDesktopExecutable(staged, home, {}), null, 'no record, no guess');
  mkdirSync(runtimeDir(home), { recursive: true });
  writeFileSync(releaseSourceFile(home), JSON.stringify({ root: '/opt/Timon', executable: 'resources/node/node' }));
  assert.equal(installedDesktopExecutable(staged, home, {}), '/opt/Timon/timon-desktop');
  writeFileSync(releaseSourceFile(home), JSON.stringify({ root: '/opt/Timon', executable: 'timon-desktop' }));
  assert.equal(installedDesktopExecutable(join(runtimeReleaseDir(home, '0.2.0'), 'timon-desktop'), home, {}), '/opt/Timon/timon-desktop');
});

test('the unit restarts the host on failure, never after a definitive refusal, and stops it with SIGTERM', () => {
  const unit = renderBrowserHostUnit('/home/u/.timon', '/opt/Timon/timon-desktop');
  // TODO #1233: through the package's Node and its launcher, which turns a sandbox refusal into 78.
  assert.match(unit, /^ExecStart="\/opt\/Timon\/resources\/node\/node" "\/opt\/Timon\/resources\/orchestrator\/dist\/host\/browser-host-launcher\.js" "\/opt\/Timon\/timon-desktop" %n$/m);
  assert.match(unit, /^KillMode=mixed$/m, 'the stop signal reaches the launcher, which hands it to the host once');
  assert.match(unit, /^Environment="TIMON_HOME=\/home\/u\/\.timon"$/m);
  assert.match(unit, /^Restart=on-failure$/m);
  assert.match(unit, /^RestartPreventExitStatus=78$/m);
  assert.match(unit, /^RestartSteps=10$/m, 'the daemon\'s backoff');
  assert.match(unit, /^RestartMaxDelaySec=300$/m);
  assert.match(unit, /^KillSignal=SIGTERM$/m);
  assert.match(unit, /^UnsetEnvironment=ELECTRON_RUN_AS_NODE$/m);
  assert.match(unit, /^ConditionPathExists=\/opt\/Timon\/timon-desktop$/m);
  assert.match(unit, /^WantedBy=default\.target$/m);
  assert.doesNotMatch(unit, /ELECTRON_RUN_AS_NODE=1/);
  assert.throws(() => renderBrowserHostUnit('/home/u/.timon\nExecStartPre=/bin/false', '/opt/Timon/timon-desktop'));
});

test('macOS, Windows and a source checkout get no host', () => {
  const { opts } = machine();
  const input = { executable: '/opt/Timon/timon-desktop', env: {}, configSettings: {}, stored: () => null };
  assert.equal(browserHostService({ ...opts, platform: 'darwin' }, input), undefined);
  assert.equal(browserHostService({ ...opts, platform: 'win32' }, input), undefined);
  const { unitName: _unit, ...source } = opts;
  assert.equal(browserHostService(source, input), undefined);
});

test('server with no screen: the daemon and the browser host are both installed and started', { skip: POSIX_PATHS }, () => {
  const { opts, acts, desktop, browserFile, daemonFile } = machine();
  const result = installService(opts);
  assert.equal(result.ok, true, result.lines.join('\n'));
  assert.ok(existsSync(daemonFile));
  assert.equal(readFileSync(browserFile, 'utf8'), renderBrowserHostUnit(opts.timonHome, desktop));
  const unit = browserHostUnit(opts.timonHome);
  assert.ok(acts().includes(`--user enable --now ${opts.unitName}`));
  assert.ok(acts().includes(`--user enable --now ${unit}`));
  assert.ok(acts().indexOf(`--user enable --now ${opts.unitName}`) < acts().indexOf(`--user enable --now ${unit}`));
  assert.ok(result.lines.some((line) => line.includes(`built-in browser service installed (${unit})`)));

  const status = statusService(opts);
  assert.deepEqual(status.browserHost, { unit, state: 'active' });
  assert.ok(status.lines.includes(`browser   : ${unit} (active)`));
  // The host names the same home and is no second daemon: nothing to refuse or replace.
  assert.deepEqual(servicesSharingHome(opts), []);
});

test('a machine with a desktop session gets the daemon only', { skip: POSIX_PATHS }, () => {
  for (const m of [{ env: { DISPLAY: ':0' } }, { userEnv: 'WAYLAND_DISPLAY=wayland-0\n' }, { displayManager: true }] as Machine[]) {
    const { opts, acts, browserFile, daemonFile } = machine(m);
    const result = installService(opts);
    assert.equal(result.ok, true, result.lines.join('\n'));
    assert.ok(existsSync(daemonFile));
    assert.equal(existsSync(browserFile), false, JSON.stringify(m));
    assert.ok(!acts().some((act) => act.includes('timon-browser-')));
    assert.ok(result.lines.some((line) => /built-in browser service: not installed, this machine has a desktop session/.test(line)));
  }
});

test('the setting turned off: the daemon only, and a host already there is removed', { skip: POSIX_PATHS }, () => {
  for (const m of [{ stored: 'false' }, { configSettings: { [BROWSER_HOST_SETTING]: false } }, { env: { [BROWSER_HOST_SETTING]: '0' } }] as Machine[]) {
    const { opts, acts, browserFile } = machine(m);
    mkdirSync(join(opts.homeDir, '.config', 'systemd', 'user'), { recursive: true });
    writeFileSync(browserFile, 'left by a previous install');
    const result = installService(opts);
    assert.equal(result.ok, true, result.lines.join('\n'));
    assert.equal(existsSync(browserFile), false, JSON.stringify(m));
    const unit = browserHostUnit(opts.timonHome);
    assert.ok(acts().includes(`--user disable --now ${unit}`));
    assert.ok(result.lines.some((line) => line.includes(`built-in browser service removed (${unit}): turned off (${BROWSER_HOST_SETTING})`)));
  }
});

test('a host that cannot start leaves the daemon installed, and says so', { skip: POSIX_PATHS }, () => {
  const { opts, browserFile } = machine();
  const exec = opts.exec;
  const unit = browserHostUnit(opts.timonHome);
  opts.exec = (name, args) => (args.includes('enable') && args.includes(unit) ? { code: 1, stdout: '', stderr: 'Unit failed' } : exec(name, args));
  const result = installService(opts);
  assert.equal(result.ok, true);
  assert.ok(existsSync(browserFile));
  assert.ok(result.lines.some((line) => line === `built-in browser service could not be started (${unit}): Unit failed`));
});

test('stop, start and restart take the host along; uninstall removes both units', { skip: POSIX_PATHS }, () => {
  const { opts, acts, browserFile, daemonFile } = machine();
  assert.equal(installService(opts).ok, true);
  const unit = browserHostUnit(opts.timonHome);
  const before = acts().length;
  assert.equal(stopService(opts).ok, true);
  assert.equal(startService(opts).ok, true);
  assert.deepEqual(acts().slice(before), [
    `--user stop ${opts.unitName}`, `--user stop ${unit}`, `--user start ${opts.unitName}`, `--user start ${unit}`,
  ]);

  const removed = uninstallService(opts);
  assert.equal(removed.ok, true);
  assert.equal(existsSync(daemonFile), false);
  assert.equal(existsSync(browserFile), false);
  assert.ok(acts().includes(`--user disable --now ${unit}`));
  assert.ok(removed.lines.some((line) => line.startsWith(`${opts.timonHome} left untouched`)));
});

test('an uninstall from a CLI with no host spec still removes the host of this home', { skip: POSIX_PATHS }, () => {
  const { opts, browserFile } = machine();
  assert.equal(installService(opts).ok, true);
  const { browserHost: _spec, ...plain } = opts;
  assert.equal(uninstallService(plain).ok, true);
  assert.equal(existsSync(browserFile), false);
});

test('update apply: both units follow the package now installed', { skip: POSIX_PATHS }, () => {
  const first = machine({ version: '0.1.0', packageDir: 'old/Timon' });
  assert.equal(installService(first.opts).ok, true);
  // The same home and machine, a newer package in another directory.
  const newRoot = join(first.opts.homeDir, 'opt', 'Timon');
  mkdirSync(newRoot, { recursive: true });
  const desktop = join(newRoot, LINUX_DESKTOP_EXECUTABLE);
  writeFileSync(desktop, '');
  const base: ServiceOpts = { ...first.opts, installDir: join(newRoot, 'resources', 'orchestrator'), nodePath: desktop };
  const next: ServiceOpts = { ...packagedServiceOptions(base, desktop, 3110, '0.2.0'), restart: true };
  next.exec = first.opts.exec;
  next.browserHost = browserHostService(next, { executable: desktop, env: {}, configSettings: {}, stored: () => null });
  // The previous daemon still runs from its release copy, which the identity check adopts.
  const exec = next.exec;
  next.exec = (name, args) => {
    const res = exec(name, args);
    return args.includes('show') && args.includes(next.unitName!)
      ? { ...res, stdout: res.stdout.replace(first.opts.installDir, join(next.releasesRoot!, 'old-release', 'resources', 'orchestrator')) }
      : res;
  };
  const before = first.acts().length;
  const result = installService(next);
  assert.equal(result.ok, true, result.lines.join('\n'));
  assert.equal(readFileSync(first.daemonFile, 'utf8'), next.unitContent);
  assert.match(readFileSync(first.browserFile, 'utf8'), new RegExp(`^ExecStart=".+" ".+" "${desktop.replaceAll('/', '\\/')}" %n$`, 'm'));
  assert.ok(readFileSync(first.browserFile, 'utf8').includes(`"${join(newRoot, 'resources', 'node', 'node')}"`), 'the new package\'s own Node');
  const unit = browserHostUnit(next.timonHome);
  const acts = first.acts().slice(before);
  assert.ok(acts.includes(`--user restart ${next.unitName}`));
  assert.ok(acts.includes(`--user restart ${unit}`));
});

test('update apply on the same package path restarts the host on the new files', { skip: POSIX_PATHS }, () => {
  const { opts, acts } = machine();
  assert.equal(installService(opts).ok, true);
  const before = acts().length;
  assert.equal(installService({ ...opts, restart: true }).ok, true);
  assert.ok(acts().slice(before).includes(`--user restart ${browserHostUnit(opts.timonHome)}`));
  const plain = acts().length;
  assert.equal(installService(opts).ok, true);
  assert.ok(!acts().slice(plain).some((act) => act.startsWith('--user restart')), 'a plain reinstall leaves a running host alone');
});

test('a failed first install removes the host with the daemon it was written for', { skip: POSIX_PATHS }, () => {
  const { opts, browserFile, daemonFile } = machine();
  assert.equal(installService(opts).ok, true);
  assert.equal(removeServiceDefinition(opts).ok, true);
  assert.equal(existsSync(daemonFile), false);
  assert.equal(existsSync(browserFile), false);
});
