/**
 * The built-in browser's state on this machine (`host/built-in-browser-status.ts`), read with
 * the daemon's own configuration and service options: what `timon doctor`, the start-up log and
 * the browser routes' refusal say.
 *
 * The routes read it through one shared probe (`builtInBrowserProbe`): asynchronous, one read in
 * flight whoever asks, kept a few seconds, longer when systemd did not answer. A synchronous read
 * held the daemon's event loop for up to three `systemctl` timeouts, every few seconds while a
 * panel or an agent retried, and froze every mission meanwhile.
 */
import { apiError, type ApiErrorBody } from './api-error.js';
import { config } from './config/load.js';
import { builtInBrowserFacts, builtInBrowserReport } from './host/built-in-browser-status.js';
import { getHost } from './host/index.js';
import { linuxRelease, readOsReleaseAsync } from './host/machine.js';
import { serviceOptsFromEnvironment } from './host/service-environment.js';
import { unitPath, type ServiceOpts } from './host/service-install.js';
import { callNativeBrowser, readNativeProviderAsync } from './native-browser-provider.js';
import { TIMON_HOME } from './paths.js';
import type { BuiltInBrowserReport } from './plugins/contract/system.js';

/** One `systemctl` question; a report must not wait on a systemd that does not answer. */
const EXEC_TIMEOUT_MS = 5_000;

let serviceOpts: ServiceOpts | undefined;

/**
 * Built once per process: they name the installed package and this home, which do not move under a
 * running process, and building them walks the PATH. The host's switch (`enabled()`) is still read
 * at every report.
 */
function browserServiceOpts(): ServiceOpts {
  serviceOpts ??= serviceOptsFromEnvironment(config(), () => getHost());
  return serviceOpts;
}

export type BuiltInBrowserRead = {
  report: BuiltInBrowserReport;
  /** A `systemctl` question timed out or could not run: the report is partial, keep it longer. */
  degraded: boolean;
};

/** The report of now, with whether a probe failed on the way. Never blocks the event loop on a probe. */
export async function readBuiltInBrowser(home: string = TIMON_HOME): Promise<BuiltInBrowserRead> {
  const opts = browserServiceOpts();
  const linux = process.platform === 'linux';
  let degraded = false;
  const exec = async (name: string, args: string[]) => {
    try {
      const result = await getHost().execAsync(name, args, { timeout: EXEC_TIMEOUT_MS, windowsHide: true });
      if (result.timedOut) degraded = true;
      return result;
    } catch (error) {
      degraded = true;
      throw error;
    }
  };
  const [provider, osRelease] = await Promise.all([readNativeProviderAsync(home), linux ? readOsReleaseAsync() : null]);
  const facts = await builtInBrowserFacts({
    platform: process.platform,
    home,
    env: process.env,
    exec,
    providerPid: provider?.pid ?? null,
    browserHost: opts.browserHost,
    unitFile: (unit) => (linux ? unitPath(opts.homeDir, unit) : null),
    apt: linux && linuxRelease(osRelease)?.packageManager === 'apt',
  });
  return { report: builtInBrowserReport(facts), degraded };
}

/** The report of now, read fresh: `timon doctor --browser`. */
export async function builtInBrowserNow(home: string = TIMON_HOME): Promise<BuiltInBrowserReport> {
  return (await readBuiltInBrowser(home)).report;
}

/** A probe every caller shares: one read in flight, its answer kept for a while. */
export type SharedProbe<T> = {
  /** The answer still fresh, else the read in flight, else a new read. */
  get(): Promise<T>;
  /** The last answer, however old, without waiting; a stale one starts a read in the background. */
  latest(): T | undefined;
  reset(): void;
};

/**
 * `read` runs alone: concurrent callers share its promise. A value `failed` says is partial, or a
 * read that throws or outlives `deadlineMs` (then `fallback`), is kept `failureTtlMs`: asking a
 * systemd that does not answer again every few seconds only stacks waiting processes.
 */
export function sharedProbe<T>(input: {
  read: () => Promise<T>;
  fallback: (error: unknown) => T;
  failed: (value: T) => boolean;
  ttlMs: number;
  failureTtlMs: number;
  deadlineMs: number;
  now?: () => number;
}): SharedProbe<T> {
  const now = input.now ?? Date.now;
  let cached: { value: T; until: number } | null = null;
  let inFlight: Promise<T> | null = null;
  // A reset while a read runs must not let that read fill the cache afterwards.
  let generation = 0;
  const start = (): Promise<T> => {
    const mine = generation;
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_, reject) => {
      // Not unref'd: cleared as soon as the read settles, and a CLI waiting on it must not exit first.
      timer = setTimeout(() => reject(new Error(`no answer within ${input.deadlineMs} ms`)), input.deadlineMs);
    });
    const keep = (value: T, failed: boolean): T => {
      if (mine === generation) cached = { value, until: now() + (failed ? input.failureTtlMs : input.ttlMs) };
      return value;
    };
    const run = Promise.race([Promise.resolve().then(input.read), deadline])
      .then((value) => keep(value, input.failed(value)), (error: unknown) => keep(input.fallback(error), true))
      .finally(() => {
        clearTimeout(timer);
        if (mine === generation) inFlight = null;
      });
    inFlight = run;
    return run;
  };
  return {
    get: () => {
      if (cached && now() < cached.until) return Promise.resolve(cached.value);
      return inFlight ?? start();
    },
    latest: () => {
      if ((!cached || now() >= cached.until) && !inFlight) void start();
      return cached?.value;
    },
    reset: () => {
      generation += 1;
      cached = null;
      inFlight = null;
    },
  };
}

const REPORT_TTL_MS = 5_000;
const FAILED_REPORT_TTL_MS = 30_000;
/** Above the three `systemctl` timeouts a report can wait on, side by side or not. */
const REPORT_DEADLINE_MS = 3 * EXEC_TIMEOUT_MS + 2_000;

/** The shared probe of the built-in browser; `null` is a read that failed. */
export function builtInBrowserProbe(
  read: () => Promise<BuiltInBrowserRead> = () => readBuiltInBrowser(),
  now: () => number = Date.now,
): SharedProbe<BuiltInBrowserRead | null> {
  return sharedProbe<BuiltInBrowserRead | null>({
    read,
    fallback: () => null,
    failed: (value) => value === null || value.degraded,
    ttlMs: REPORT_TTL_MS,
    failureTtlMs: FAILED_REPORT_TTL_MS,
    deadlineMs: REPORT_DEADLINE_MS,
    now,
  });
}

const probe = builtInBrowserProbe();

/** The report kept by the daemon's probe, without waiting: what `diagnose()` reads. */
export function builtInBrowserLatest(): BuiltInBrowserReport | undefined {
  return probe.latest()?.report;
}

/** The daemon's probe, waited for: the start-up log, and `timon doctor` before its report. */
export async function refreshBuiltInBrowser(): Promise<BuiltInBrowserReport | undefined> {
  return (await probe.get())?.report;
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

const NO_REPORT: BuiltInBrowserReport = { provider: 'none', server: false, unit: null, problems: [] };

/** `builtInBrowserRefusal` of the shared probe: a panel retrying reads it, it does not run systemctl each time. */
export async function browserUnavailableRefusal(source: SharedProbe<BuiltInBrowserRead | null> = probe): Promise<ApiErrorBody> {
  const read = await source.get();
  return builtInBrowserRefusal(read?.report ?? NO_REPORT);
}

/** Test seam: forget what the daemon's probe kept. */
export function resetBrowserUnavailableRefusal(): void { probe.reset(); }

/** Whether a provider answers a status command now: what `timon doctor --browser` waits for. */
export async function probeBuiltInBrowser(home: string = TIMON_HOME, timeoutMs = 1_500): Promise<boolean> {
  try {
    await callNativeBrowser('_probe', { action: 'status' }, { home, timeoutMs });
    return true;
  } catch { return false; }
}
