/**
 * The built-in browser's state on this machine (`host/built-in-browser-status.ts`), read with
 * the daemon's own configuration and service options: what `timon doctor`, the start-up log and
 * the browser routes' refusal say.
 */
import { apiError, type ApiErrorBody } from './api-error.js';
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

/**
 * The refusal of a browser command no provider answered. On a server, "open Timon desktop" is
 * wrong: it names the host and the command that repairs it. The English `error` is what an agent
 * reads (the browser MCP passes it on): it says not to insist, and to tell the user.
 */
export function builtInBrowserRefusal(report: BuiltInBrowserReport): ApiErrorBody {
  const problem = report.problems.find((p) => p.blocking);
  if (report.server) {
    const command = problem?.fix ?? (report.unit ? `systemctl --user restart ${report.unit}` : 'timon doctor');
    const why = problem?.message ?? 'its provider does not answer.';
    return apiError('browser_host_stopped',
      `The built-in browser of this server is not running: ${why} Do not retry the browser: tell the user, who can repair it on the server: ${command}`,
      { command });
  }
  return apiError('browser_desktop_unavailable',
    'Open Timon desktop on the host machine to use this browser. Do not retry the browser: tell the user to open the Timon app.');
}

const REFUSAL_TTL_MS = 5_000;
let cached: { at: number; body: ApiErrorBody } | null = null;

/** `builtInBrowserRefusal` of now, kept a few seconds: a panel retrying must not run systemctl each time. */
export function browserUnavailableRefusal(now = Date.now(), read: () => BuiltInBrowserReport = builtInBrowserNow): ApiErrorBody {
  if (cached && now - cached.at < REFUSAL_TTL_MS) return cached.body;
  let body: ApiErrorBody;
  try { body = builtInBrowserRefusal(read()); }
  catch { body = builtInBrowserRefusal({ provider: 'none', server: false, unit: null, problems: [] }); }
  cached = { at: now, body };
  return body;
}

/** Test seam: forget the refusal kept by `browserUnavailableRefusal`. */
export function resetBrowserUnavailableRefusal(): void { cached = null; }

/** Whether a provider answers a status command now: what `timon doctor --browser` waits for. */
export async function probeBuiltInBrowser(home: string = TIMON_HOME, timeoutMs = 1_500): Promise<boolean> {
  try {
    await callNativeBrowser('_probe', { action: 'status' }, { home, timeoutMs });
    return true;
  } catch { return false; }
}
