/**
 * The built-in browser's state on this machine (`host/built-in-browser-status.ts`), read with
 * the daemon's own configuration and service options: what `timon doctor` and the start-up log say.
 */
import { config } from './config/load.js';
import { builtInBrowserFacts, builtInBrowserReport } from './host/built-in-browser-status.js';
import { getHost } from './host/index.js';
import { linuxRelease, readOsRelease } from './host/machine.js';
import { serviceOptsFromEnvironment } from './host/service-environment.js';
import { unitPath } from './host/service-install.js';
import { callNativeBrowser, readNativeProvider } from './native-browser-provider.js';
import { TIMON_HOME } from './paths.js';
import type { BuiltInBrowserReport } from './plugins/contract/system.js';

export function builtInBrowserNow(home: string = TIMON_HOME): BuiltInBrowserReport {
  const host = getHost();
  const opts = serviceOptsFromEnvironment(config(), () => host);
  const linux = process.platform === 'linux';
  return builtInBrowserReport(builtInBrowserFacts({
    platform: process.platform,
    home,
    env: process.env,
    // A report must not hang on a systemd that does not answer.
    exec: (name, args) => opts.exec(name, args, { timeout: 5_000 }),
    providerPid: readNativeProvider(home)?.pid ?? null,
    browserHost: opts.browserHost,
    unitFile: (unit) => (linux ? unitPath(opts.homeDir, unit) : null),
    apt: linux && linuxRelease(readOsRelease())?.packageManager === 'apt',
  }));
}

/** Whether a provider answers a status command now: what `timon doctor --browser` waits for. */
export async function probeBuiltInBrowser(home: string = TIMON_HOME, timeoutMs = 1_500): Promise<boolean> {
  try {
    await callNativeBrowser('_probe', { action: 'status' }, { home, timeoutMs });
    return true;
  } catch { return false; }
}
