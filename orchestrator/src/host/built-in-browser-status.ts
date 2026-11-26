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
 * Every probe is asynchronous: the browser routes read these facts while the daemon serves every
 * mission, and a `systemd --user` that does not answer held its event loop for each `systemctl`
 * timeout when they were not.
 *
 * Nothing of the provider's credential leaves here: only its process id, to tell a live provider
 * from one a `kill -9` left behind.
 */
import { access, readdir, readFile, stat } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { BuiltInBrowserProblem, BuiltInBrowserReport } from '../plugins/contract/system.js';
import type { BrowserHostService } from './browser-host-service.js';
import { linuxGraphicalSessionAsync, type AsyncSessionExec } from './desktop-session.js';

/** The fonts the installer adds to a server that has none (`scripts/install.sh`). */
export const SERVER_FONT_PACKAGES = ['fonts-liberation', 'fonts-noto-core', 'fonts-noto-color-emoji'] as const;
/** Heavy, so only named: pages in Chinese, Japanese or Korean need it. */
export const CJK_FONT_PACKAGE = 'fonts-noto-cjk';
export const INSTALL_SCRIPT_COMMAND = 'curl -fsSL https://timon-ai.com/install.sh | sh';
/** Where the deb installs the app; portability: a Linux package path, read on Linux only. */
export const LINUX_PACKAGE_DIR = join('/opt', 'Timon');
/** The unit's exit status for a host that can never start here (`browser-host-launcher.ts`), its sandbox included. */
const HOST_REFUSED_EXIT = 78;
// portability: Linux kernel and AppArmor files, read on Linux only.
const USERNS_RESTRICTION = join('/proc', 'sys', 'kernel', 'apparmor_restrict_unprivileged_userns');
// portability: the AppArmor profile the deb installs, Linux only.
const APPARMOR_PROFILE = join('/etc', 'apparmor.d', 'timon-desktop');

/** The few file reads the sandbox check makes, faked in the tests: no real /proc there. */
export type FileProbe = {
  exists: (path: string) => Promise<boolean>;
  readText: (path: string) => Promise<string | null>;
  stat: (path: string) => Promise<{ uid: number; mode: number } | null>;
};

export async function pathExists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}

export const realFileProbe: FileProbe = {
  exists: pathExists,
  readText: async (path) => { try { return await readFile(path, 'utf8'); } catch { return null; } },
  stat: async (path) => { try { const s = await stat(path); return { uid: s.uid, mode: s.mode }; } catch { return null; } },
};

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
    /** systemd's `ExecMainStatus` of its last run; `null` when unknown. */
    exitStatus: number | null;
  };
  /**
   * The installed Linux package's Chromium sandbox: Ubuntu 23.10 and later refuse user
   * namespaces to a program AppArmor does not name, and then only a setuid root helper lets
   * Chromium start. `null` off Linux or without the package.
   */
  sandbox: null | { restricted: boolean; profile: boolean; helperSetuid: boolean };
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
export async function hasInstalledFonts(dirs: readonly string[], limit = 5000): Promise<boolean> {
  let seen = 0;
  // One folder at a time: the limit bounds the whole walk, not each branch of it.
  const walk = async (dir: string, depth: number): Promise<boolean> => {
    let entries: Dirent[];
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return false; }
    for (const entry of entries) {
      if (++seen > limit) return false;
      if (entry.isFile() || entry.isSymbolicLink()) {
        if (FONT_FILE.test(entry.name)) return true;
      } else if (entry.isDirectory() && depth < 6 && await walk(join(dir, entry.name), depth + 1)) return true;
    }
    return false;
  };
  for (const dir of dirs) if (await walk(dir, 0)) return true;
  return false;
}

/** A process still exists. EPERM: it exists, under another account. */
export function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

/** The pid of `<home>/browser-native/browser-host.json`, written by a host that holds the home. */
export async function readHostMarkerPid(home: string): Promise<number | null> {
  try {
    const value = JSON.parse(await readFile(join(home, 'browser-native', 'browser-host.json'), 'utf8')) as { pid?: unknown };
    return Number.isInteger(value.pid) && (value.pid as number) > 0 ? value.pid as number : null;
  } catch { return null; }
}

async function unitState(exec: AsyncSessionExec, unit: string): Promise<{ state: string; exitStatus: number | null }> {
  try {
    const result = await exec('systemctl', ['--user', 'show', unit, '--property=ActiveState', '--property=ExecMainStatus']);
    if (result.code !== 0) return { state: 'unknown', exitStatus: null };
    const state = /^ActiveState=(\S+)/m.exec(result.stdout)?.[1] ?? 'unknown';
    const status = /^ExecMainStatus=(\d+)/m.exec(result.stdout)?.[1];
    return { state, exitStatus: status === undefined ? null : Number(status) };
  } catch { return { state: 'unknown', exitStatus: null }; }
}

/** The package's sandbox facts, `null` when the package is not installed in `packageDir`. */
export async function sandboxFacts(probe: FileProbe, packageDir: string = LINUX_PACKAGE_DIR): Promise<BuiltInBrowserFacts['sandbox']> {
  if (!await probe.exists(join(packageDir, 'timon-desktop'))) return null;
  const [helper, restriction, profile] = await Promise.all([
    probe.stat(join(packageDir, 'chrome-sandbox')), probe.readText(USERNS_RESTRICTION), probe.exists(APPARMOR_PROFILE),
  ]);
  return {
    restricted: restriction?.trim() === '1',
    profile,
    // 4755 exactly: setuid root, and nobody else may write it.
    helperSetuid: helper !== null && helper.uid === 0 && (helper.mode & 0o7777) === 0o4755,
  };
}

/**
 * The facts of this machine, read now, the probes side by side: the slowest one, not their sum,
 * bounds the wait. `providerPid` comes from the caller, which reads `provider.json`.
 */
export async function builtInBrowserFacts(input: {
  platform: NodeJS.Platform;
  home: string;
  env: NodeJS.ProcessEnv;
  exec: AsyncSessionExec;
  providerPid: number | null;
  browserHost: BrowserHostService | undefined;
  /** Where a systemd user unit of this account lives, `null` off Linux. */
  unitFile: (unit: string) => string | null;
  apt: boolean;
  alive?: (pid: number) => boolean;
  fontDirs?: readonly string[];
  probe?: FileProbe;
  packageDir?: string;
}): Promise<BuiltInBrowserFacts> {
  const alive = input.alive ?? processAlive;
  const linux = input.platform === 'linux';
  const service = input.browserHost;
  const readHost = async (): Promise<BuiltInBrowserFacts['host']> => {
    if (!linux || !service) return null;
    const file = input.unitFile(service.unitName);
    const [unit, executablePresent] = await Promise.all([
      file && await pathExists(file) ? unitState(input.exec, service.unitName) : null,
      service.executable !== null ? pathExists(service.executable) : false,
    ]);
    return {
      unit: service.unitName,
      enabled: service.enabled(),
      executable: service.executable,
      executablePresent,
      state: unit?.state ?? null,
      exitStatus: unit?.exitStatus ?? null,
    };
  };
  const [markerPid, host, graphicalSession, fonts, sandbox] = await Promise.all([
    readHostMarkerPid(input.home),
    readHost(),
    linux ? linuxGraphicalSessionAsync(input.env, input.exec) : true,
    linux ? hasInstalledFonts(input.fontDirs ?? defaultFontDirs(input.env)) : null,
    linux ? sandboxFacts(input.probe ?? realFileProbe, input.packageDir) : null,
  ]);
  return {
    platform: input.platform,
    providerPid: input.providerPid,
    providerAlive: input.providerPid !== null && alive(input.providerPid),
    hostPid: markerPid !== null && alive(markerPid) ? markerPid : null,
    graphicalSession,
    host,
    fonts,
    apt: input.apt,
    sandbox,
  };
}

/**
 * Chromium cannot start, the app no more than the host: no namespace (restricted, no profile)
 * and no setuid helper; or the host's unit failed with the launcher's refusal exit.
 */
function noSandbox(f: BuiltInBrowserFacts): BuiltInBrowserProblem | null {
  const sandbox = f.sandbox;
  const unusable = sandbox !== null && sandbox.restricted && !sandbox.profile && !sandbox.helperSetuid;
  const refused = f.host?.state === 'failed' && f.host.exitStatus === HOST_REFUSED_EXIT;
  if (!unusable && !refused) return null;
  const helper = join(LINUX_PACKAGE_DIR, 'chrome-sandbox');
  return {
    id: 'no-sandbox', blocking: true,
    message: 'Chromium has no usable sandbox: the Timon app and the built-in browser cannot start.',
    fix: `sudo chown root:root ${helper} && sudo chmod 4755 ${helper} (or reinstall the package, which installs its AppArmor profile)`,
  };
}

const RUNNING = new Set(['active', 'activating', 'reloading']);

/** The command that shows why a unit stopped, or why it does not get ready. */
export function journalCommand(unit: string): string {
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
    return blocking('host-unit-stopped', `the browser host service is stopped (${host.state}${stalePid !== null ? `, its last process ${stalePid} is gone` : ''}); its log says why: ${journalCommand(host.unit)}.`,
      `systemctl --user restart ${host.unit}`);
  }
  if (stalePid !== null) {
    return blocking('stale-provider', `the browser host left a provider whose process (${stalePid}) is gone; a new start replaces it.`,
      `systemctl --user restart ${host.unit}`);
  }
  return blocking('host-not-ready', 'the browser host service runs but does not offer the browser yet: it is starting, or waiting for Timon desktop to quit.',
    `wait a few seconds; if it lasts, read its log: ${journalCommand(host.unit)}`);
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
  // The sandbox is the cause whatever the unit says: it comes first, in place of the unit's state.
  const sandbox = noSandbox(f);
  const problems: BuiltInBrowserProblem[] = sandbox ? [sandbox] : live ? [] : [unavailable(f, server)];
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
