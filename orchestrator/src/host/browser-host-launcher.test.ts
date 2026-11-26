/**
 * The browser host's launcher (`browser-host-launcher.ts`, TODO #1233). Stand-in hosts are shell
 * scripts that print what Chromium prints and end as it ends; no Electron runs here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BROWSER_HOST_REFUSED_EXIT, launcherOutcome, runBrowserHostLauncher, sandboxRefusalMessage, sandboxRefused, type LauncherRun,
} from './browser-host-launcher.js';

const POSIX = process.platform === 'win32' && 'the browser host runs on Linux only';

/** Chromium 130 on a system without user namespaces, its helper not setuid (measured with Electron, userns disabled). */
const SUID_FATAL = '[1071444:1126/213119.025922:FATAL:setuid_sandbox_host.cc(163)] The SUID sandbox helper binary was found,'
  + ' but is not configured correctly. Rather than run without sandboxing I\'m aborting now. You need to make sure that'
  + ' /opt/Timon/chrome-sandbox is owned by root and has mode 4755.';

function host(dir: string, body: string): string {
  const file = join(dir, 'timon-desktop');
  writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return file;
}

async function launch(executable: string, extra: Partial<LauncherRun> = {}) {
  let errors = '';
  const outcome = await runBrowserHostLauncher({
    executable, unit: 'timon-browser-0123456789abcdef01234567.service', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    writeError: (chunk) => { errors += chunk.toString(); }, ...extra,
  });
  return { outcome, errors };
}

test('Chromium refusing its sandbox ends the launcher in 78, with the cause and the repair', { skip: POSIX }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'timon-host-launcher-'));
  try {
    const { outcome, errors } = await launch(host(dir, `echo '${SUID_FATAL.replaceAll("'", "'\\''")}' >&2\nkill -TRAP $$`));
    assert.deepEqual(outcome, { code: BROWSER_HOST_REFUSED_EXIT });
    assert.ok(errors.includes(SUID_FATAL), 'Chromium\'s own line still reaches the journal');
    assert.match(errors, /no usable sandbox/);
    assert.match(errors, /apparmor_restrict_unprivileged_userns/);
    assert.ok(errors.includes(`sudo chmod 4755 '${join(dir, 'chrome-sandbox')}'`));
    assert.match(errors, /systemctl --user restart timon-browser-0123456789abcdef01234567\.service/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the refusal is found when Chromium\'s line arrives in pieces', { skip: POSIX }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'timon-host-launcher-'));
  try {
    const { outcome } = await launch(host(dir, "printf 'FATAL: No usab' >&2\nsleep 0.2\nprintf 'le sandbox! See the docs\\n' >&2\nexit 1"));
    assert.deepEqual(outcome, { code: BROWSER_HOST_REFUSED_EXIT });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('every other end of the host goes through unchanged', { skip: POSIX }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'timon-host-launcher-'));
  try {
    for (const code of [0, 1, 75, 78]) {
      const { outcome, errors } = await launch(host(dir, `echo 'some error' >&2\nexit ${code}`));
      assert.deepEqual(outcome, { code }, `exit ${code}`);
      assert.equal(errors, 'some error\n');
    }
    // A crash that is not the sandbox: a failure the unit restarts.
    assert.deepEqual((await launch(host(dir, 'kill -TRAP $$'))).outcome, { code: 133 });
    // The host runs as the application, whatever the launcher inherited, with its own flag.
    const seen = join(dir, 'seen');
    await launch(host(dir, `echo "\${ELECTRON_RUN_AS_NODE:-unset} $*" > '${seen}'`));
    assert.equal(readFileSync(seen, 'utf8'), 'unset --browser-host\n');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a stop reaches the host once, and the launcher ends as the host did', { skip: POSIX }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'timon-host-launcher-'));
  try {
    const got = join(dir, 'got');
    // The host takes its time to close, as it flushes its profiles, then exits 0.
    const executable = host(dir, `trap 'echo TERM >> "${got}"; sleep 0.3; exit 0' TERM\necho ready >&2\nwhile :; do sleep 0.05; done`);
    let send: ((signal: NodeJS.Signals) => void) | null = null;
    const running = launch(executable, {
      forwardSignals: (sender) => { send = sender; },
      writeError: (chunk) => {
        if (chunk.toString().includes('ready')) { send?.('SIGTERM'); send?.('SIGTERM'); }
      },
    });
    assert.deepEqual((await running).outcome, { code: 0 });
    assert.equal(readFileSync(got, 'utf8'), 'TERM\n', 'one SIGTERM, not two');
    // A host the stop signal ended: the same signal again, which systemd counts as a clean stop.
    const killed = host(dir, 'echo ready >&2\nwhile :; do sleep 0.05; done');
    let stop: ((signal: NodeJS.Signals) => void) | null = null;
    const ended = await launch(killed, {
      forwardSignals: (sender) => { stop = sender; },
      writeError: (chunk) => { if (chunk.toString().includes('ready')) stop?.('SIGTERM'); },
    });
    assert.deepEqual(ended.outcome, { signal: 'SIGTERM' });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('an executable that cannot start is a failure the unit restarts', { skip: POSIX }, async () => {
  const { outcome, errors } = await launch(join(tmpdir(), 'timon-no-such-desktop'));
  assert.deepEqual(outcome, { code: 1 });
  assert.match(errors, /could not be started/);
});

test('the decision table', () => {
  assert.deepEqual(launcherOutcome(0, null, true), { code: 0 }, 'a host that served and stopped is no refusal');
  assert.deepEqual(launcherOutcome(1, null, true), { code: 78 });
  assert.deepEqual(launcherOutcome(null, 'SIGTRAP', true), { code: 78 });
  assert.deepEqual(launcherOutcome(null, 'SIGINT', false), { signal: 'SIGINT' });
  assert.deepEqual(launcherOutcome(null, 'SIGKILL', false), { code: 137 });
  assert.ok(sandboxRefused('[x:FATAL:zygote_host_impl_linux.cc(128)] No usable sandbox! If you are running on Ubuntu 23.10+'));
  assert.ok(!sandboxRefused('[x:ERROR:gl_display.cc(497)] EGL Driver message'));
  assert.match(sandboxRefusalMessage('/opt/Timon/timon-desktop', null), /\/opt\/Timon\/chrome-sandbox/);
});

test('the refusal code is the host\'s own and the one the unit never restarts', async () => {
  // Copied, not imported: the desktop package builds apart.
  const desktop = readFileSync(new URL('../../../desktop/src/browser-host.ts', import.meta.url), 'utf8');
  assert.match(desktop, new RegExp(`^\\s+unsupported: ${BROWSER_HOST_REFUSED_EXIT},$`, 'm'));
  const { renderBrowserHostUnit } = await import('./packaged-service.js');
  assert.match(renderBrowserHostUnit('/home/u/.timon', '/opt/Timon/timon-desktop'), new RegExp(`^RestartPreventExitStatus=${BROWSER_HOST_REFUSED_EXIT}$`, 'm'));
});
