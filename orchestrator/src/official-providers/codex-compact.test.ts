/**
 * Codex native in-place compaction drives `codex app-server` JSON-RPC:
 * initialize -> initialized -> thread/resume -> thread/compact/start -> turn/completed.
 */
import '../test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compactCodexThread } from '../../official-providers/provider-codex/lib/compact.js';

interface RecordedCall {
  name: string;
  args: string[];
  opts: { env?: Record<string, string>; timeoutMs?: number };
  sent: Record<string, unknown>[];
  stopped: boolean;
}

function makeFakeBinary(
  onWrite: (msg: Record<string, unknown>, emit: (line: string) => void, exit: (code: number | null) => void) => void,
) {
  const recorded: RecordedCall[] = [];
  const binary = {
    async converse(name: string, args: string[], opts: { env?: Record<string, string>; timeoutMs?: number } = {}) {
      const entry: RecordedCall = { name, args, opts, sent: [], stopped: false };
      recorded.push(entry);
      const listeners = new Set<(chunk: Uint8Array) => void>();
      let resolveExit!: (v: { code: number | null; signal: string | null }) => void;
      const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
        resolveExit = resolve;
      });
      const emit = (line: string) => {
        const bytes = Buffer.from(line, 'utf8');
        for (const fn of listeners) fn(bytes);
      };
      const exit = (code: number | null) => {
        resolveExit({ code, signal: null });
      };
      return {
        onData(fn: (chunk: Uint8Array) => void) {
          listeners.add(fn);
          return () => { listeners.delete(fn); };
        },
        write(data: string) {
          for (const raw of data.split('\n')) {
            const trimmed = raw.trim();
            if (!trimmed) continue;
            const parsed = JSON.parse(trimmed) as Record<string, unknown>;
            entry.sent.push(parsed);
            setImmediate(() => onWrite(parsed, emit, exit));
          }
        },
        async stop() {
          entry.stopped = true;
        },
        exited,
      };
    },
  };
  return { binary, recorded };
}

test('compactCodexThread: happy path runs JSON-RPC sequence, forwards CODEX_HOME, and resolves with metadata', async () => {
  const { binary, recorded } = makeFakeBinary((msg, emit) => {
    if (msg.id === 1 && msg.method === 'initialize') {
      emit(`${JSON.stringify({ id: 1, result: { userAgent: 'codex-test' } })}\n`);
    } else if (msg.id === 2 && msg.method === 'thread/resume') {
      emit(`${JSON.stringify({ id: 2, result: { thread: { id: 'thr-42' } } })}\n`);
    } else if (msg.id === 3 && msg.method === 'thread/compact/start') {
      emit(`${JSON.stringify({ id: 3, result: {} })}\n`);
      emit(`${JSON.stringify({ method: 'item/completed', params: { threadId: 'thr-42', item: { type: 'contextCompaction' } } })}\n`);
      // Ignore notifications for another thread.
      emit(`${JSON.stringify({ method: 'turn/completed', params: { threadId: 'thr-other', turn: { status: 'failed' } } })}\n`);
      emit(`${JSON.stringify({ method: 'turn/completed', params: { threadId: 'thr-42', turn: { status: 'completed' } } })}\n`);
    }
  });

  const result = await compactCodexThread(binary, {
    missionId: 'm-1',
    sessionId: 'thr-42',
    cwd: '/repo/project',
    scratch: '/tmp/scratch/m-1',
    timeoutMs: 120_000,
  });

  assert.deepEqual(result, {
    metadata: { method: 'thread/compact/start', context_compaction: true },
  });
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0]!.name, 'codex');
  assert.deepEqual(recorded[0]!.args, ['app-server']);
  assert.deepEqual(recorded[0]!.opts, { env: { CODEX_HOME: '/tmp/scratch/m-1' }, timeoutMs: 120_000 });
  assert.equal(recorded[0]!.stopped, true);
  assert.deepEqual(
    recorded[0]!.sent.map((m) => m.method),
    ['initialize', 'initialized', 'thread/resume', 'thread/compact/start'],
  );
  assert.deepEqual(recorded[0]!.sent[2]!.params, { threadId: 'thr-42', cwd: '/repo/project' });
  assert.deepEqual(recorded[0]!.sent[3]!.params, { threadId: 'thr-42' });
});

test('compactCodexThread: rejects on RPC error from thread/resume or thread/compact/start', async () => {
  const { binary } = makeFakeBinary((msg, emit) => {
    if (msg.id === 1) emit(`${JSON.stringify({ id: 1, result: {} })}\n`);
    if (msg.id === 2) emit(`${JSON.stringify({ id: 2, error: { code: -32602, message: 'thread not found' } })}\n`);
  });
  await assert.rejects(
    () => compactCodexThread(binary, { missionId: 'm-2', sessionId: 'thr-missing', timeoutMs: 5_000 }),
    /thread\/resume failed: thread not found \(code -32602\)/,
  );
});

test('compactCodexThread: rejects when compaction turn fails or app-server exits prematurely', async () => {
  const { binary: failBin } = makeFakeBinary((msg, emit) => {
    if (msg.id === 1) emit(`${JSON.stringify({ id: 1, result: {} })}\n`);
    if (msg.id === 2) emit(`${JSON.stringify({ id: 2, result: {} })}\n`);
    if (msg.id === 3) {
      emit(`${JSON.stringify({ id: 3, result: {} })}\n`);
      emit(`${JSON.stringify({ method: 'turn/completed', params: { threadId: 'thr-1', turn: { status: 'failed', error: { message: 'context limit' } } } })}\n`);
    }
  });
  await assert.rejects(
    () => compactCodexThread(failBin, { missionId: 'm-3', sessionId: 'thr-1', timeoutMs: 5_000 }),
    /codex compaction failed: context limit/,
  );

  const { binary: exitBin } = makeFakeBinary((msg, emit, exit) => {
    if (msg.id === 1) {
      emit(`${JSON.stringify({ id: 1, result: {} })}\n`);
      exit(1);
    }
  });
  await assert.rejects(
    () => compactCodexThread(exitBin, { missionId: 'm-4', sessionId: 'thr-1', timeoutMs: 5_000 }),
    /exited before compaction completed/,
  );
});

test('compactCodexThread: rejects when sessionId is empty', async () => {
  const { binary, recorded } = makeFakeBinary(() => {});
  await assert.rejects(
    () => compactCodexThread(binary, { missionId: 'm-5', sessionId: '   ', timeoutMs: 5_000 }),
    /requires a session id/,
  );
  assert.equal(recorded.length, 0);
});
