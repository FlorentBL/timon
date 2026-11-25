/**
 * `timon doctor`'s fence coverage: for each active profile, the policy a
 * mission of that profile would get, and whether the kernel honours it on this
 * machine.
 *
 * WHY. A hole in the fence's allow-list shows as a mission dying in 112 ms on
 * `Operation not permitted`, on one machine and not another (a kernel ABI, a
 * Seatbelt rendering, a Timon home behind a link). The static matrix
 * (`fence-provider-coverage.test.ts`) proves the policy right for the official
 * providers; it cannot prove what this kernel does with it. Here the launcher
 * opens each path under the real policy, the way a mission would.
 *
 * Each profile gets a mission id of its own, and the folders the fence grants a
 * mission from that id are made for the check, as a launch makes them, then
 * removed: a grant on a folder that does not exist is dropped, which would
 * prove nothing.
 *
 * The profile's real `buildSpawn` then builds the launch a mission would get,
 * under a seal that issues no token, and every path of the Timon home the
 * launch names (`launchFenceNeeds`, the pre-flight's own reading) is checked
 * too: a provider and the fence that disagree on a folder show here, on this
 * machine, not only in the test matrix. Whatever the build wrote lives in the
 * check's own mission folders, removed with them (`disposeProviderScratch`), and
 * in the plugin's shared folders (`provider-cache/<plugin>`): those it made are
 * removed when they are still empty, and left alone otherwise, since a mission
 * may have started using them meanwhile. Nothing else is created but a probe
 * file in each folder a mission writes, removed with it. No CLI runs.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, rmdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { config } from './config/load.js';
import type { TimonConfig } from './config/schema.js';
import { activeProfiles, backendOwnerPlugin, backendTrust } from './backends/registry.js';
import { getBackend } from './backends/index.js';
import { closeLaunchSeal, openLaunchSeal } from './backends/launch-seal.js';
import { disposeProviderScratch } from './backends/provider-scratch.js';
import type { BuildSpawnOpts, SpawnResult } from './backends/types.js';
import { splitBackendInstance } from './backends/instance-id.js';
import { credentialAccountOf } from './backends/host-sign-in.js';
import { getHost } from './host/index.js';
import { fenceAccess, missionTmpDir, resolveFence, type FencePolicy, type FenceTarget } from './host/isolation.js';
import { nodeRuntime } from './host/node-runtime.js';
import type { HostFence } from './host/types.js';
import { witnessFenceAccess, type FenceAccessWitness } from './host/fence-witness.js';
import { daemonRuntimePaths } from './mission-fence-target.js';
import { fencePolicyFile, hostFenceStatus } from './resources.js';
import { launchFenceNeeds, realPathOf } from './fence-refusal.js';
import { DAEMON_TOKEN_FILE, SECRET_KEY_FILE, TIMON_HOME } from './paths.js';
import { failedCheck, type FenceCoverageCheck, type FenceCoverageProfile, type FenceCoverageReport } from './fence-coverage-report.js';

type Planned = Omit<FenceCoverageCheck, 'policy' | 'kernel' | 'reason'> & { path: string; witness: boolean };

/** What a profile's launch is built from: a throwaway mission of no agent, in the check's own folder. */
export type FenceCoverageLaunch = (profile: string, missionId: string, cwd: string) => Promise<SpawnResult>;

/** The name the check's launch goes by: no agent is behind it, and the vault's journal says so. */
const DOCTOR_AGENT = '_doctor';

/**
 * The launch a mission of `profile` would get, built by the profile's own
 * `buildSpawn` and nothing else: no program is checked or started
 * (`buildSealedSpawn` would run it to read its identity). The seal makes the
 * provider's scratch work as at a launch; it issues no token, so a reference
 * written into a file reads empty.
 */
const buildProfileLaunch: FenceCoverageLaunch = async (profile, missionId, cwd) => {
  const backend = getBackend(profile);
  const spawnOpts: BuildSpawnOpts = {
    agentName: DOCTOR_AGENT,
    systemPrompt: 'Timon doctor: fence coverage. This launch is never run.',
    message: 'ping',
    resumeSession: null,
    missionId,
    cfg: { cwd, permission_mode: 'auto' },
  };
  const seal = backendTrust(profile) === 'core' ? null : openLaunchSeal(missionId, profile, spawnOpts, () => '');
  try {
    return await backend.buildSpawn(spawnOpts);
  } finally {
    if (seal) closeLaunchSeal(seal);
  }
};

/** `child` is `parent` or beneath it. */
function within(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function displayOf(path: string, home: string): string {
  return within(home, path) ? join('~', relative(home, path)) : path;
}

/** The private files of the Timon home a mission must never open: the ones that exist here. */
function privateFiles(timonHome: string): string[] {
  const candidates = timonHome === TIMON_HOME
    ? [DAEMON_TOKEN_FILE, SECRET_KEY_FILE, join(TIMON_HOME, 'timon.db')]
    : ['daemon-token', 'secret-key', 'timon.db'].map((name) => join(timonHome, name));
  return candidates.filter((path) => existsSync(path));
}

const isDir = (path: string): boolean => {
  try { return statSync(path).isDirectory(); } catch { return false; }
};

/** Every folder below `root` (itself included when it exists), links not followed. */
function foldersBelow(root: string, depth = 4): string[] {
  let stat;
  try { stat = lstatSync(root); } catch { return []; }
  if (!stat.isDirectory()) return [];
  if (depth === 0) return [root];
  return [root, ...readdirSync(root).flatMap((name) => foldersBelow(join(root, name), depth - 1))];
}

/** Removes the folders of `after` that `before` did not hold, deepest first, each only if it is empty. */
function removeNewEmptyFolders(before: readonly string[], after: readonly string[]): void {
  const known = new Set(before);
  for (const dir of after.filter((path) => !known.has(path)).sort((a, b) => b.length - a.length)) {
    try { rmdirSync(dir); } catch { /* not empty: someone uses it now */ }
  }
}

export type FenceCoverageDeps = {
  cfg?: TimonConfig;
  fence?: HostFence | undefined;
  timonHome?: string;
  home?: string;
  /** The profiles to check; the active process profiles by default. */
  profiles?: string[];
  witness?: typeof witnessFenceAccess;
  /** Builds a profile's launch; its real `buildSpawn` by default. */
  launch?: FenceCoverageLaunch;
};

/** The active profiles that start a process on this machine: a remote one has no fence. */
function processProfiles(): string[] {
  return activeProfiles().filter((entry) => 'buildSpawn' in entry.dialect).map((entry) => entry.profile.id);
}

export async function fenceCoverage(deps: FenceCoverageDeps = {}): Promise<FenceCoverageReport> {
  const cfg = deps.cfg ?? config();
  const fence = 'fence' in deps ? deps.fence : getHost().fence;
  const timonHome = deps.timonHome ?? TIMON_HOME;
  const home = deps.home ?? homedir();
  const mode = cfg.host.isolation.filesystem;
  const status = mode === 'off' ? null : hostFenceStatus(fence);
  if (!status || status.state !== 'ready' || !fence) {
    return {
      state: 'unfenced', mechanism: fence?.mechanism ?? null, witness: false,
      reason: !status ? 'turned off by host.isolation.filesystem' : status.state === 'ready' ? 'no mission fence on this OS' : status.reason,
      profiles: [], exceptions: [],
    };
  }
  const witness = deps.witness ?? witnessFenceAccess;
  const launch = deps.launch ?? buildProfileLaunch;
  const runtime = daemonRuntimePaths(nodeRuntime(cfg));
  const profiles: FenceCoverageProfile[] = [];
  let exceptions: FenceCoverageReport['exceptions'] = [];
  for (const profile of deps.profiles ?? processProfiles()) {
    const result = await profileCoverage(profile, { cfg, fence, timonHome, home, runtime, witness, launch });
    profiles.push(result.coverage);
    if (exceptions.length === 0) exceptions = result.exceptions;
  }
  return { state: 'checked', mechanism: fence.mechanism, witness: true, reason: null, profiles, exceptions };
}

async function profileCoverage(profile: string, ctx: {
  cfg: TimonConfig; fence: HostFence; timonHome: string; home: string; runtime: string[]; witness: typeof witnessFenceAccess;
  launch: FenceCoverageLaunch;
}): Promise<{ coverage: FenceCoverageProfile; exceptions: FenceCoverageReport['exceptions'] }> {
  const { timonHome, home } = ctx;
  const missionId = randomUUID();
  const made: string[] = [];
  const probes: string[] = [];
  const policyFile = fencePolicyFile(timonHome, `doctor-${missionId.slice(0, 8)}`);
  const plugin = backendOwnerPlugin(profile);
  const account = credentialAccountOf(profile) ?? undefined;
  const instance = splitBackendInstance(profile);
  const providerProfile = plugin && !account && !instance.accountId ? instance.backend : undefined;
  const sharedRoot = plugin ? join(timonHome, 'provider-cache', plugin) : null;
  /** The plugin's shared folders, and `provider-cache` itself on a home that never had one. */
  const sharedFolders = (): string[] => (sharedRoot ? [...foldersBelow(dirname(sharedRoot), 0), ...foldersBelow(sharedRoot)] : []);
  const sharedBefore = sharedFolders();
  const makeDir = (dir: string): void => {
    if (existsSync(dir)) return;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    made.push(dir);
  };
  /** A file to append to in a folder a mission writes: the write witness needs one. */
  const probeIn = (dir: string): string => {
    const probe = join(dir, `.timon-doctor-${missionId.slice(0, 8)}`);
    writeFileSync(probe, '', { mode: 0o600 });
    probes.push(probe);
    return probe;
  };
  try {
    const own = [
      { dir: missionTmpDir(timonHome, missionId), why: 'the mission\'s TMPDIR' },
      ...(plugin ? [{ dir: join(timonHome, 'provider-runs', plugin, missionId), why: `the CLI's per-mission home (${plugin})` }] : []),
    ];
    for (const { dir } of own) makeDir(dir);
    // Built before the policy, as a launch does: the folders the build makes are then there to grant.
    let spec: SpawnResult | null = null;
    let launchError: string | null = null;
    try {
      spec = await ctx.launch(profile, missionId, own[0]!.dir);
    } catch (err) {
      launchError = (err as Error).message;
    }
    const target: FenceTarget = {
      timonHome, home, missionId, backend: profile, runtime: ctx.runtime,
      ...(account ? { account } : {}), ...(plugin ? { providerPlugin: plugin } : {}), ...(providerProfile ? { providerProfile } : {}),
    };
    const policy: FencePolicy = resolveFence(
      { ...ctx.cfg, host: { ...ctx.cfg.host, isolation: { ...ctx.cfg.host.isolation, filesystem: 'auto' } } },
      target,
    );
    const planned: Planned[] = [];
    const plan = (path: string, access: 'read' | 'write', expect: 'allowed' | 'refused', why: string, witness = true): void => {
      if (planned.some((entry) => entry.path === path && entry.access === access)) return;
      planned.push({ path, display: displayOf(path, home), access, expect, why, witness });
    };
    for (const { dir, why } of own) {
      plan(dir, 'read', 'allowed', why);
      plan(probeIn(dir), 'write', 'allowed', why);
    }
    // Shared by the plugin's missions, or the profile's: checked where they exist.
    const shared = [
      ...(plugin ? [{ dir: join(timonHome, 'provider-cache', plugin), why: `the shared cache of ${plugin}` }] : []),
      ...(plugin && providerProfile ? [{ dir: join(timonHome, 'provider-cache', plugin, 'profiles', providerProfile), why: 'the profile\'s own folder' }] : []),
      ...(account ? [{ dir: join(timonHome, 'backend-accounts', account), why: 'the account\'s sign-in folder' }] : []),
    ];
    for (const { dir, why } of shared) {
      if (!isDir(dir)) continue;
      plan(dir, 'read', 'allowed', why);
      plan(probeIn(dir), 'write', 'allowed', why);
    }
    // The daemon's own release, from which the mission's Timon MCP servers run.
    for (const path of ctx.runtime) {
      if (within(timonHome, path) && existsSync(path)) plan(path, 'read', 'allowed', 'the daemon release the Timon MCP servers run from');
    }
    // What the real launch names: its arguments, its environment, its working folder.
    const needs = spec ? launchFenceNeeds({ ...spec, workspace: 'rw' }, timonHome) : [];
    for (const need of needs) {
      const real = realPathOf(need.path);
      // A path the launch names but did not make: the policy alone can answer for it.
      if (!existsSync(real)) {
        plan(need.path, need.access, 'allowed', need.why, false);
        continue;
      }
      plan(need.path, 'read', 'allowed', need.why);
      if (need.access === 'write') plan(isDir(real) ? probeIn(real) : need.path, 'write', 'allowed', need.why);
    }
    for (const path of privateFiles(timonHome)) plan(path, 'read', 'refused', 'a private file of Timon');
    const policyOf = (path: string, access: 'read' | 'write'): 'allowed' | 'refused' => {
      const granted = fenceAccess(policy, realPathOf(path));
      return (access === 'read' ? granted.read : granted.write) ? 'allowed' : 'refused';
    };
    mkdirSync(dirname(policyFile), { recursive: true, mode: 0o700 });
    const witnessed = planned.filter((entry) => entry.witness);
    const kernel: FenceAccessWitness[] = await ctx.witness(ctx.fence, policy, witnessed.map(({ path, access }) => ({ path, access })), policyFile);
    const checks: FenceCoverageCheck[] = planned.map(({ path: _path, witness: asked, ...check }) => {
      const index = asked ? witnessed.findIndex((entry) => entry.path === _path && entry.access === check.access) : -1;
      const seen = asked ? kernel[index] ?? { state: 'error' as const, reason: 'no answer' } : { state: 'skipped' as const };
      return {
        ...check,
        policy: policyOf(_path, check.access),
        kernel: seen.state,
        ...(seen.state === 'error' ? { reason: seen.reason } : {}),
      };
    });
    const ok = checks.every((check) => !failedCheck(check));
    const exceptions = policy.ignored.filter((entry) => entry.config).map(({ path, reason }) => ({ path: displayOf(path, home), reason }));
    return {
      coverage: { profile, ok, checks, launch: launchError ? { built: false, error: launchError } : { built: true, paths: needs.length } },
      exceptions,
    };
  } catch (err) {
    return { coverage: { profile, ok: false, checks: [], error: (err as Error).message }, exceptions: [] };
  } finally {
    for (const probe of probes) rmSync(probe, { force: true });
    // What the build wrote for this throwaway mission, its links to the shared caches first.
    if (timonHome === TIMON_HOME) disposeProviderScratch(missionId);
    for (const dir of made.reverse()) rmSync(dir, { recursive: true, force: true });
    removeNewEmptyFolders(sharedBefore, sharedFolders());
    rmSync(policyFile, { force: true });
  }
}
