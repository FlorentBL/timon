/**
 * A compaction answers at once and reports its phases on the bus. Native when
 * the backend declares it and the caller keeps the mission's LLM; a forced
 * summary then a fork otherwise. Every failure ends in `error` with a readable
 * message, and no path waits forever.
 */
import './test-home.js';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { bus, type BusEvent } from './bus.js';
import { killAgent, respawnWithResume, sendToAgent } from './agent.js';
import { dbApi } from './db.js';
import { registerProfile, registerProvider } from './backends/registry.js';
import type { NativeProviderDefinition } from './backends/types.js';
import {
  compactOperation, defaultCompactDeps, planCompaction, resetCompactOperations, startCompaction,
  type CompactDeps, type MissionLlm,
} from './mission-compact.js';

type Progress = Extract<BusEvent, { kind: 'compact_progress' }>;

const CLAUDE: MissionLlm = { agent: 'acme.main', backend: 'claude', model: 'opus', reasoningEffort: 'high' };
const native = (backend: string): string | null => (backend === 'claude' ? '/compact' : null);

function fakeDeps(over: Partial<CompactDeps> = {}): CompactDeps & { recorded: Record<string, unknown>[]; sent: string[]; forked: unknown[] } {
  const recorded: Record<string, unknown>[] = [];
  const sent: string[] = [];
  const forked: unknown[] = [];
  return {
    recorded, sent, forked,
    currentLlm: () => CLAUDE,
    nativeCommand: native,
    turnActive: () => false,
    sendCommand: async (_id, command) => { sent.push(command); return 'delivered'; },
    sendMessage: async (_id, text) => { sent.push(text); return true; },
    summarize: async () => ({ summary: 's' }),
    fork: async (opts) => { forked.push(opts); return { missionId: 'fork-1' }; },
    record: (_id, payload) => { recorded.push(payload); },
    timeoutMs: () => 5_000,
    ...over,
  };
}

/** The phases published for `missionId` until the operation ends. */
function phases(missionId: string): { list: Progress[]; ended: Promise<Progress[]> } {
  const list: Progress[] = [];
  const ended = new Promise<Progress[]>((resolve) => {
    const on = (ev: BusEvent): void => {
      if (ev.kind !== 'compact_progress') return;
      list.push(ev);
      if (ev.phase === 'done' || ev.phase === 'error') {
        bus.off(`mission:${missionId}`, on);
        resolve(list);
      }
    };
    bus.on(`mission:${missionId}`, on);
  });
  return { list, ended };
}

/** What the agent's process would publish once the command reached it. */
function agentEmits(...events: BusEvent[]): void {
  setImmediate(() => { for (const ev of events) bus.publish(ev); });
}

const boundary = (missionId: string): BusEvent => ({
  kind: 'event', missionId, type: 'system', timestamp: Date.now(),
  payload: { type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'manual', pre_tokens: 3403, post_tokens: 660 } },
});

beforeEach(() => resetCompactOperations());

test('plan: native with no target, or with the mission\'s own LLM, when the backend declares it', () => {
  assert.equal(planCompaction(CLAUDE, {}, native).mode, 'native');
  assert.equal(planCompaction(CLAUDE, { backend: 'claude', model: 'opus' }, native).mode, 'native');
  const plan = planCompaction(CLAUDE, { backend: 'claude', model: 'opus' }, native);
  assert.deepEqual(plan, { mode: 'native', command: '/compact', backend: 'claude', model: 'opus' });
});

test('plan: another model or backend forks; a backend without the capability forks on the same model', () => {
  assert.deepEqual(planCompaction(CLAUDE, { model: 'sonnet' }, native),
    { mode: 'fork', backend: 'claude', model: 'sonnet', reasoningEffort: 'high' });
  // The effort of the backend left behind does not follow.
  assert.deepEqual(planCompaction(CLAUDE, { backend: 'codex', model: 'gpt-5.5' }, native),
    { mode: 'fork', backend: 'codex', model: 'gpt-5.5', reasoningEffort: null });
  const codex: MissionLlm = { agent: 'acme.main', backend: 'codex', model: 'gpt-5.5', reasoningEffort: null };
  assert.deepEqual(planCompaction(codex, {}, native),
    { mode: 'fork', backend: 'codex', model: 'gpt-5.5', reasoningEffort: null });
  const effort = planCompaction(CLAUDE, { model: 'sonnet', reasoning_effort: 'low' }, native);
  assert.equal(effort.mode === 'fork' ? effort.reasoningEffort : undefined, 'low');
});

test('native: the command goes to the mission, the boundary then the end of the turn conclude it, the message follows', async () => {
  const id = 'm-native-ok';
  const deps = fakeDeps({
    sendCommand: async (missionId, command) => {
      deps.sent.push(command);
      agentEmits(boundary(missionId), { kind: 'turn_complete', missionId });
      return 'delivered';
    },
  });
  const seen = phases(id);
  const out = startCompaction(id, { message: 'go on' }, deps);
  assert.equal(out.status, 202);
  assert.equal(out.body.operation?.mode, 'native');
  assert.equal(out.body.operation?.targetMissionId, id);
  const list = await seen.ended;
  assert.deepEqual(list.map((p) => p.phase), ['started', 'compacting', 'done']);
  assert.equal(list.at(-1)?.targetMissionId, id);
  assert.equal(deps.recorded.length, 1);
  assert.equal(deps.recorded[0]!.outcome, 'done');
  assert.deepEqual(deps.recorded[0]!.compact_metadata, { trigger: 'manual', pre_tokens: 3403, post_tokens: 660 });
  // The follow-up is sent after `done`, without blocking it.
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(deps.sent, ['/compact', 'go on']);
  assert.equal(compactOperation(id)?.phase, 'done');
});

test('native: a turn that ends without a boundary is an error, not a success', async () => {
  const id = 'm-native-noboundary';
  const deps = fakeDeps({
    sendCommand: async (missionId) => {
      agentEmits({ kind: 'turn_complete', missionId });
      return 'delivered';
    },
  });
  const seen = phases(id);
  startCompaction(id, {}, deps);
  const list = await seen.ended;
  assert.equal(list.at(-1)?.phase, 'error');
  assert.match(String(list.at(-1)?.error), /without compacting/);
  assert.equal(deps.recorded[0]!.outcome, 'error');
});

test('native: no answer at all ends on the deadline instead of waiting forever', async () => {
  const id = 'm-native-silent';
  const deps = fakeDeps({ timeoutMs: () => 50 });
  const seen = phases(id);
  startCompaction(id, {}, deps);
  const list = await seen.ended;
  assert.equal(list.at(-1)?.phase, 'error');
  assert.match(String(list.at(-1)?.error), /no compaction after/);
  // A late boundary does not revive it.
  bus.publish(boundary(id));
  bus.publish({ kind: 'turn_complete', missionId: id });
  assert.equal(compactOperation(id)?.phase, 'error');
});

test('native: a session that cannot be resumed is a readable error', async () => {
  const id = 'm-native-gone';
  const deps = fakeDeps({ sendCommand: async () => 'not_resumable' });
  const seen = phases(id);
  startCompaction(id, {}, deps);
  const list = await seen.ended;
  assert.match(String(list.at(-1)?.error), /no session left to compact/);
});

test('native: refused while the agent is answering, and nothing is started', () => {
  const id = 'm-native-busy';
  const deps = fakeDeps({ turnActive: () => true });
  const out = startCompaction(id, {}, deps);
  assert.equal(out.status, 409);
  assert.equal(out.body.operation, undefined);
  assert.equal((out.body as { code: string }).code, 'turn_in_flight');
  assert.equal(compactOperation(id), null);
  assert.deepEqual(deps.sent, []);
});

test('fork: forced summary, then a fork of the same agent on the same model', async () => {
  const id = 'm-fork-ok';
  let summarized = 0;
  const deps = fakeDeps({
    nativeCommand: () => null,
    summarize: async () => { summarized++; return {}; },
  });
  const seen = phases(id);
  const out = startCompaction(id, { message: 'next step' }, deps);
  assert.equal(out.status, 202);
  assert.equal(out.body.operation?.mode, 'fork');
  assert.equal(out.body.operation?.targetMissionId, null);
  const list = await seen.ended;
  assert.deepEqual(list.map((p) => p.phase), ['started', 'summarizing', 'forking', 'done']);
  assert.equal(list.at(-1)?.targetMissionId, 'fork-1');
  assert.equal(summarized, 1);
  assert.deepEqual(deps.forked, [{
    sourceMissionId: id, targetAgent: 'acme.main', continuation: 'next step',
    backendOverride: 'claude', modelOverride: 'opus', reasoningEffort: 'high',
  }]);
  assert.equal(deps.recorded[0]!.target_mission_id, 'fork-1');
});

test('fork: a failed summary is an error event and a readable message, and no fork is spawned', async () => {
  const id = 'm-fork-fail';
  const deps = fakeDeps({
    nativeCommand: () => null,
    summarize: async () => { throw new Error('mission has no conversational events to summarize'); },
  });
  const seen = phases(id);
  startCompaction(id, {}, deps);
  const list = await seen.ended;
  assert.deepEqual(list.map((p) => p.phase), ['started', 'summarizing', 'error']);
  assert.equal(list.at(-1)?.error, 'summary: mission has no conversational events to summarize');
  assert.deepEqual(deps.forked, []);
  assert.equal(deps.recorded[0]!.outcome, 'error');
  assert.equal(compactOperation(id)?.error, 'summary: mission has no conversational events to summarize');
});

test('one compaction at a time per conversation; a finished one is replaced', async () => {
  const id = 'm-twice';
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const deps = fakeDeps({ nativeCommand: () => null, summarize: async () => { await gate; return {}; } });
  const seen = phases(id);
  assert.equal(startCompaction(id, {}, deps).status, 202);
  const again = startCompaction(id, {}, deps);
  assert.equal(again.status, 409);
  assert.equal((again.body as { code: string }).code, 'compact_in_progress');
  release();
  await seen.ended;
  const next = phases(id);
  assert.equal(startCompaction(id, {}, deps).status, 202);
  await next.ended;
});

test('a finished operation stays readable for a while, then is forgotten', async () => {
  const id = 'm-keep';
  const deps = fakeDeps({ nativeCommand: () => null });
  const seen = phases(id);
  startCompaction(id, {}, deps);
  await seen.ended;
  assert.equal(compactOperation(id)?.phase, 'done');
  assert.equal(compactOperation(id, Date.now() + 16 * 60_000), null);
  assert.equal(compactOperation(id), null);
});

test('programmatic native: runs hook in place, records metadata, and delivers follow-up message', async () => {
  const id = 'm-prog-ok';
  const codex: MissionLlm = { agent: 'acme.main', backend: 'codex', model: 'gpt-6.2-sol', reasoningEffort: null };
  const runHook = async () => ({ metadata: { method: 'thread/compact/start', context_compaction: true } });
  const called: { missionId: string; backend: string; timeoutMs: number }[] = [];
  const deps = fakeDeps({
    currentLlm: () => codex,
    nativeCompact: (backend) => (backend === 'codex' ? { run: runHook } : null),
    runNativeCompact: async (missionId, backend, run, timeoutMs) => {
      called.push({ missionId, backend, timeoutMs });
      return run({ missionId, sessionId: 'thr-1', timeoutMs });
    },
  });

  const plan = planCompaction(codex, {}, deps.nativeCompact!);
  assert.equal(plan.mode, 'native');
  assert.ok('run' in plan && plan.run === runHook);

  const seen = phases(id);
  const out = startCompaction(id, { message: 'continue here' }, deps);
  assert.equal(out.status, 202);
  assert.equal(out.body.operation?.mode, 'native');
  assert.equal(out.body.operation?.targetMissionId, id);

  const list = await seen.ended;
  assert.deepEqual(list.map((p) => p.phase), ['started', 'compacting', 'done']);
  assert.deepEqual(called, [{ missionId: id, backend: 'codex', timeoutMs: 5_000 }]);
  assert.equal(deps.recorded[0]!.outcome, 'done');
  assert.deepEqual(deps.recorded[0]!.compact_metadata, { method: 'thread/compact/start', context_compaction: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(deps.sent, ['continue here']);
});

test('programmatic native: non-resumable session, hook error, and timeout all end in error', async () => {
  const codex: MissionLlm = { agent: 'acme.main', backend: 'codex', model: 'gpt-6.2-sol', reasoningEffort: null };
  const runHook = async () => undefined;

  const idGone = 'm-prog-gone';
  const seenGone = phases(idGone);
  startCompaction(idGone, {}, fakeDeps({
    currentLlm: () => codex,
    nativeCompact: () => ({ run: runHook }),
    runNativeCompact: async () => 'not_resumable',
  }));
  const listGone = await seenGone.ended;
  assert.equal(listGone.at(-1)?.phase, 'error');
  assert.match(String(listGone.at(-1)?.error), /no session left to compact/);

  const idErr = 'm-prog-err';
  const seenErr = phases(idErr);
  startCompaction(idErr, {}, fakeDeps({
    currentLlm: () => codex,
    nativeCompact: () => ({ run: runHook }),
    runNativeCompact: async () => { throw new Error('thread/compact/start failed'); },
  }));
  const listErr = await seenErr.ended;
  assert.equal(listErr.at(-1)?.phase, 'error');
  assert.equal(listErr.at(-1)?.error, 'compaction: thread/compact/start failed');

  const idSlow = 'm-prog-slow';
  const seenSlow = phases(idSlow);
  startCompaction(idSlow, {}, fakeDeps({
    currentLlm: () => codex,
    nativeCompact: () => ({ run: runHook }),
    timeoutMs: () => 40,
    runNativeCompact: () => new Promise(() => {}),
  }));
  const listSlow = await seenSlow.ended;
  assert.equal(listSlow.at(-1)?.phase, 'error');
  assert.match(String(listSlow.at(-1)?.error), /no compaction after/);
});

test('programmatic native: blocks concurrent sendToAgent/respawnWithResume and aborts on killAgent', async () => {
  const id = 'm-prog-mutex';
  const codex: MissionLlm = { agent: 'acme.main', backend: 'codex', model: 'gpt-6.2-sol', reasoningEffort: null };
  let capturedSignal: AbortSignal | undefined;
  let started!: () => void;
  const hookStarted = new Promise<void>((resolve) => { started = resolve; });

  const seen = phases(id);
  startCompaction(id, {}, fakeDeps({
    currentLlm: () => codex,
    nativeCompact: () => ({ run: async () => undefined }),
    runNativeCompact: (_missionId, _backend, _run, _timeoutMs, signal) => {
      capturedSignal = signal;
      started();
      return new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(signal.reason ?? new Error('aborted')), { once: true });
      });
    },
  }));

  await hookStarted;
  assert.equal(await sendToAgent(id, 'hello'), 'turn_in_flight');
  assert.equal(await respawnWithResume(id, 'hello'), false);

  assert.equal(killAgent(id, { source: 'test' }), 'killed');
  assert.equal(capturedSignal?.aborted, true);

  const list = await seen.ended;
  assert.equal(list.at(-1)?.phase, 'error');
  assert.match(String(list.at(-1)?.error), /mission killed/);
});

test('defaultCompactDeps.runNativeCompact: returns not_resumable when per-mission scratch is missing', async () => {
  const backendId = 'test-per-mission-compact';
  const def = {
    id: backendId,
    transport: { kind: 'process-per-turn' },
    launch: async () => ({ cmd: 'acme', args: [], initialStdin: null }),
    codec: { kind: 'lines', parseLine: () => [], extractSessionId: () => null },
    session: { store: 'per-mission', resumable: true, compact: { run: async () => undefined } },
    permission: { model: 'sandbox' },
    limits: { reporting: 'none' },
    mcp: { timon: false },
    declares: { binary: { names: ['acme'] } },
  } as unknown as NativeProviderDefinition;
  const releaseProvider = registerProvider('test-per-mission-compact', def);
  const releaseProfile = registerProfile('test-per-mission-compact', {
    id: backendId,
    dialect: backendId,
    label: 'Test Per-Mission',
    models: ['m-1'],
    defaultModel: 'm-1',
  });
  try {
    const missionId = 'm-missing-scratch';
    dbApi.createMission(missionId, 'acme.main', 'test prompt');
    dbApi.setMissionSession(missionId, 'thr-1');
    const deps = defaultCompactDeps();
    const outcome = await deps.runNativeCompact!(missionId, backendId, async () => undefined, 5_000);
    assert.equal(outcome, 'not_resumable');
  } finally {
    releaseProfile();
    releaseProvider();
  }
});
