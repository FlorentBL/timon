/**
 * Who provides the built-in browser on this machine, and when nobody does, why and what to run.
 *
 * The daemon reaches the browser through a provider: the desktop app on a machine with a screen,
 * the browser host unit (`browser-host-service.ts`) on a Linux server. When neither answered,
 * every browser route said "open Timon desktop", which is wrong on a server, and `timon doctor`
 * said nothing at all. This module gathers the facts (`builtInBrowserFacts`) and turns them into
 * one report (`builtInBrowserReport`), pure, which `timon doctor`, the daemon's start-up log, the
 * browser routes and `install.sh` (through `timon doctor --browser`) all read.
 *
 * Nothing of the provider's credential leaves here: only its process id, to tell a live provider
 * from one a `kill -9` left behind.
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { BuiltInBrowserProblem, BuiltInBrowserReport } from '../plugins/contract/system.js';
import type { BrowserHostService } from './browser-host-service.js';
import { linuxGraphicalSession, type SessionExec } from './desktop-session.js';

/** The fonts the installer adds to a server that has none (`scripts/install.sh`). */
export const SERVER_FONT_PACKAGES = ['fonts-liberation', 'fonts-noto-core', 'fonts-noto-color-emoji'] as const;
/** Heavy, so only named: pages in Chinese, Japanese or Korean need it. */
export const CJK_FONT_PACKAGE = 'fonts-noto-cjk';
export const INSTALL_SCRIPT_COMMAND = 'curl -fsSL https://timon-ai.com/install.sh | sh';

export type BuiltInBrowserFacts = {
  platform: NodeJS.Platform;
  /** The process `provider.json` names; `null` without a valid file. */
  providerPid: number | null;
  providerAlive: boolean;
  /** The process the browser host's marker names, when it still runs. */
  hostPid: number | null;
  graphicalSession: boolean;
  /** The browser host of an installed Linux package; `null` anywhere else. */
  host: null | {
    unit: string;
    enabled: boolean;
    executable: string | null;
    executablePresent: boolean;
    /** systemd's `ActiveState`; `null` when the unit is not installed. */
    state: string | null;
  };
  /** Linux: whether a font file is installed; `null` elsewhere. */
  fonts: boolean | null;
  /** The distribution installs with apt: the font repair names its packages. */
  apt: boolean;
};

const FONT_FILE = /\.(?:ttf|otf|ttc|pfb|pfa|woff2?)$/i;

/**
 * fontconfig's default folders. Linux only: the caller asks on Linux alone.
 * portability: Linux paths, read only when `platform === 'linux'`.
 */
export function defaultFontDirs(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string[] {
  const data = env.XDG_DATA_HOME || join(home, '.local', 'share');
  // portability: fontconfig's system folders, Linux only.
  return [join('/usr', 'share', 'fonts'), join('/usr', 'local', 'share', 'fonts'), join(data, 'fonts'), join(home, '.fonts')];
}

/**
 * Whether one font file exists under `dirs`. Bounded: a font folder is shallow, and a report must
 * not walk a disk. Chromium on Linux finds its fonts through fontconfig, which reads these
 * folders: with none, pages render with no text at all (`desktop/src/browser-host.ts`).
 */
export function hasInstalledFonts(dirs: readonly string[], limit = 5000): boolean {
  let seen = 0;
  const walk = (dir: string, depth: number): boolean => {
    let entries: import('node:fs').Dirent[];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return false; }
    for (const entry of entries) {
      if (++seen > limit) return false;
      if (entry.isFile() || entry.isSymbolicLink()) {
        if (FONT_FILE.test(entry.name)) return true;
      } else if (entry.isDirectory() && depth < 6 && walk(join(dir, entry.name), depth + 1)) return true;
    }
    return false;
  };
  return dirs.some((dir) => walk(dir, 0));
}

/** A process still exists. EPERM: it exists, under another account. */
export function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

/** The pid of `<home>/browser-native/browser-host.json`, written by a host that holds the home. */
export function readHostMarkerPid(home: string): number | null {
  try {
    const value = JSON.parse(readFileSync(join(home, 'browser-native', 'browser-host.json'), 'utf8')) as { pid?: unknown };
    return Number.isInteger(value.pid) && (value.pid as number) > 0 ? value.pid as number : null;
  } catch { return null; }
}

function unitState(exec: SessionExec, unit: string): string {
  try {
    const result = exec('systemctl', ['--user', 'show', unit, '--property=ActiveState']);
    const value = /^ActiveState=(\S+)/m.exec(result.stdout)?.[1];
    return result.code === 0 && value ? value : 'unknown';
  } catch { return 'unknown'; }
}

/** The facts of this machine, read now. `providerPid` comes from the caller, which reads `provider.json`. */
export function builtInBrowserFacts(input: {
  platform: NodeJS.Platform;
  home: string;
  env: NodeJS.ProcessEnv;
  exec: SessionExec;
  providerPid: number | null;
  browserHost: BrowserHostService | undefined;
  /** Where a systemd user unit of this account lives, `null` off Linux. */
  unitFile: (unit: string) => string | null;
  apt: boolean;
  alive?: (pid: number) => boolean;
  fontDirs?: readonly string[];
}): BuiltInBrowserFacts {
  const alive = input.alive ?? processAlive;
  const linux = input.platform === 'linux';
  const markerPid = readHostMarkerPid(input.home);
  const service = input.browserHost;
  let host: BuiltInBrowserFacts['host'] = null;
  if (linux && service) {
    const file = input.unitFile(service.unitName);
    host = {
      unit: service.unitName,
      enabled: service.enabled(),
      executable: service.executable,
      executablePresent: service.executable !== null && existsSync(service.executable),
      state: file && existsSync(file) ? unitState(input.exec, service.unitName) : null,
    };
  }
  return {
    platform: input.platform,
    providerPid: input.providerPid,
    providerAlive: input.providerPid !== null && alive(input.providerPid),
    hostPid: markerPid !== null && alive(markerPid) ? markerPid : null,
    graphicalSession: linux ? linuxGraphicalSession(input.env, input.exec) : true,
    host,
    fonts: linux ? hasInstalledFonts(input.fontDirs ?? defaultFontDirs(input.env)) : null,
    apt: input.apt,
  };
}

const RUNNING = new Set(['active', 'activating', 'reloading']);

function journal(unit: string): string {
  return `journalctl --user -u ${unit} -n 50`;
}

/** Why nobody provides the browser, in the order a person repairs it. */
function unavailable(f: BuiltInBrowserFacts, server: boolean): BuiltInBrowserProblem {
  const stalePid = f.providerPid !== null && !f.providerAlive ? f.providerPid : null;
  const blocking = (id: BuiltInBrowserProblem['id'], message: string, fix: string | null): BuiltInBrowserProblem =>
    ({ id, blocking: true, message, fix });
  if (!server) {
    return stalePid !== null
      ? blocking('stale-provider', `Timon desktop stopped without closing its browser (process ${stalePid} is gone).`, 'open the Timon app again')
      : blocking('desktop-closed', 'the Timon app is not open on this machine: it runs the built-in browser.', 'open the Timon app');
  }
  const host = f.host;
  if (!host) {
    return blocking('no-provider', 'this machine has no screen and no browser host: only the installed Linux package runs the built-in browser on a server.',
      `install the .deb package (${INSTALL_SCRIPT_COMMAND}), then run: timon service install`);
  }
  if (!host.enabled) {
    return blocking('host-turned-off', 'the browser host service is turned off (TIMON_BROWSER_HOST_SERVICE).',
      'turn on "Built-in browser service on a server" in Settings, then run: timon service install');
  }
  if (host.executable === null) {
    return blocking('host-appimage', 'Timon runs from an AppImage, which cannot run the browser host.', `install the .deb package: ${INSTALL_SCRIPT_COMMAND}`);
  }
  if (!host.executablePresent) {
    return blocking('desktop-missing', `the browser host's program is missing (${host.executable}).`, `reinstall Timon: ${INSTALL_SCRIPT_COMMAND}`);
  }
  if (host.state === null) {
    return blocking('host-unit-missing', 'the browser host service is not installed.', 'timon service install');
  }
  if (!RUNNING.has(host.state)) {
    return blocking('host-unit-stopped', `the browser host service is stopped (${host.state}${stalePid !== null ? `, its last process ${stalePid} is gone` : ''}); its log says why: ${journal(host.unit)}.`,
      `systemctl --user restart ${host.unit}`);
  }
  if (stalePid !== null) {
    return blocking('stale-provider', `the browser host left a provider whose process (${stalePid}) is gone; a new start replaces it.`,
      `systemctl --user restart ${host.unit}`);
  }
  return blocking('host-not-ready', 'the browser host service runs but does not offer the browser yet: it is starting, or waiting for Timon desktop to quit.',
    `if it lasts: ${journal(host.unit)}`);
}

function fontFix(apt: boolean): string {
  return apt
    ? `sudo apt-get install ${SERVER_FONT_PACKAGES.join(' ')} (and ${CJK_FONT_PACKAGE} for Chinese, Japanese or Korean pages), then restart the browser`
    : 'install the Liberation and Noto font packages of your distribution, then restart the browser';
}

/** The report of the facts. Pure: every reader of the facts says the same thing. */
export function builtInBrowserReport(f: BuiltInBrowserFacts): BuiltInBrowserReport {
  const live = f.providerPid !== null && f.providerAlive;
  const server = f.platform === 'linux' && !f.graphicalSession;
  const provider: BuiltInBrowserReport['provider'] = !live ? 'none' : f.hostPid === f.providerPid ? 'host' : 'desktop';
  const problems: BuiltInBrowserProblem[] = live ? [] : [unavailable(f, server)];
  if (f.fonts === false) {
    problems.push({
      id: 'no-fonts', blocking: false,
      message: 'no font is installed: screenshots and the browser panel show pages without any text (agents still read it).',
      fix: fontFix(f.apt),
    });
  }
  return { provider, server, unit: f.host?.unit ?? null, problems };
}

/** One line per fact, for `timon doctor` and the CLI; the first names the provider. */
export function formatBuiltInBrowser(r: BuiltInBrowserReport): string[] {
  const who = r.provider === 'desktop' ? 'provided by the Timon app'
    : r.provider === 'host' ? `provided by the browser host${r.unit ? ` (${r.unit})` : ''}`
      : 'UNAVAILABLE';
  const lines = [`built-in browser  ${who}`];
  for (const problem of r.problems) lines.push(`  ${problem.message}${problem.fix ? `  →  ${problem.fix}` : ''}`);
  return lines;
}
