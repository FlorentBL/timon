/**
 * `timon doctor`'s fence coverage: each active profile's policy, checked by the
 * kernel, with nothing left behind in the Timon home.
 */
import './test-home.js';
import '../tests/helpers/paid-license.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const { mountOfficialProviders, stubCodexSignIn } = await import('../tests/helpers/official-providers.js');
await mountOfficialProviders();
// Codex's launch is built only once its credentials are readable: a placeholder, not the operator's own.
await stubCodexSignIn();
const { config } = await import('./config/load.js');
const { TIMON_HOME } = await import('./paths.js');
const { fenceAccess } = await import('./host/isolation.js');
const { fenceCoverage } = await import('./fence-coverage.js');
const { failedCheck, formatFenceCoverage } = await import('./fence-coverage-report.js');
type HostFence = import('./host/types.js').HostFence;
type Witness = typeof import('./host/fence-witness.js').witnessFenceAccess;

writeFileSync(join(TIMON_HOME, 'daemon-token'), 'secret');
const AUTO = { ...config(), host: { ...config().host, isolation: { ...config().host.isolation, filesystem: 'auto' as const } } };
const FENCE: HostFence = {
  mechanism: 'landlock',
  probe: () => ({ available: true, abi: 6 }),
  wrap: (_policy, cmd, args) => ({ cmd, args: [...args] }),
  witness: async () => ({ ran: true, status: 0, stderr: '' }),
};
/** Every file below the Timon home, folders aside: what a check may not leave behind. */
function filesOfHome(dir = TIMON_HOME): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? filesOfHome(path) : [relative(TIMON_HOME, path)];
  });
}
/** A kernel that does what the policy says, and records what it was asked. */
function faithfulKernel(asked: string[][] = []): Witness {
  return async (_fence, policy, checks) => {
    asked.push(checks.map((c) => c.path));
    return checks.map(({ path, access }) => {
      const granted = fenceAccess(policy, path);
      return { state: (access === 'read' ? granted.read : granted.write) ? 'allowed' : 'refused' };
    });
  };
}

test('each profile is checked on its own folders and on the private files, and the check leaves nothing behind', async () => {
  const before = readdirSync(join(TIMON_HOME));
  const asked: string[][] = [];
  const report = await fenceCoverage({ cfg: AUTO, fence: FENCE, profiles: ['codex'], witness: faithfulKernel(asked) });
  assert.equal(report.state, 'checked');
  assert.equal(report.mechanism, 'landlock');
  const codex = report.profiles[0]!;
  assert.equal(codex.profile, 'codex');
  assert.equal(codex.ok, true, JSON.stringify(codex.checks.filter(failedCheck)));
  const whys = codex.checks.map((c) => c.why);
  assert.ok(whys.includes('the mission\'s TMPDIR'));
  assert.ok(whys.some((why) => why.startsWith('the CLI\'s per-mission home')), 'the provider scratch the fence grants');
  const token = codex.checks.find((c) => c.display.endsWith('daemon-token'));
  assert.deepEqual([token?.expect, token?.policy, token?.kernel], ['refused', 'refused', 'refused']);
  // The folders made for the check are gone, the probes with them.
  for (const path of asked.flat()) {
    if (path.includes(`${join('tmp', 'missions')}`) || path.includes('.timon-doctor-')) assert.equal(existsSync(path), false, path);
  }
  assert.deepEqual(readdirSync(join(TIMON_HOME)).filter((name) => !before.includes(name) && name !== 'tmp' && name !== 'provider-runs' && name !== 'run'), []);
});

test('a path the kernel refuses while the policy grants it fails the profile, and says which', async () => {
  const kernel: Witness = async (fence, policy, checks, file) => {
    const answers = await faithfulKernel()(fence, policy, checks, file);
    return answers.map((answer, i) => (checks[i]?.access === 'write' ? { state: 'refused' } : answer));
  };
  const report = await fenceCoverage({ cfg: AUTO, fence: FENCE, profiles: ['codex'], witness: kernel });
  const codex = report.profiles[0]!;
  assert.equal(codex.ok, false);
  const text = formatFenceCoverage(report);
  assert.match(text, /codex\s+✗/);
  assert.match(text, /write refused by the kernel, the mission needs it/);
});

test('the real launch of each profile is built, its paths checked, and what it wrote is gone', async () => {
  const before = readdirSync(TIMON_HOME);
  const filesBefore = filesOfHome();
  const runs = join(TIMON_HOME, 'provider-runs');
  const runsBefore = existsSync(runs) ? readdirSync(runs).flatMap((plugin) => readdirSync(join(runs, plugin)).map((id) => join(plugin, id))) : [];
  const report = await fenceCoverage({ cfg: AUTO, fence: FENCE, profiles: ['claude', 'codex'], witness: faithfulKernel() });
  for (const profile of report.profiles) {
    assert.equal(profile.ok, true, `${profile.profile}: ${profile.error ?? JSON.stringify(profile.checks.filter(failedCheck))}`);
    assert.equal(profile.launch?.built, true, `${profile.profile}: ${JSON.stringify(profile.launch)}`);
    if (profile.launch?.built) assert.ok(profile.launch.paths > 0, `${profile.profile} names no path of the home`);
  }
  // The prompt file claude reads is one of the paths its launch named, checked by the kernel.
  const claude = report.profiles.find((p) => p.profile === 'claude')!;
  assert.ok(claude.checks.some((c) => c.display.endsWith('system-prompt.md') && c.kernel === 'allowed'), JSON.stringify(claude.checks.map((c) => c.display)));
  assert.match(formatFenceCoverage(report), /claude\s+✓ \d+ path\(s\), \d+ named by its launch/);
  const runsAfter = existsSync(runs) ? readdirSync(runs).flatMap((plugin) => readdirSync(join(runs, plugin)).map((id) => join(plugin, id))) : [];
  assert.deepEqual(runsAfter.filter((entry) => !runsBefore.includes(entry)), [], 'no mission folder of the check is left');
  const cache = join(TIMON_HOME, 'provider-cache');
  if (!before.includes('provider-cache')) assert.equal(existsSync(cache), false, 'provider-cache made for the check is removed');
  assert.deepEqual(readdirSync(TIMON_HOME).filter((name) => !before.includes(name) && name !== 'tmp' && name !== 'provider-runs' && name !== 'run'), []);
  assert.deepEqual(filesOfHome().filter((file) => !filesBefore.includes(file)), [], 'no file written by a build is left');
});

test('a launch that names a path the fence refuses fails the profile, without asking the kernel about a missing file', async () => {
  const outside = join(TIMON_HOME, 'agents', 'someone', 'config.json');
  const asked: string[][] = [];
  const report = await fenceCoverage({
    cfg: AUTO, fence: FENCE, profiles: ['codex'], witness: faithfulKernel(asked),
    launch: async (_profile, _missionId, cwd) => ({ cmd: 'codex', args: ['--config', outside], cwd, initialStdin: null }),
  });
  const codex = report.profiles[0]!;
  assert.equal(codex.ok, false);
  const check = codex.checks.find((c) => c.display.endsWith(join('someone', 'config.json')));
  assert.deepEqual([check?.expect, check?.policy, check?.kernel], ['allowed', 'refused', 'skipped']);
  assert.equal(asked.flat().includes(outside), false, 'a file that does not exist is answered by the policy alone');
  assert.match(formatFenceCoverage(report), /codex\s+✗ \d+ path\(s\), 2 named by its launch/);
});

test('a launch that cannot be built still checks the granted folders, and says so', async () => {
  const report = await fenceCoverage({
    cfg: AUTO, fence: FENCE, profiles: ['codex'], witness: faithfulKernel(),
    launch: async () => { throw new Error('not signed in'); },
  });
  const codex = report.profiles[0]!;
  assert.equal(codex.ok, true);
  assert.deepEqual(codex.launch, { built: false, error: 'not signed in' });
  assert.ok(codex.checks.length > 0);
  assert.match(formatFenceCoverage(report), /launch not built \(not signed in\): only the folders the fence grants were checked/);
});

test('without a fence, the section says missions are not fenced and checks nothing', async () => {
  const unfenced = await fenceCoverage({ cfg: AUTO, fence: { ...FENCE, probe: () => ({ available: false, reason: 'kernel without Landlock', abi: 0 }) } });
  assert.equal(unfenced.state, 'unfenced');
  assert.match(formatFenceCoverage(unfenced), /not fenced here \(kernel without Landlock\)/);
  const off = await fenceCoverage({ cfg: { ...AUTO, host: { ...AUTO.host, isolation: { ...AUTO.host.isolation, filesystem: 'off' } } }, fence: FENCE });
  assert.equal(off.reason, 'turned off by host.isolation.filesystem');
  assert.match(formatFenceCoverage(null, 'the daemon does not answer'), /not checked — the daemon does not answer/);
});

test('an anonymous request for the fence coverage is refused', async () => {
  const express = (await import('express')).default;
  const { registerRoutes } = await import('./plugins-bundled/http/routes.js');
  const app = express();
  registerRoutes(app as never);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no address');
  try {
    const res = await fetch(`http://127.0.0.1:${address.port}/api/doctor/fence-coverage`);
    assert.equal(res.status, 401);
  } finally {
    server.close();
  }
});

const realSeatbelt = process.platform !== 'darwin' ? 'Seatbelt is macOS only' : !existsSync('/usr/bin/sandbox-exec') ? 'no sandbox-exec' : false; // portability: macOS system binary, darwin only

test('under the real Seatbelt fence, each profile\'s real launch is covered and the private files stay shut', { skip: realSeatbelt }, async () => {
  const report = await fenceCoverage({ cfg: AUTO, profiles: ['claude', 'codex'] });
  assert.equal(report.state, 'checked', report.reason);
  assert.equal(report.mechanism, 'seatbelt');
  for (const profile of report.profiles) {
    assert.equal(profile.ok, true, `${profile.profile}: ${profile.error ?? JSON.stringify(profile.checks.filter(failedCheck))}`);
    assert.equal(profile.launch?.built, true, `${profile.profile}: ${JSON.stringify(profile.launch)}`);
    const token = profile.checks.find((c) => c.display.endsWith('daemon-token'));
    assert.deepEqual([token?.policy, token?.kernel], ['refused', 'refused']);
  }
});
