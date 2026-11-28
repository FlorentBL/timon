/**
 * What `timon-desktop --browser-host` runs (rules in `browser-host.ts`). Electron, the engine and
 * the process come in as seams: `main.ts` passes the real ones, the tests their stand-ins.
 */
import { join } from 'node:path';
import {
  BROWSER_HOST_EXIT, BROWSER_HOST_LAUNCH, browserHostRefusal, checkFonts, headlessRelaunch, launchedByBrowserHost,
  removeHostMarker, waitForHome, writeHostMarker,
} from './browser-host.js';

/** What runs while the host serves: the engine, its capture and the provider. */
export interface RunningProvider { close(): Promise<void> }

export interface BrowserHostSeams {
  platform: NodeJS.Platform;
  argv: readonly string[];
  env: NodeJS.ProcessEnv;
  pid: number;
  execPath: string;
  /** Replaces this process, same PID (`process.execve`); does not return. */
  execve(file: string, args: string[], env: NodeJS.ProcessEnv): void;
  /** The Ozone platform Chromium runs on (`app.commandLine.getSwitchValue('ozone-platform')`). */
  ozonePlatform(): string;
  setUserData(path: string): void;
  requestLock(data: typeof BROWSER_HOST_LAUNCH): boolean;
  whenReady(): Promise<unknown>;
  /** Electron quits when its last window closes: a host between two profiles has none. */
  keepRunningWithoutWindows(): void;
  onSecondInstance(listener: (data: unknown) => void): void;
  onQuitRequest(listener: (prevent: () => void) => void): void;
  onSignal(signal: 'SIGTERM' | 'SIGINT', listener: () => void): void;
  exit(code: number): void;
  /** The home, resolved (`realpath`) and created. */
  resolveHome(): string;
  installLog(home: string): void;
  start(home: string, headless: boolean): Promise<RunningProvider>;
  /** Width of a word in the default font, in CSS pixels (`checkFonts`). */
  measureText(): Promise<number>;
  now?(): number;
  sleep?(ms: number): Promise<void>;
  alive?(pid: number): boolean;
  log(line: string): void;
  error(line: string, cause?: unknown): void;
}

export async function runBrowserHost(s: BrowserHostSeams): Promise<void> {
  const refusal = browserHostRefusal(s.platform);
  if (refusal) {
    s.error(`[browser-host] ${refusal}`);
    s.exit(BROWSER_HOST_EXIT.unsupported);
    return;
  }
  const relaunch = headlessRelaunch(s.argv, s.env, s.platform);
  if (relaunch) {
    s.log('[browser-host] no graphical session: starting again on the headless platform');
    s.execve(s.execPath, relaunch.args, relaunch.env);
    return;
  }
  const headless = s.ozonePlatform() === 'headless';
  const home = s.resolveHome();
  // The application's folder: the single-instance lock lives there, and it must be the same lock.
  s.setUserData(join(home, 'desktop-profile'));
  s.keepRunningWithoutWindows();

  // The provider, once its start is under way: a stop waits for it, then closes what started.
  let startup: Promise<RunningProvider | null> | null = null;
  let stopping: Promise<void> | null = null;
  const stop = (code: number, why: string): Promise<void> => {
    if (stopping) return stopping;
    s.log(`[browser-host] stopping: ${why}`);
    stopping = (async () => {
      try { await (await startup)?.close(); }
      catch (error) { s.error('[browser-host] the browser did not close cleanly', error); }
      removeHostMarker(home, s.pid);
    })().finally(() => s.exit(code));
    return stopping;
  };
  for (const signal of ['SIGTERM', 'SIGINT'] as const) s.onSignal(signal, () => { void stop(BROWSER_HOST_EXIT.stopped, signal); });
  // Chromium turns a SIGTERM into a quit of its own: the provider closes first all the same.
  s.onQuitRequest((prevent) => { prevent(); void stop(BROWSER_HOST_EXIT.stopped, 'quit requested (a signal, or the session ending)'); });
  s.onSecondInstance((data) => {
    // Another host waiting for this home asks at every try: it waits, nothing changes here.
    if (launchedByBrowserHost(data)) return;
    void stop(BROWSER_HOST_EXIT.yielded, 'Timon desktop opened on this home and provides the browser from now on');
  });

  const held = await waitForHome({
    home, request: () => s.requestLock(BROWSER_HOST_LAUNCH), stopped: () => stopping !== null,
    ...(s.sleep ? { sleep: s.sleep } : {}), ...(s.now ? { now: s.now } : {}), ...(s.alive ? { alive: s.alive } : {}),
    log: s.log,
  });
  if (!held) return;
  s.installLog(home);
  await s.whenReady();
  if (stopping) return;
  writeHostMarker(home, s.pid, (s.now ?? Date.now)());
  startup = s.start(home, headless).catch((error: unknown) => {
    s.error('[browser-host] the browser could not start', error);
    return null;
  });
  if (!await startup) { await stop(BROWSER_HOST_EXIT.failed, 'start failed'); return; }
  if (stopping) return;
  void checkFonts(() => s.measureText(), line => s.error(line))
    .catch((error: unknown) => s.error('[browser-host] the font check failed', error));
  s.log(`[browser-host] the built-in browser of ${home} is ready (${headless ? 'headless platform, no screen' : 'graphical session'})`);
}
