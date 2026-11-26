/**
 * Who provides the built-in browser, and the repair of each way it goes missing
 * (`built-in-browser-status.ts`). Temporary folders and a simulated systemd: no real unit,
 * no real `TIMON_HOME`, no real font folder.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  builtInBrowserFacts, builtInBrowserReport, formatBuiltInBrowser, hasInstalledFonts, sandboxFacts, SERVER_FONT_PACKAGES,
  type BuiltInBrowserFacts, type FileProbe,
} from './built-in-browser-status.js';
import type { BrowserHostService } from './browser-host-service.js';
import type { BuiltInBrowserReport } from '../plugins/contract/system.js';

const UNIT = 'timon-browser-0123456789abcdef01234567';

function facts(over: Partial<BuiltInBrowserFacts> = {}, host: Partial<NonNullable<BuiltInBrowserFacts['host']>> | null = {}): BuiltInBrowserFacts {
  return {
    platform: 'linux', providerPid: null, providerAlive: false, hostPid: null, graphicalSession: false,
    host: host === null ? null : { unit: UNIT, enabled: true, executable: '/opt/Timon/timon-desktop', executablePresent: true, state: 'active', exitStatus: 0, ...host },
    fonts: true, apt: true, sandbox: null, ...over,
  };
}

const blocking = (r: BuiltInBrowserReport) => r.problems.find((p) => p.blocking);

/** A machine where the package is not installed: no file of the sandbox check exists. */
const NO_PACKAGE: FileProbe = { exists: () => false, readText: () => null, stat: () => null };

/** A fake filesystem for the sandbox check: the files it names, nothing else. */
function probe(files: { restriction?: string | null; profile?: boolean; helper?: { uid: number; mode: number } | null; app?: boolean }): FileProbe {
  return {
    exists: (path) => (path.endsWith('timon-desktop') && path.includes('apparmor.d') ? files.profile === true
      : path.endsWith('timon-desktop') ? files.app !== false : false),
    readText: (path) => (path.endsWith('apparmor_restrict_unprivileged_userns') ? files.restriction ?? null : null),
    stat: (path) => (path.endsWith('chrome-sandbox') ? files.helper ?? null : null),
  };
}

test('a live provider is the desktop app, or the host when the host marker names it', () => {
  const app = builtInBrowserReport(facts({ providerPid: 42, providerAlive: true, graphicalSession: true }));
  assert.equal(app.provider, 'desktop');
  assert.deepEqual(app.problems, []);
  const host = builtInBrowserReport(facts({ providerPid: 42, providerAlive: true, hostPid: 42 }));
  assert.equal(host.provider, 'host');
  assert.equal(host.server, true);
  assert.equal(host.unit, UNIT);
  assert.match(formatBuiltInBrowser(host)[0]!, new RegExp(`provided by the browser host \\(${UNIT}\\)`));
});

test('on a server, each missing piece names its own repair, in the order a person repairs it', () => {
  const cases: [Partial<NonNullable<BuiltInBrowserFacts['host']>>, string, RegExp][] = [
    [{ enabled: false }, 'host-turned-off', /Settings, then run: timon service install/],
    [{ executable: null }, 'host-appimage', /install\.sh \| sh/],
    [{ executablePresent: false }, 'desktop-missing', /reinstall Timon/],
    [{ state: null }, 'host-unit-missing', /^timon service install$/],
    [{ state: 'failed' }, 'host-unit-stopped', new RegExp(`^systemctl --user restart ${UNIT}$`)],
    [{ state: 'activating' }, 'host-not-ready', /journalctl --user -u/],
  ];
  for (const [host, id, fix] of cases) {
    const problem = blocking(builtInBrowserReport(facts({}, host)));
    assert.equal(problem?.id, id, JSON.stringify(host));
    assert.match(problem?.fix ?? '', fix, id);
  }
  const stopped = blocking(builtInBrowserReport(facts({}, { state: 'failed' })));
  assert.match(stopped!.message, new RegExp(`journalctl --user -u ${UNIT} -n 50`));
});

test('a provider a kill -9 left behind is told from a live one', () => {
  const server = builtInBrowserReport(facts({ providerPid: 4242, providerAlive: false }));
  assert.equal(server.provider, 'none');
  assert.equal(blocking(server)?.id, 'stale-provider');
  assert.match(blocking(server)!.message, /4242/);
  assert.match(blocking(server)!.fix!, /systemctl --user restart/);
  // The unit itself is down: that is the cause, the stale pid only a detail.
  const down = blocking(builtInBrowserReport(facts({ providerPid: 4242 }, { state: 'inactive' })));
  assert.equal(down?.id, 'host-unit-stopped');
  assert.match(down!.message, /4242 is gone/);
  const desk = blocking(builtInBrowserReport(facts({ providerPid: 4242, graphicalSession: true })));
  assert.equal(desk?.id, 'stale-provider');
  assert.equal(desk?.fix, 'open the Timon app again');
});

test('a machine with a screen, or with no host at all, says what runs the browser there', () => {
  const desktop = builtInBrowserReport(facts({ graphicalSession: true }));
  assert.equal(desktop.server, false);
  assert.equal(blocking(desktop)?.id, 'desktop-closed');
  for (const platform of ['darwin', 'win32'] as const) {
    assert.equal(blocking(builtInBrowserReport(facts({ platform, graphicalSession: true, fonts: null }, null)))?.id, 'desktop-closed');
  }
  const bare = blocking(builtInBrowserReport(facts({}, null)));
  assert.equal(bare?.id, 'no-provider');
  assert.match(bare!.fix!, /timon service install/);
});

test('no font is a warning with the apt packages, even while the browser runs', () => {
  const report = builtInBrowserReport(facts({ providerPid: 7, providerAlive: true, hostPid: 7, fonts: false }));
  assert.equal(report.provider, 'host');
  const fonts = report.problems.find((p) => p.id === 'no-fonts');
  assert.equal(fonts?.blocking, false);
  assert.match(fonts!.fix!, new RegExp(`sudo apt-get install ${SERVER_FONT_PACKAGES.join(' ')}`));
  assert.match(fonts!.fix!, /fonts-noto-cjk/);
  const other = builtInBrowserReport(facts({ fonts: false, apt: false })).problems.find((p) => p.id === 'no-fonts');
  assert.doesNotMatch(other!.fix!, /apt-get/);
  assert.equal(builtInBrowserReport(facts({ platform: 'darwin', fonts: null, graphicalSession: true }, null)).problems.some((p) => p.id === 'no-fonts'), false);
});

test('a font file is found in a nested folder; an empty tree or a missing folder has none', () => {
  const root = mkdtempSync(join(tmpdir(), 'timon-fonts-'));
  try {
    mkdirSync(join(root, 'empty', 'truetype'), { recursive: true });
    writeFileSync(join(root, 'empty', 'truetype', 'README'), '');
    assert.equal(hasInstalledFonts([join(root, 'empty'), join(root, 'absent')]), false);
    mkdirSync(join(root, 'full', 'truetype', 'liberation'), { recursive: true });
    writeFileSync(join(root, 'full', 'truetype', 'liberation', 'LiberationSans-Regular.ttf'), '');
    assert.equal(hasInstalledFonts([join(root, 'empty'), join(root, 'full')]), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the facts read the provider, the host marker, the unit and the fonts of this home', () => {
  const root = mkdtempSync(join(tmpdir(), 'timon-browser-facts-'));
  try {
    const home = join(root, 'home');
    mkdirSync(join(home, 'browser-native'), { recursive: true });
    writeFileSync(join(home, 'browser-native', 'browser-host.json'), JSON.stringify({ pid: 314, at: 1 }));
    const unitFile = join(root, `${UNIT}.service`);
    writeFileSync(unitFile, '[Unit]\n');
    const executable = join(root, 'timon-desktop');
    writeFileSync(executable, '');
    const asked: string[] = [];
    const exec = (name: string, args: string[]) => {
      asked.push([name, ...args].join(' '));
      if (args.includes('--property=ActiveState')) return { code: 0, stdout: 'ActiveState=failed\nExecMainStatus=78\n', stderr: '' };
      return { code: 1, stdout: '', stderr: '' };
    };
    const browserHost: BrowserHostService = {
      unitName: UNIT, unitContent: '[Unit]\n', executable, enabled: () => true, refusal: () => null,
    };
    const read = builtInBrowserFacts({
      platform: 'linux', home, env: {}, exec, providerPid: 314, browserHost, apt: true,
      unitFile: () => unitFile, alive: (pid) => pid === 314, fontDirs: [join(root, 'no-fonts')], probe: NO_PACKAGE,
    });
    assert.deepEqual(read, {
      platform: 'linux', providerPid: 314, providerAlive: true, hostPid: 314, graphicalSession: false,
      host: { unit: UNIT, enabled: true, executable, executablePresent: true, state: 'failed', exitStatus: 78 },
      fonts: false, apt: true, sandbox: null,
    });
    assert.ok(asked.includes(`systemctl --user show ${UNIT} --property=ActiveState --property=ExecMainStatus`));
    // No unit file: systemd is not asked for its state.
    const none = builtInBrowserFacts({
      platform: 'linux', home, env: { DISPLAY: ':0' }, exec, providerPid: null, browserHost, apt: false,
      unitFile: () => join(root, 'missing.service'), alive: () => false, fontDirs: [], probe: NO_PACKAGE,
    });
    assert.equal(none.host?.state, null);
    assert.equal(none.graphicalSession, true);
    assert.equal(none.hostPid, null);
    // Off Linux: no host, no font check, and nothing asked of systemd.
    const before = asked.length;
    const mac = builtInBrowserFacts({
      platform: 'darwin', home, env: {}, exec, providerPid: null, browserHost: undefined, apt: false, unitFile: () => null, alive: () => false,
    });
    assert.equal(mac.host, null);
    assert.equal(mac.fonts, null);
    assert.equal(asked.length, before);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the package\'s sandbox: restricted namespaces, no profile and no setuid helper is a blocker with its repair', () => {
  const setuid = { uid: 0, mode: 0o104755 };
  const plain = { uid: 0, mode: 0o100755 };
  const unusable = sandboxFacts(probe({ restriction: '1\n', profile: false, helper: plain }), '/opt/Timon');
  assert.deepEqual(unusable, { restricted: true, profile: false, helperSetuid: false });
  const report = builtInBrowserReport(facts({ sandbox: unusable, providerPid: 9, providerAlive: true }));
  const problem = blocking(report);
  assert.equal(problem?.id, 'no-sandbox');
  assert.equal(problem?.message, 'Chromium has no usable sandbox: the Timon app and the built-in browser cannot start.');
  assert.equal(problem?.fix, 'sudo chown root:root /opt/Timon/chrome-sandbox && sudo chmod 4755 /opt/Timon/chrome-sandbox'
    + ' (or reinstall the package, which installs its AppArmor profile)');
  assert.equal(report.problems.filter((p) => p.blocking).length, 1, 'the sandbox replaces the unit state as the cause');

  // Any one of the three ways out is enough.
  for (const fine of [
    probe({ restriction: '0', profile: false, helper: plain }),
    probe({ restriction: null, profile: false, helper: plain }),
    probe({ restriction: '1', profile: true, helper: plain }),
    probe({ restriction: '1', profile: false, helper: setuid }),
  ]) {
    const sandbox = sandboxFacts(fine, '/opt/Timon');
    assert.equal(builtInBrowserReport(facts({ sandbox, graphicalSession: true })).problems.some((p) => p.id === 'no-sandbox'), false, JSON.stringify(sandbox));
  }
  // Setuid but not root, or root with a group-writable mode: not a helper Chromium accepts.
  assert.equal(sandboxFacts(probe({ restriction: '1', helper: { uid: 1000, mode: 0o104755 } }), '/opt/Timon')?.helperSetuid, false);
  assert.equal(sandboxFacts(probe({ restriction: '1', helper: { uid: 0, mode: 0o104775 } }), '/opt/Timon')?.helperSetuid, false);
  // No package installed: nothing to say.
  assert.equal(sandboxFacts(probe({ restriction: '1', app: false }), '/opt/Timon'), null);
});

test('a browser host unit failed with the launcher\'s refusal exit says the same', () => {
  const refused = builtInBrowserReport(facts({}, { state: 'failed', exitStatus: 78 }));
  assert.equal(blocking(refused)?.id, 'no-sandbox');
  const crashed = builtInBrowserReport(facts({}, { state: 'failed', exitStatus: 1 }));
  assert.equal(blocking(crashed)?.id, 'host-unit-stopped');
});
