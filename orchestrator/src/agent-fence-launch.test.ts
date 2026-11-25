/**
 * A mission launch through the fence, end to end on the daemon side: the
 * process spawned is the host's fence launcher wrapping the CLI, the policy
 * it is handed is built from the mission's identity and repository, and the
 * CLI gets its own temporary folder. The fence itself is a stand-in: what it
 * does to a real process is `host/landlock.test.ts`'s business.
 */
import './test-home.js';
import '../tests/helpers/paid-license.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, join, sep } from 'node:path';
import { tmpdir } from 'node:os';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { FencePolicy } from './host/isolation.js';
import type { HostFence } from './host/types.js';

process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';
const AUTH = mkdtempSync(join(tmpdir(), 'timon-fence-auth-'));
writeFileSync(join(AUTH, 'auth.json'), JSON.stringify({ tokens: { access_token: 'test-only' } }));
process.env.CODEX_AUTH_DIR = AUTH;
const BIN = mkdtempSync(join(tmpdir(), 'timon-fence-bin-'));
writeFileSync(join(BIN, 'codex'), '', { mode: 0o755 });
process.env.PATH = `${BIN}${delimiter}${process.env.PATH ?? ''}`;
process.on('exit', () => {
  rmSync(AUTH, { recursive: true, force: true });
  rmSync(BIN, { recursive: true, force: true });
});

const { mountOfficialProviders } = await import('../tests/helpers/official-providers.js');
const { getHost } = await import('./host/index.js');
const { deleteAgent, renameAgent, spawnAgent, upsertAgent } = await import('./agent.js');
const { config, setConfig } = await import('./config/load.js');
const { TIMON_HOME } = await import('./paths.js');
const { missionFenced } = await import('./mission-fence-state.js');

assert.ok((await mountOfficialProviders()).includes('provider-codex'));
setConfig({ ...config(), host: { ...config().host, isolation: { ...config().host.isolation, filesystem: 'auto' } } });

// A main checkout, and a linked worktree of it under the Timon home, as the dispatcher makes them.
const ROOT = realpathSync.native(mkdtempSync(join(tmpdir(), 'timon-fence-repo-')));
const MAIN = join(ROOT, 'app');
const WT = join(TIMON_HOME, 'worktrees', 'task-1');
const WT_GIT = join(MAIN, '.git', 'worktrees', 'task-1');
mkdirSync(WT_GIT, { recursive: true });
mkdirSync(WT, { recursive: true });
writeFileSync(join(WT, '.git'), `gitdir: ${WT_GIT}\n`);
writeFileSync(join(WT_GIT, 'gitdir'), `${join(WT, '.git')}\n`);
writeFileSync(join(WT_GIT, 'commondir'), '../..\n');
// The policy holds each path the way it resolves (`/private/var` on macOS, the
// long name of a `RUNNER~1` folder on Windows): its assertions use that spelling.
const REAL_HOME = realpathSync.native(TIMON_HOME);
const REAL_WT = join(REAL_HOME, 'worktrees', 'task-1');

upsertAgent({
  name: 'fence.witness',
  system_prompt: 'witness — does nothing.',
  config: { backend: 'codex', cwd: WT, skills: [], memory_scope: 'NONE' },
});
upsertAgent({
  name: 'fence.reader',
  system_prompt: 'reader — plans, writes nothing.',
  config: { backend: 'codex', cwd: WT, skills: [], memory_scope: 'NONE', permission_mode: 'plan' },
});

const LAUNCHER = '/opt/timon/timon-fence';

type FakeChild = EventEmitter & { stdin: PassThrough; stdout: PassThrough; stderr: PassThrough };

async function launch(agent = 'fence.witness'): Promise<{ cmd: string; args: string[]; env: NodeJS.ProcessEnv; policy: FencePolicy; missionId: string; child: FakeChild }> {
  const host = getHost();
  const original = { spawn: host.spawn, fence: host.fence };
  const policies: FencePolicy[] = [];
  const fence: HostFence = {
    mechanism: 'landlock',
    probe: () => ({ available: true, abi: 6 }),
    wrap: (policy, cmd, args, policyFile) => {
      policies.push(policy);
      return { cmd: LAUNCHER, args: ['--policy', policyFile, '--', cmd, ...args] };
    },
    witness: async () => ({ ran: true, status: 0, stderr: '' }),
  };
  const child = Object.assign(new EventEmitter(), {
    pid: 4247, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), killed: false,
    kill() { this.killed = true; return true; },
  });
  const seen = { cmd: '', args: [] as string[], env: {} as NodeJS.ProcessEnv };
  host.fence = fence;
  host.spawn = ((cmd: string, args: string[], opts?: { env?: NodeJS.ProcessEnv }) => {
    seen.cmd = cmd; seen.args = args; seen.env = (opts?.env ?? {}) as NodeJS.ProcessEnv;
    return child as unknown as ChildProcessWithoutNullStreams;
  }) as typeof host.spawn;
  let missionId = '';
  try {
    missionId = await spawnAgent(agent, 'ping');
  } finally {
    host.spawn = original.spawn;
    host.fence = original.fence;
  }
  const policy = policies[0];
  assert.ok(policy, 'the fence was asked to wrap the launch');
  return { ...seen, policy, missionId, child };
}

test('the CLI is spawned through the fence launcher, its own temporary folder as TMPDIR', async () => {
  const run = await launch();
  const at = run.args.indexOf('--');
  assert.equal(run.cmd, LAUNCHER);
  assert.match(run.args[1] ?? '', /run[\\/]fence[\\/].+\.policy$/);
  assert.match(run.args[at + 1] ?? '', /codex$/, 'the CLI right after the launcher');
  const tmp = join(TIMON_HOME, 'tmp', 'missions', run.missionId);
  assert.equal(run.env.TMPDIR, tmp);
  assert.equal(run.env.DISABLE_AUTOUPDATER, '1');
  assert.ok(run.policy.rw.includes(join(REAL_HOME, 'tmp', 'missions', run.missionId)));
  assert.equal(missionFenced(run.missionId), true, 'the session driver learns the process is fenced');
});

test('the CLI\'s package managers download into its agent\'s cache, which the policy opens', async () => {
  const run = await launch();
  const cache = join(TIMON_HOME, 'provider-cache', '.agents', 'fence.witness');
  assert.equal(run.env.npm_config_cache, join(cache, 'npm'));
  assert.equal(run.env.npm_config_cache_dir, join(cache, 'pnpm', 'cache'));
  assert.equal(run.env.npm_config_store_dir, join(cache, 'pnpm', 'store'));
  assert.equal(run.env.UV_CACHE_DIR, join(cache, 'uv'));
  assert.ok(run.policy.rw.includes(join(REAL_HOME, 'provider-cache', '.agents', 'fence.witness')));
});

test('the policy opens the mission\'s worktree, repository and provider folders, and nothing else of the Timon home', async () => {
  const run = await launch();
  const { policy } = run;
  assert.ok(policy.rw.includes(REAL_WT));
  assert.ok(policy.rw.includes(join(MAIN, '.git')), 'the repository the worktree names back');
  assert.ok(policy.rw.includes(MAIN), 'the main checkout, which a merge fast-forwards');
  assert.ok(policy.rw.includes(join(REAL_HOME, 'provider-runs', 'provider-codex', run.missionId)), 'the CLI\'s per-mission home');
  assert.ok(policy.deny.includes(REAL_HOME) && policy.deny.includes(TIMON_HOME), 'under both spellings');
  for (const path of policy.rw) {
    if (!path.startsWith(`${REAL_HOME}${sep}`)) continue;
    assert.ok(
      [REAL_WT, join(REAL_HOME, 'tmp', 'missions'), join(REAL_HOME, 'provider-runs', 'provider-codex'), join(REAL_HOME, 'provider-cache', 'provider-codex'), join(REAL_HOME, 'provider-cache', '.agents', 'fence.witness'), join(REAL_HOME, 'agents', 'fence.witness')]
        .some((own) => path === own || path.startsWith(`${own}${sep}`)),
      `${path} is one of the mission's own folders`,
    );
  }
});

/** The value codex is handed for `--sandbox`. */
const sandboxLevel = (args: readonly string[]): string | undefined => args[args.indexOf('--sandbox') + 1];

test('fenced, codex runs without its own sandbox and the fence applies the agent\'s level', async () => {
  const writing = await launch();
  assert.equal(sandboxLevel(writing.args), 'danger-full-access', 'bwrap and Seatbelt cannot start inside the fence');
  assert.equal(writing.args.filter((arg) => arg === '--sandbox').length, 1);
  assert.ok(writing.policy.rw.includes(REAL_WT), 'workspace-write: the worktree stays writable');
  const reading = await launch('fence.reader');
  assert.equal(sandboxLevel(reading.args), 'danger-full-access');
  assert.ok(reading.policy.ro.includes(REAL_WT) && !reading.policy.rw.includes(REAL_WT), 'plan: the worktree is read-only');
  assert.ok(reading.policy.ro.includes(join(MAIN, '.git')) && !reading.policy.rw.includes(join(MAIN, '.git')), 'and its repository too');
  assert.ok(reading.policy.rw.includes(join(REAL_HOME, 'provider-runs', 'provider-codex', reading.missionId)), 'the CLI\'s own home stays writable');
});

test('without a fence on the machine, auto launches the bare CLI with the plain TMPDIR', async () => {
  const host = getHost();
  const original = { spawn: host.spawn, fence: host.fence };
  const seen = { cmd: '', args: [] as string[], env: {} as NodeJS.ProcessEnv };
  const child = Object.assign(new EventEmitter(), {
    pid: 4248, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), killed: false,
    kill() { this.killed = true; return true; },
  });
  host.fence = { mechanism: 'landlock', probe: () => ({ available: false, reason: 'kernel without Landlock', abi: 0 }), wrap: () => { throw new Error('never'); }, witness: async () => ({ ran: true, status: 0, stderr: '' }) };
  host.spawn = ((cmd: string, args: string[], opts?: { env?: NodeJS.ProcessEnv }) => {
    seen.cmd = cmd; seen.args = args; seen.env = (opts?.env ?? {}) as NodeJS.ProcessEnv;
    return child as unknown as ChildProcessWithoutNullStreams;
  }) as typeof host.spawn;
  let missionId = '';
  try {
    missionId = await spawnAgent('fence.witness', 'ping');
  } finally {
    host.spawn = original.spawn;
    host.fence = original.fence;
  }
  assert.equal(missionFenced(missionId), false);
  assert.match(seen.cmd, /codex$/);
  assert.equal(sandboxLevel(seen.args), 'workspace-write', 'unfenced, codex keeps its own sandbox');
  assert.equal(seen.env.DISABLE_AUTOUPDATER, undefined);
  assert.notEqual(seen.env.TMPDIR?.includes(join('tmp', 'missions')), true);
  // Unfenced, the package managers keep the user's own caches.
  for (const name of ['npm_config_cache', 'npm_config_cache_dir', 'npm_config_store_dir', 'UV_CACHE_DIR']) {
    assert.notEqual(seen.env[name]?.includes('.agents'), true, name);
  }
});

test('enforce refuses a mission it cannot fence, before any process starts', async () => {
  const host = getHost();
  const original = { spawn: host.spawn, fence: host.fence };
  let spawned = false;
  const previous = config();
  setConfig({ ...previous, host: { ...previous.host, isolation: { ...previous.host.isolation, filesystem: 'enforce' } } });
  host.fence = undefined;
  host.spawn = (() => { spawned = true; throw new Error('never'); }) as typeof host.spawn;
  try {
    await assert.rejects(spawnAgent('fence.witness', 'ping'), /Mission refused: host\.isolation\.filesystem is "enforce"/);
  } finally {
    host.spawn = original.spawn;
    host.fence = original.fence;
    setConfig(previous);
  }
  assert.equal(spawned, false);
});

test('deleting or renaming an agent removes its package cache', () => {
  const cache = (agent: string) => join(TIMON_HOME, 'provider-cache', '.agents', agent);
  for (const name of ['fence.leaving', 'fence.old']) {
    upsertAgent({ name, system_prompt: 'witness', config: { backend: 'codex', cwd: WT, skills: [], memory_scope: 'NONE' } });
    mkdirSync(join(cache(name), 'npm', '_npx'), { recursive: true });
  }
  // A stale cache under the new name is not the renamed agent's to inherit.
  mkdirSync(join(cache('fence.new'), 'npm'), { recursive: true });
  mkdirSync(cache('fence.witness'), { recursive: true });
  assert.equal(deleteAgent('fence.leaving'), true);
  assert.equal(existsSync(cache('fence.leaving')), false);
  assert.equal(renameAgent('fence.old', 'fence.new').ok, true);
  assert.equal(existsSync(cache('fence.old')), false);
  assert.equal(existsSync(cache('fence.new')), false);
  assert.ok(existsSync(cache('fence.witness')), 'the other agents keep theirs');
});

test('a path of the Timon home the CLI is told to use and the fence refuses stops the launch, named', async () => {
  // `run/` holds the daemon's private state: no mission ever reaches it, even as its working directory.
  const refused = join(TIMON_HOME, 'run', 'fence-preflight');
  mkdirSync(refused, { recursive: true });
  upsertAgent({ name: 'fence.walled', system_prompt: 'witness', config: { backend: 'codex', cwd: refused, skills: [], memory_scope: 'NONE' } });
  const host = getHost();
  const original = { spawn: host.spawn, fence: host.fence };
  let spawned = false;
  host.fence = {
    mechanism: 'landlock',
    probe: () => ({ available: true, abi: 6 }),
    wrap: (_policy, cmd, args, policyFile) => ({ cmd: LAUNCHER, args: ['--policy', policyFile, '--', cmd, ...args] }),
    witness: async () => ({ ran: true, status: 0, stderr: '' }),
  };
  host.spawn = (() => { spawned = true; throw new Error('never'); }) as typeof host.spawn;
  const { MissionFenceBlockedError } = await import('./resources.js');
  const { dbApi } = await import('./db.js');
  let caught: unknown = null;
  try {
    await spawnAgent('fence.walled', 'ping');
  } catch (err) {
    caught = err;
  } finally {
    host.spawn = original.spawn;
    host.fence = original.fence;
  }
  assert.equal(spawned, false, 'no CLI started');
  assert.ok(caught instanceof MissionFenceBlockedError, `refused by the preflight, got ${String(caught)}`);
  const { refusal } = caught;
  assert.equal(refusal.stage, 'launch');
  assert.equal(refusal.access, 'write');
  assert.equal(refusal.timonHome, true);
  assert.equal(refusal.grantable, false, 'a folder of the Timon home is never offered to a person');
  assert.equal(refusal.agent, 'fence.walled');
  assert.equal(refusal.mechanism, 'landlock');
  assert.deepEqual(refusal.setting, { category: 'system', tab: 'security' });
  assert.match(caught.message, /mission fence \(Landlock\)/);
  assert.match(caught.message, /Settings › System › Security/);
  // The thread carries the same object, for its notice and an access card.
  const event = dbApi.listEvents(refusal.missionId).find((e) => e.type === 'fence_refused');
  assert.ok(event, 'a fence_refused event is recorded on the mission');
  const payload = JSON.parse(event.payload) as Record<string, unknown>;
  assert.equal(payload.path, refusal.path);
  assert.equal(payload.access, 'write');
  assert.equal(payload.missionId, refusal.missionId);
  assert.equal(dbApi.getMission(refusal.missionId)?.status, 'failed');
});

/** The mission's events of `type`, once one has been recorded (the stream is read asynchronously). */
async function eventsOf(missionId: string, type: string, settle = 20): Promise<Array<Record<string, unknown>>> {
  const { dbApi } = await import('./db.js');
  for (let i = 0; i < 100; i++) {
    const found = dbApi.listEvents(missionId).filter((e) => e.type === type);
    if (found.length > 0) {
      await new Promise((done) => setTimeout(done, settle));
      return dbApi.listEvents(missionId).filter((e) => e.type === type).map((e) => JSON.parse(e.payload) as Record<string, unknown>);
    }
    await new Promise((done) => setTimeout(done, 10));
  }
  return [];
}

const codexLine = (value: unknown): string => `${JSON.stringify(value)}\n`;
const commandRun = (id: string, command: string, output: string, exit = 1): string => codexLine({
  type: 'item.completed', item: { id, type: 'command_execution', command, aggregated_output: output, exit_code: exit, status: 'completed' },
});

// The fence exists on Linux and macOS only, and a refusal is read from a POSIX path in what a tool printed.
const POSIX_ONLY = { skip: process.platform === 'win32' && 'the fence exists on Linux and macOS only' };

test('a path the fence refuses, met by a tool in a turn that goes on, is named in the thread once', POSIX_ONLY, async () => {
  // A file of the daemon's private state: the fence refuses it, the daemon outside the fence may read it.
  const refused = join(TIMON_HOME, 'run', 'productive-refusal.txt');
  mkdirSync(join(TIMON_HOME, 'run'), { recursive: true });
  writeFileSync(refused, 'not for missions');
  const { missionId, child } = await launch();
  child.stdout.write(codexLine({ type: 'thread.started', thread_id: 'thread-productive' }));
  child.stdout.write(codexLine({ type: 'turn.started' }));
  child.stdout.write(commandRun('item_1', `cat ${refused}`, `cat: ${refused}: Permission denied\n`));
  // The same path again, and a refusal the OS gives anyway: neither adds a notice.
  child.stdout.write(commandRun('item_2', `cat ${refused}`, `cat: ${refused}: Permission denied\n`));
  child.stdout.write(commandRun('item_3', 'cat /proc/1/mem', 'cat: /proc/1/mem: Permission denied\n'));
  child.stdout.write(codexLine({ type: 'item.completed', item: { id: 'item_4', type: 'agent_message', text: 'Read what I could.' } }));
  child.stdout.write(codexLine({ type: 'turn.completed', usage: { input_tokens: 900, output_tokens: 40 } }));
  const refusals = await eventsOf(missionId, 'fence_refused', 100);
  assert.equal(refusals.length, 1, JSON.stringify(refusals));
  const [refusal] = refusals;
  assert.equal(refusal?.path, refused);
  assert.equal(refusal?.stage, 'run');
  assert.equal(refusal?.access, 'read');
  assert.equal(refusal?.timonHome, true);
  assert.equal(refusal?.grantable, false);
  child.emit('exit', 0, null);
  child.emit('close', 0, null);
});

test('a refusal naming no path, in a turn that fails, names the fence and its setting once', async () => {
  const { missionId, child } = await launch();
  child.stdout.write(codexLine({ type: 'thread.started', thread_id: 'thread-pathless' }));
  child.stdout.write(codexLine({ type: 'turn.started' }));
  child.stdout.write(codexLine({ type: 'turn.failed', error: { message: 'Operation not permitted (os error 1)' } }));
  const suspicions = await eventsOf(missionId, 'fence_suspected', 50);
  assert.equal(suspicions.length, 1, JSON.stringify(suspicions));
  const [suspicion] = suspicions;
  assert.equal(suspicion?.said, 'Operation not permitted (os error 1)');
  assert.equal(suspicion?.mechanism, 'landlock');
  assert.equal(suspicion?.backend, 'codex');
  assert.deepEqual(suspicion?.setting, { category: 'system', tab: 'security' });
  const { dbApi } = await import('./db.js');
  assert.equal(dbApi.listEvents(missionId).filter((e) => e.type === 'fence_refused').length, 0, 'no path, so no refusal to offer');
  child.emit('exit', 1, null);
  child.emit('close', 1, null);
});

test('a mission that meets refused folder after refused folder gets a few notices, not one per folder', POSIX_ONLY, async () => {
  const folders = Array.from({ length: 8 }, (_, i) => join(TIMON_HOME, 'run', `walk-${i}`));
  for (const folder of folders) mkdirSync(folder, { recursive: true });
  const { missionId, child } = await launch();
  child.stdout.write(codexLine({ type: 'thread.started', thread_id: 'thread-walk' }));
  child.stdout.write(codexLine({ type: 'turn.started' }));
  folders.forEach((folder, i) => child.stdout.write(commandRun(`walk_${i}`, `ls ${folder}`, `ls: cannot open directory '${folder}': Permission denied\n`)));
  child.stdout.write(codexLine({ type: 'turn.completed', usage: { input_tokens: 900, output_tokens: 40 } }));
  const refusals = await eventsOf(missionId, 'fence_refused', 150);
  assert.equal(refusals.length, 5, refusals.map((r) => String(r.path)).join(', '));
  child.emit('exit', 0, null);
  child.emit('close', 0, null);
});
