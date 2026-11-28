/**
 * The built-in browser of a Linux server with no screen, as a service of its own.
 *
 * The daemon reaches the browser through a provider only the desktop app ran: on a VPS, where
 * no app ever opens, every browser route answered 503. `timon-desktop --browser-host` runs the
 * engine alone (`desktop/src/browser-host.ts`); this module decides when `timon service
 * install` puts it under the supervisor next to the daemon, as `renderBrowserHostUnit`
 * describes it. The systemd gestures live with the daemon's, in `service-install.ts`.
 *
 * Never on a machine with a desktop session: there the app runs the browser, and the host
 * would only wait for it. No database import: the CLI and the update runner load this.
 */
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { isBundledNode } from './bundled-node.js';
import { linuxGraphicalSession } from './desktop-session.js';
import { readReleaseSource } from './packaged-handback.js';
import { browserHostUnit, renderBrowserHostUnit, runtimeDir } from './packaged-service.js';
import type { ServiceOpts } from './service-install.js';

/** The setting that turns the host off, resolved env > config > settings table > default (on). */
export const BROWSER_HOST_SETTING = 'TIMON_BROWSER_HOST_SERVICE';

/** The Electron executable of a Linux package (`/opt/Timon/timon-desktop`), next to `resources/`. */
export const LINUX_DESKTOP_EXECUTABLE = 'timon-desktop';

export type BrowserHostService = {
  unitName: string;
  /** `null` when this package cannot run the host; `refusal` says why. */
  unitContent: string | null;
  /** The installed package's `timon-desktop` the unit runs; `null` from an AppImage. */
  executable: string | null;
  /** The setting, read now: `timon doctor` tells a host turned off from one that died. */
  enabled: () => boolean;
  /**
   * Why the host must not run here, `null` to install it. Called at install time only: it may
   * ask systemd, which a status or an options build must not pay for.
   */
  refusal: () => string | null;
};

/** Same words as the settings registry (`settings.ts`), which the CLI cannot load. */
function parseBool(raw: string | number | boolean | null | undefined): boolean | null {
  if (raw === null || raw === undefined) return null;
  const value = String(raw).trim().toLowerCase();
  if (['1', 'true', 'on', 'yes'].includes(value)) return true;
  if (['0', 'false', 'off', 'no'].includes(value)) return false;
  return null;
}

/**
 * The setting, in the registry's order: the environment, then `settings` of
 * `timon.config.json`, then the settings table, then on. A value that does not read as a
 * boolean is skipped, as the registry skips it.
 */
export function browserHostEnabled(layers: {
  env: NodeJS.ProcessEnv;
  configSettings: Readonly<Record<string, string | number | boolean>>;
  stored: (key: string) => string | null;
}): boolean {
  const env = layers.env[BROWSER_HOST_SETTING];
  return parseBool(env === '' ? null : env)
    ?? parseBool(layers.configSettings[BROWSER_HOST_SETTING])
    ?? parseBool(layers.stored(BROWSER_HOST_SETTING))
    ?? true;
}

/**
 * One row of the settings table, read-only, without `db.ts`: loading it migrates the
 * database, which the update runner must not do before the update is approved. No database
 * yet, or one that cannot be read: `null`, and the next layer decides.
 */
export function readStoredSetting(dbPath: string, key: string): string | null {
  if (!existsSync(dbPath)) return null;
  try {
    const Database = createRequire(import.meta.url)('better-sqlite3') as typeof import('better-sqlite3');
    const db = new Database(dbPath, { readonly: true, fileMustExist: true, timeout: 1000 });
    try {
      const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value?: unknown } | undefined;
      return typeof row?.value === 'string' ? row.value : null;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

function inside(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

/**
 * The installed package's `timon-desktop`, from the runtime this process runs on: Electron
 * at the package's root, or the Node it ships under `resources/node/`. A daemon of the
 * service runs a copy under `desktop-runtime/releases/`, whose origin was recorded when it
 * was staged. An AppImage runs from a mount that goes away with it: `null`.
 */
export function installedDesktopExecutable(executable: string, home: string, env: NodeJS.ProcessEnv): string | null {
  if (env.APPIMAGE) return null;
  const bundled = isBundledNode(executable, 'linux');
  let root = bundled ? dirname(dirname(dirname(executable))) : dirname(executable);
  let name = bundled ? LINUX_DESKTOP_EXECUTABLE : basename(executable);
  if (inside(runtimeDir(home), root)) {
    const source = readReleaseSource(home);
    if (!source) return null;
    root = source.root;
    name = isBundledNode(join(root, source.executable), 'linux') ? LINUX_DESKTOP_EXECUTABLE : basename(source.executable);
  }
  if (/^\/tmp\/\.mount_/.test(root)) return null;
  return join(root, name);
}

/**
 * The host for a packaged Linux service, `undefined` anywhere else: macOS and Windows run
 * the browser in the app only, and a source checkout has no `timon-desktop` to run.
 */
export function browserHostService(opts: ServiceOpts, input: {
  executable: string;
  env: NodeJS.ProcessEnv;
  configSettings: Readonly<Record<string, string | number | boolean>>;
  stored: (key: string) => string | null;
}): BrowserHostService | undefined {
  if (opts.platform !== 'linux' || !opts.unitName) return undefined;
  const desktop = installedDesktopExecutable(input.executable, opts.timonHome, input.env);
  return {
    unitName: browserHostUnit(opts.timonHome),
    unitContent: desktop ? renderBrowserHostUnit(opts.timonHome, desktop) : null,
    executable: desktop,
    enabled: () => browserHostEnabled(input),
    refusal: () => {
      if (!browserHostEnabled(input)) return `turned off (${BROWSER_HOST_SETTING})`;
      if (linuxGraphicalSession(input.env, opts.exec)) return 'this machine has a desktop session, where the Timon app runs the browser';
      if (!desktop) return 'this package runs from a temporary mount (AppImage): install the .deb package on a server';
      if (!existsSync(desktop)) return `${desktop} is missing`;
      return null;
    },
  };
}
