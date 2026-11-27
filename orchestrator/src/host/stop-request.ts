/**
 * Windows: a file that asks the service's daemon to stop, so that the
 * installer stops it cleanly without holding any credential.
 *
 * The Windows installer must end the daemon of the scheduled task before it
 * replaces its files (`desktop/build/timon-service-pause.ps1`). It ended it
 * with `taskkill /F`, which runs no handler, so the next start read the
 * previous run as `unknown`. Asking through `POST /api/daemon/shutdown` would
 * mean sending the daemon token from an elevated script, and two security
 * reviews refused it (TODO #1078): nothing proved who the listener was.
 *
 * So the installer, running as the user and NOT elevated, writes
 * `<home>/run/stop-request`, and this daemon, which polls for it, runs its
 * common stop (`requestDaemonShutdown`, `daemon-shutdown.ts`). Nothing secret
 * travels: the file's content is never read. Whoever can write that folder is
 * the account itself (or an administrator), which can already end the
 * daemon by force: the file gives it nothing it did not have.
 *
 * A request older than this process is left over from a stop that came too
 * late (no daemon ran, or an older version that ignored it): it is removed and
 * ignored, or the daemon the installer starts again would stop at once.
 *
 * Imports node built-ins only: it runs in the daemon, never in a runner.
 */
import { lstatSync, unlinkSync, type Stats } from 'node:fs';
import { join } from 'node:path';

/** Name of the request under `<home>/run/`. `desktop/build/installer.nsh` writes the same name (`packaging.test.ts`). */
export const STOP_REQUEST_FILE = 'stop-request';

/** How often the daemon looks for it. The installer's wait covers it plus the shutdown grace (`packaging.test.ts`). */
export const STOP_REQUEST_POLL_MS = 1_000;

export function stopRequestPath(home: string): string {
  return join(home, 'run', STOP_REQUEST_FILE);
}

/**
 * Only the daemon of the Windows service obeys it: POSIX supervisors send
 * SIGTERM, and the desktop's embedded daemon is stopped by its own window,
 * which would otherwise see its child vanish under it.
 */
export function stopRequestWatched(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): boolean {
  return platform === 'win32' && env.TIMON_DESKTOP_SERVICE === '1' && env.TIMON_DESKTOP_EMBEDDED !== '1';
}

export type StopRequestState =
  /** No request, or something there that is not a plain file. */
  | 'none'
  /** Written before this process started. */
  | 'stale'
  /** Written since: a stop to run. */
  | 'fresh';

/**
 * `lstat`, never `stat`: a link or a folder planted under that name is not a
 * request, and nothing follows it.
 */
export function readStopRequest(file: string, startedAt: number, stat: (path: string) => Stats = lstatSync): StopRequestState {
  let info: Stats;
  try {
    info = stat(file);
  } catch {
    return 'none';
  }
  if (!info.isFile()) return 'none';
  return info.mtimeMs >= startedAt ? 'fresh' : 'stale';
}

export type StopRequestWatch = {
  file: string;
  /** When this process started, in epoch milliseconds: a request written during the boot counts. */
  startedAt: number;
  /** Runs the daemon's common stop. */
  request: (why: string) => unknown;
  log?: (line: string) => void;
  pollMs?: number;
  stat?: (path: string) => Stats;
  remove?: (path: string) => void;
  every?: (tick: () => void, ms: number) => () => void;
};

function interval(tick: () => void, ms: number): () => void {
  const timer = setInterval(tick, ms);
  // Never what keeps a stopping daemon alive.
  timer.unref();
  return () => clearInterval(timer);
}

/**
 * Looks for the request now (a stale one is cleared at once), then every
 * `pollMs`, until one is honoured or the returned function is called.
 */
export function watchStopRequest(opts: StopRequestWatch): () => void {
  const stat = opts.stat ?? lstatSync;
  const remove = opts.remove ?? unlinkSync;
  const log = opts.log ?? ((line: string) => console.log(line));
  let done = false;
  let cancel: () => void = () => {};
  // A stale request that cannot be removed (held by an antivirus, say) is not
  // tried again every second: the same one stays ignored by its date.
  let ignoredMtime: number | null = null;

  const tick = (): void => {
    if (done) return;
    const state = readStopRequest(opts.file, opts.startedAt, stat);
    if (state === 'none') return;
    if (state === 'stale') {
      let mtime: number | null = null;
      try { mtime = stat(opts.file).mtimeMs; } catch { return; }
      if (mtime === ignoredMtime) return;
      ignoredMtime = mtime;
      try { remove(opts.file); } catch { /* Ignored by its date anyway. */ }
      return;
    }
    done = true;
    cancel();
    // Removed first, so that it does not outlive this stop; if it cannot be,
    // the next daemon finds it older than itself and ignores it.
    try { remove(opts.file); } catch { /* See above. */ }
    log('[timon] stop request file found in the run folder');
    opts.request('stop request file');
  };

  tick();
  if (!done) cancel = (opts.every ?? interval)(tick, opts.pollMs ?? STOP_REQUEST_POLL_MS);
  return () => {
    done = true;
    cancel();
  };
}
