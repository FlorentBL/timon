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
  builtInBrowserFacts, builtInBrowserReport, formatBuiltInBrowser, hasInstalledFonts, SERVER_FONT_PACKAGES, type BuiltInBrowserFacts,
} from './built-in-browser-status.js';
import type { BrowserHostService } from './browser-host-service.js';
import type { BuiltInBrowserReport } from '../plugins/contract/system.js';

const UNIT = 'timon-browser-0123456789abcdef01234567';

function facts(over: Partial<BuiltInBrowserFacts> = {}, host: Partial<NonNullable<BuiltInBrowserFacts['host']>> | null = {}): BuiltInBrowserFacts {
  return {
    platform: 'linux', providerPid: null, providerAlive: false, hostPid: null, graphicalSession: false,
    host: host === null ? null : { unit: UNIT, enabled: true, executable: '/opt/Timon/timon-desktop', executablePresent: true, state: 'active', ...host },
    fonts: true, apt: true, ...over,
  };
}

const blocking = (r: BuiltInBrowserReport) => r.problems.find((p) => p.blocking);

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
      if (args.includes('--property=ActiveState')) return { code: 0, stdout: 'ActiveState=failed\n', stderr: '' };
      return { code: 1, stdout: '', stderr: '' };
    };
    const browserHost: BrowserHostService = {
      unitName: UNIT, unitContent: '[Unit]\n', executable, enabled: () => true, refusal: () => null,
    };
    const read = builtInBrowserFacts({
      platform: 'linux', home, env: {}, exec, providerPid: 314, browserHost, apt: true,
      unitFile: () => unitFile, alive: (pid) => pid === 314, fontDirs: [join(root, 'no-fonts')],
    });
    assert.deepEqual(read, {
      platform: 'linux', providerPid: 314, providerAlive: true, hostPid: 314, graphicalSession: false,
      host: { unit: UNIT, enabled: true, executable, executablePresent: true, state: 'failed' },
      fonts: false, apt: true,
    });
    assert.ok(asked.includes(`systemctl --user show ${UNIT} --property=ActiveState`));
    // No unit file: systemd is not asked for its state.
    const none = builtInBrowserFacts({
      platform: 'linux', home, env: { DISPLAY: ':0' }, exec, providerPid: null, browserHost, apt: false,
      unitFile: () => join(root, 'missing.service'), alive: () => false, fontDirs: [],
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
