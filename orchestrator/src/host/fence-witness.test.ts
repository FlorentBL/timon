/**
 * The kernel's answer on a path, under the fence: the launcher opens it, the
 * shell says what it could do, one marked line per path.
 */
import '../test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { config } from '../config/load.js';
import { findFenceBinary, probeFence } from './fence.js';
import { witnessFenceAccess } from './fence-witness.js';
import { resolveFence, type FencePolicy } from './isolation.js';
import { createLandlockFence } from './landlock.js';
import { createSeatbeltFence } from './darwin.js';
import { SANDBOX_EXEC } from './seatbelt.js';
import type { HostFence } from './types.js';

const OFF: FencePolicy = { mode: 'off', enabled: false, ro: [], rw: [], exec: [], deny: [], denyUnderTimonHome: [], unixSockets: 'allow', ignored: [] };

function stubFence(seen: { cmd?: string; args?: string[] } = {}): HostFence {
  return {
    mechanism: 'landlock',
    probe: () => ({ available: true, abi: 6 }),
    wrap: (_policy, cmd, args, policyFile) => {
      seen.cmd = cmd;
      seen.args = [...args];
      return { cmd: '/opt/timon/timon-fence', args: ['--policy', policyFile, '--', cmd, ...args] };
    },
    witness: async () => ({ ran: true, status: 0, stderr: '' }),
  };
}

test('one launch opens every path, and each answer is read from its marked line', async () => {
  const seen: { cmd?: string; args?: string[] } = {};
  const answers = await witnessFenceAccess(stubFence(seen), OFF, [
    { path: '/a', access: 'read' }, { path: '/b/file', access: 'write' }, { path: '/c', access: 'read' },
  ], '/run/p.policy', {
    exists: () => true,
    run: async () => ({ ran: true, status: 0, stderr: 'timon-witness 1 allowed\ntimon-witness 2 refused\n' }),
  });
  assert.equal(seen.cmd, '/bin/sh');
  assert.deepEqual(seen.args?.slice(-3), ['r:/a', 'w:/b/file', 'r:/c'], 'opened, never tested with access(2)');
  assert.deepEqual(answers.slice(0, 2), [{ state: 'allowed' }, { state: 'refused' }]);
  assert.equal(answers[2]?.state, 'error', 'a path the shell never answered is not taken for an answer');
});

test('a launcher that cannot apply the policy says so for every path', async () => {
  const fence = { ...stubFence(), wrap: () => { throw new Error('too many rules'); } };
  const answers = await witnessFenceAccess(fence, OFF, [{ path: '/a', access: 'read' }], '/run/p.policy', { exists: () => true });
  assert.deepEqual(answers, [{ state: 'error', reason: 'the policy cannot be applied (too many rules)' }]);
  const failed = await witnessFenceAccess(stubFence(), OFF, [{ path: '/a', access: 'read' }], '/run/p.policy', {
    exists: () => true,
    run: async () => ({ ran: true, status: 71, stderr: 'timon-fence: landlock_restrict_self: Operation not permitted\n' }),
  });
  assert.deepEqual(failed, [{ state: 'error', reason: 'timon-fence: landlock_restrict_self: Operation not permitted (exit 71)' }]);
});

/** The launcher of this checkout, or one built for the test when a C compiler is around. */
function realLauncher(): string | null {
  if (process.platform !== 'linux') return null;
  const found = findFenceBinary();
  if (found) return found;
  const dir = mkdtempSync(join(tmpdir(), 'fence-witness-bin-'));
  process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
  const out = join(dir, 'timon-fence');
  const build = fileURLToPath(new URL('../../../native/timon-fence/build.mjs', import.meta.url));
  try {
    execFileSync(process.execPath, [build, '--out', out, '--optional'], { stdio: 'ignore', timeout: 120_000 });
  } catch { return null; }
  return existsSync(out) ? out : null;
}

const REAL = realLauncher();
const PROBE = REAL ? probeFence(REAL) : null;
const realSkip = !REAL ? 'no timon-fence for this machine' : !PROBE?.available ? `no fence on this kernel: ${PROBE?.reason}` : false;

test('under the real Landlock fence, a granted folder opens and a private file of the Timon home does not', { skip: realSkip }, async () => {
  // Outside the system's temporary folder, which the fence leaves writable to every mission.
  const runtime = process.env.XDG_RUNTIME_DIR;
  const root = realpathSync(mkdtempSync(join(runtime && existsSync(runtime) ? runtime : tmpdir(), 'fence-witness-')));
  try {
    const home = join(root, 'home');
    const th = join(home, '.timon');
    const mission = 'dddddddd-0000-4000-8000-000000000004';
    const tmp = join(th, 'tmp', 'missions', mission);
    mkdirSync(tmp, { recursive: true });
    const probe = join(tmp, 'probe');
    writeFileSync(probe, '');
    const token = join(th, 'daemon-token');
    writeFileSync(token, 'secret');
    const cfg = config();
    const policy = resolveFence({ ...cfg, host: { ...cfg.host, isolation: { ...cfg.host.isolation, filesystem: 'auto' } } }, {
      timonHome: th, home, missionId: mission, platform: 'linux',
    });
    const fence = createLandlockFence({ status: () => ({ state: 'ready', binary: REAL as string, abi: PROBE?.abi ?? 0, seccomp: true }) });
    fence.probe();
    const answers = await witnessFenceAccess(fence, policy, [
      { path: tmp, access: 'read' }, { path: probe, access: 'write' }, { path: token, access: 'read' }, { path: token, access: 'write' },
    ], join(th, 'run', 'fence', 'witness.policy'));
    assert.deepEqual(answers.map((a) => a.state), ['allowed', 'allowed', 'refused', 'refused']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const seatbeltSkip = process.platform !== 'darwin' ? 'Seatbelt is macOS only' : !existsSync(SANDBOX_EXEC) ? `no ${SANDBOX_EXEC}` : false;

test('under the real Seatbelt fence, a granted folder opens and a private file of the Timon home does not', { skip: seatbeltSkip }, async () => {
  // Outside the system's temporary folder, which the fence leaves writable to every mission.
  const root = realpathSync(mkdtempSync(join(homedir(), '.fence-witness-')));
  try {
    const home = join(root, 'home');
    const th = join(home, '.timon');
    const mission = 'dddddddd-0000-4000-8000-000000000005';
    const tmp = join(th, 'tmp', 'missions', mission);
    mkdirSync(tmp, { recursive: true });
    const probe = join(tmp, 'probe');
    writeFileSync(probe, '');
    const token = join(th, 'daemon-token');
    writeFileSync(token, 'secret');
    const cfg = config();
    const policy = resolveFence({ ...cfg, host: { ...cfg.host, isolation: { ...cfg.host.isolation, filesystem: 'auto' } } }, {
      timonHome: th, home, missionId: mission, platform: 'darwin',
    });
    const fence = createSeatbeltFence({ warn: () => {} });
    const probed = fence.probe();
    assert.equal(probed.available, true, probed.reason);
    const policyFile = join(th, 'run', 'fence', 'witness.sb');
    mkdirSync(join(th, 'run', 'fence'), { recursive: true });
    const answers = await witnessFenceAccess(fence, policy, [
      { path: tmp, access: 'read' }, { path: probe, access: 'write' }, { path: token, access: 'read' }, { path: token, access: 'write' },
    ], policyFile);
    assert.deepEqual(answers, [{ state: 'allowed' }, { state: 'allowed' }, { state: 'refused' }, { state: 'refused' }]);
    // The launch's own profile compiles on this macOS: the witness that cuts the fence finds nothing to say.
    const witnessed = await fence.witness(policyFile);
    assert.deepEqual([witnessed.ran, witnessed.ran ? witnessed.status : null], [true, 0]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
