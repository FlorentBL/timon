/**
 * What the browser host's unit runs on a Linux server (`renderBrowserHostUnit`): the package's
 * own Node, which starts `timon-desktop --browser-host`, passes its errors on to the journal and
 * exits as it did.
 *
 * Why a process in between. When Chromium has no sandbox it may use (Ubuntu 23.10 and later
 * refuse user namespaces to programs AppArmor does not name, and the package's `chrome-sandbox`
 * is not setuid root), it aborts while it starts, killed by SIGTRAP, before Electron runs one
 * line of the host's script (measured: nothing of the script ever prints). The host cannot say
 * why, and systemd would start it again forever. This launcher reads what Chromium printed:
 * on its sandbox refusal, it says the cause and the repair, and exits 78, which the unit never
 * restarts. Every other exit goes through unchanged.
 *
 * The unit stops it with `KillMode=mixed`: the SIGTERM reaches this process, which hands it to
 * the host once, and the host closes its browser and its own children.
 *
 * Node built-ins only: it runs from the package, before anything of the daemon.
 */
import { spawn } from 'node:child_process';
import { constants } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Copy of `BROWSER_HOST_EXIT.unsupported` (`desktop/src/browser-host.ts`): the unit's `RestartPreventExitStatus`. */
export const BROWSER_HOST_REFUSED_EXIT = 78;

/**
 * Chromium's fatal lines when it may use no sandbox: no namespace and no helper
 * (`zygote_host_impl_linux.cc`), or a helper that is not setuid root (`setuid_sandbox_host.cc`,
 * the one a package whose helper lost its bit prints).
 */
export const SANDBOX_FAILURES: readonly string[] = [
  'No usable sandbox!',
  'The SUID sandbox helper binary was found, but is not configured correctly',
];

/** Enough of the last output to find a line cut between two reads. */
const WINDOW = 4096;

export function sandboxRefused(output: string): boolean {
  return SANDBOX_FAILURES.some((line) => output.includes(line));
}

/** What the journal shows when the host cannot start for its sandbox: the cause, then the repair. */
export function sandboxRefusalMessage(executable: string, unit: string | null): string {
  const helper = join(dirname(executable), 'chrome-sandbox');
  return '[browser-host] the built-in browser cannot start: Chromium has no usable sandbox on this system.'
    + ' Ubuntu 23.10 and later refuse user namespaces to programs without an AppArmor profile'
    + ` (kernel.apparmor_restrict_unprivileged_userns=1), and ${helper} is not setuid root.`
    + ' Repair, as an administrator: reinstall the Timon package, whose setup installs the AppArmor profile, or run'
    + ` sudo chown root:root '${helper}' && sudo chmod 4755 '${helper}'.`
    + ` Then: systemctl --user restart ${unit ?? 'the browser host unit'}`;
}

/** How the launcher ends: an exit code, or the stop signal the host died of, raised again. */
export type LauncherOutcome = { code: number } | { signal: NodeJS.Signals };

/** Signals a stop asks for: systemd counts a main process they end as stopped cleanly. */
const STOP_SIGNALS: readonly NodeJS.Signals[] = ['SIGTERM', 'SIGINT', 'SIGHUP'];

/**
 * The launcher's decision once the host ended: its own code, 78 when Chromium refused its
 * sandbox, a stop signal raised again, and a crash as a failure the unit restarts.
 */
export function launcherOutcome(code: number | null, signal: NodeJS.Signals | null, refused: boolean): LauncherOutcome {
  if (code === 0) return { code: 0 };
  if (refused) return { code: BROWSER_HOST_REFUSED_EXIT };
  if (code !== null) return { code };
  if (signal && STOP_SIGNALS.includes(signal)) return { signal };
  return { code: 128 + (signal ? constants.signals[signal] ?? 0 : 0) };
}

export interface LauncherRun {
  executable: string;
  unit: string | null;
  env: NodeJS.ProcessEnv;
  /** Where the host's errors go on to (this process's stderr: the journal). */
  writeError: (chunk: Buffer | string) => void;
  /** Called with a sender once the host runs: the stop signals this process receives go through it. */
  forwardSignals?: (send: (signal: NodeJS.Signals) => void) => void;
}

/** Starts the host, waits for it, and says how the launcher must end. */
export function runBrowserHostLauncher(run: LauncherRun): Promise<LauncherOutcome> {
  const env = { ...run.env };
  // The package's Electron runs as the application: Node mode is off in a package, and an
  // inherited value must not decide it anyway.
  delete env.ELECTRON_RUN_AS_NODE;
  return new Promise((done) => {
    let tail = '';
    let refused = false;
    const child = spawn(run.executable, ['--browser-host'], { env, stdio: ['ignore', 'inherit', 'pipe'] });
    child.stderr?.on('data', (chunk: Buffer) => {
      run.writeError(chunk);
      if (refused) return;
      tail = (tail + chunk.toString('utf8')).slice(-WINDOW);
      refused = sandboxRefused(tail);
    });
    let stopAsked = false;
    run.forwardSignals?.((signal) => {
      // One stop reaches the host once: a second SIGTERM would cut its profiles' flush short.
      if (stopAsked || child.exitCode !== null || child.signalCode !== null) return;
      stopAsked = true;
      child.kill(signal);
    });
    child.once('error', (error) => {
      run.writeError(`[browser-host] ${run.executable} could not be started: ${error.message}\n`);
      done({ code: 1 });
    });
    child.once('close', (code, signal) => {
      const outcome = launcherOutcome(code, signal, refused);
      if ('code' in outcome && outcome.code === BROWSER_HOST_REFUSED_EXIT && refused) {
        run.writeError(`${sandboxRefusalMessage(run.executable, run.unit)}\n`);
      }
      done(outcome);
    });
  });
}

async function main(argv: string[]): Promise<void> {
  const [executable, unit] = argv;
  if (!executable) throw new Error('usage: browser-host-launcher <timon-desktop> [unit]');
  const outcome = await runBrowserHostLauncher({
    executable, unit: unit ?? null, env: process.env,
    writeError: (chunk) => { process.stderr.write(chunk); },
    forwardSignals: (send) => {
      for (const signal of STOP_SIGNALS) process.on(signal, () => send(signal));
    },
  });
  if ('signal' in outcome) {
    // Ended by the same signal as the host: systemd sees a clean stop, as it did with no launcher.
    for (const signal of STOP_SIGNALS) process.removeAllListeners(signal);
    process.kill(process.pid, outcome.signal);
    return;
  }
  process.exitCode = outcome.code;
}

/** Run as a script, never when imported (the tests). */
function isEntry(): boolean {
  const entry = process.argv[1];
  return !!entry && resolve(entry) === fileURLToPath(import.meta.url);
}

if (isEntry()) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`[browser-host] ${(error as Error).message}\n`);
    process.exitCode = 1;
  });
}
