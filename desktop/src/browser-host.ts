/**
 * `timon-desktop --browser-host`: the built-in browser without the application, for a Linux
 * machine where only the daemon runs (a VPS, a server with no desktop session).
 *
 * The daemon reaches the browser through `<home>/browser-native/provider.json`, which only the
 * desktop app wrote: with no app open, every browser route answered 503. This launch starts the
 * engine, the capture of its tabs and the provider, and nothing else of the application (no
 * window, no tray, no update or consent screen, no data restore, no service install).
 *
 * One provider per home. The browser profiles live in the home (`browser-profiles/`) and
 * Chromium keeps them open while it runs: two processes on the same profile would corrupt it.
 * The host therefore takes the same single-instance lock as the application (the lock lives in
 * the `desktop-profile` folder both use), and the application with a screen comes first:
 *
 * - the host starts while the app runs: it waits for the lock, trying again every few seconds;
 * - the app starts while the host runs: its refused lock request reaches the host, which closes
 *   its provider and exits with `BROWSER_HOST_EXIT.yielded`; the app, seeing the host's marker,
 *   tries the lock again until it holds it. A claim file keeps a host its service restarts at
 *   once from taking the lock back in between;
 * - the app quits: it removes `provider.json`, and the waiting host takes the lock and writes its own.
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const BROWSER_HOST_FLAG = '--browser-host';

/** Exit codes, for the service manager that runs the host. */
export const BROWSER_HOST_EXIT = {
  /** Stopped on request (SIGTERM, SIGINT). */
  stopped: 0,
  /** Could not start: the log says why. */
  failed: 1,
  /** Timon desktop opened on this home and took the browser over: start again later (EX_TEMPFAIL). */
  yielded: 75,
  /**
   * Not on this system: starting again changes nothing (EX_CONFIG). Chromium refusing its
   * sandbox aborts before this script runs: the unit's launcher, which reads its errors, exits
   * with this code for it (`orchestrator/src/host/browser-host-launcher.ts`, a copy of the value).
   */
  unsupported: 78,
} as const;

/** What a host's lock request carries, so the application tells it from a second launch of its own. */
export const BROWSER_HOST_LAUNCH = { role: 'browser-host' } as const;

export function browserHostRequested(argv: readonly string[]): boolean {
  return argv.includes(BROWSER_HOST_FLAG);
}

/** Why this system cannot run the host, `null` on Linux. */
export function browserHostRefusal(platform: NodeJS.Platform): string | null {
  if (platform === 'linux') return null;
  const system = platform === 'darwin' ? 'macOS' : platform === 'win32' ? 'Windows' : platform;
  return `${BROWSER_HOST_FLAG} runs on Linux only. On ${system}, the built-in browser runs in the Timon desktop app: open Timon instead.`;
}

export function hasGraphicalSession(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.DISPLAY || env.WAYLAND_DISPLAY);
}

/**
 * Chromium's virtual screen on the headless platform. Its default is 1x1, and a window never
 * grows past its screen: every tab would be a single pixel.
 */
export const HEADLESS_SCREEN = '1920,1080';
export const HEADLESS_SWITCHES: readonly string[] = ['--ozone-platform=headless', `--ozone-override-screen-size=${HEADLESS_SCREEN}`];
/** Set on the second start: a guard against starting again forever if the switch were dropped. */
const RELAUNCHED = 'TIMON_BROWSER_HOST_HEADLESS';

/**
 * The command line and environment to start again with on the headless platform, or `null` when
 * this start can go on: a graphical session, or the platform already chosen on the command line.
 *
 * Why not `app.commandLine.appendSwitch` before `app.whenReady`: Electron picks its Ozone platform
 * before the main script runs (measured on 45.3.2: the switch is read, X11 is already chosen, and
 * the process exits with "Missing X server or $DISPLAY"). The switch has to be on the real command
 * line, so the host starts itself again with it, in the same process (`process.execve`): a
 * service manager keeps watching the PID it started.
 */
export function headlessRelaunch(argv: readonly string[], env: NodeJS.ProcessEnv, platform: NodeJS.Platform):
  { args: string[]; env: NodeJS.ProcessEnv } | null {
  if (platform !== 'linux' || hasGraphicalSession(env) || env[RELAUNCHED] === '1') return null;
  if (argv.some(arg => arg === '--ozone-platform' || arg.startsWith('--ozone-platform='))) return null;
  return { args: [...argv, ...HEADLESS_SWITCHES], env: { ...env, [RELAUNCHED]: '1' } };
}

/** True when a lock request comes from a browser host, not from a launch of the application. */
export function launchedByBrowserHost(data: unknown): boolean {
  return !!data && typeof data === 'object' && (data as { role?: unknown }).role === BROWSER_HOST_LAUNCH.role;
}

/** A process still exists. EPERM: it exists, under another user. */
export function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

interface Stamp { pid: number; at: number }

const hostMarkerPath = (home: string): string => join(home, 'browser-native', 'browser-host.json');
const appClaimPath = (home: string): string => join(home, 'browser-native', 'app-claim.json');

function writeStamp(path: string, stamp: Stamp): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${stamp.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(stamp), { mode: 0o600 });
  renameSync(temporary, path);
}

function readStamp(path: string): Stamp | null {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as Partial<Stamp>;
    return Number.isInteger(value.pid) && (value.pid as number) > 0 && typeof value.at === 'number' ? { pid: value.pid as number, at: value.at } : null;
  } catch { return null; }
}

/** Removes `path` only while it still names `pid`: a stale process never removes its successor's file. */
function removeStamp(path: string, pid: number): void {
  if (readStamp(path)?.pid === pid) rmSync(path, { force: true });
}

/** Written by the host once it holds the lock: what tells the application that a host, not another app, holds it. */
export function writeHostMarker(home: string, pid: number, now: number): void {
  writeStamp(hostMarkerPath(home), { pid, at: now });
}

export function removeHostMarker(home: string, pid: number): void {
  removeStamp(hostMarkerPath(home), pid);
}

/** The PID of the host that holds this home, `null` when none runs (no marker, or a crashed host's). */
export function liveBrowserHost(home: string, alive: (pid: number) => boolean = pidAlive): number | null {
  const marker = readStamp(hostMarkerPath(home));
  return marker && alive(marker.pid) ? marker.pid : null;
}

/** How long an application's claim keeps a host from asking for the lock. */
export const APP_CLAIM_MS = 30_000;

/** True while an application that asked a host to step aside may still be taking the lock. */
export function appClaimActive(home: string, now: number, alive: (pid: number) => boolean = pidAlive): boolean {
  const claim = readStamp(appClaimPath(home));
  return !!claim && now - claim.at < APP_CLAIM_MS && alive(claim.pid);
}

export interface Waiting {
  /** One lock request: true when this process now holds it. */
  request: () => boolean;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  alive?: (pid: number) => boolean;
  log?: (line: string) => void;
}

const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/**
 * The application found the lock held. When a browser host holds it, its refused request already
 * asked the host to step aside: it claims the home, then tries again until the host is gone.
 * False when another application holds it (the usual second launch) or the host never left.
 */
export async function takeHomeFromBrowserHost(input: Waiting & { home: string; pid: number; timeoutMs?: number; intervalMs?: number }):
  Promise<boolean> {
  const { home, pid, request } = input;
  const sleep = input.sleep ?? delay;
  const now = input.now ?? Date.now;
  const host = liveBrowserHost(home, input.alive);
  if (host === null) return false;
  input.log?.(`[desktop] the browser host (pid ${host}) holds this home: asking it to step aside`);
  const deadline = now() + (input.timeoutMs ?? 20_000);
  writeStamp(appClaimPath(home), { pid, at: now() });
  try {
    while (now() < deadline) {
      await sleep(input.intervalMs ?? 250);
      if (request()) {
        input.log?.('[desktop] the browser host stepped aside: this app now provides the browser');
        return true;
      }
    }
    input.log?.(`[desktop] the browser host (pid ${host}) did not step aside within ${Math.round((input.timeoutMs ?? 20_000) / 1000)} s`);
    return false;
  } finally { removeStamp(appClaimPath(home), pid); }
}

/**
 * The host waits for the home's lock: held by the application, or by another host. It does not
 * ask while an application claims the home. False once `stopped` says the host is stopping.
 */
export async function waitForHome(input: Waiting & { home: string; stopped: () => boolean; intervalMs?: number }): Promise<boolean> {
  const sleep = input.sleep ?? delay;
  const now = input.now ?? Date.now;
  let said = false;
  for (;;) {
    if (input.stopped()) return false;
    if (!appClaimActive(input.home, now(), input.alive) && input.request()) return true;
    if (!said) {
      input.log?.('[browser-host] Timon desktop or another browser host provides the browser for this home: waiting for it to quit');
      said = true;
    }
    await sleep(input.intervalMs ?? 5_000);
  }
}

/**
 * Said at start when Chromium finds no font: a server image often ships none, and pages then
 * render with no text at all on a screenshot or in the panel (not even boxes), while the page
 * text read by an agent stays intact.
 */
export const NO_FONT_WARNING = '[browser-host] no font is installed: screenshots and the browser panel show pages without any text'
  + ' (agents still read the page text). Install fonts, then restart the browser host. On Debian or Ubuntu:'
  + ' sudo apt install fonts-liberation fonts-noto-core fonts-noto-cjk fonts-noto-color-emoji;'
  + ' elsewhere, the Liberation and Noto font packages of the distribution.';

/** Measures a word in the default sans-serif font: zero wide means no font. False when there is none. */
export async function checkFonts(measure: () => Promise<number>, warn: (line: string) => void): Promise<boolean> {
  const width = await measure();
  if (width > 0) return true;
  warn(NO_FONT_WARNING);
  return false;
}
