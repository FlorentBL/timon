/**
 * Codex native in-place compaction drives `codex app-server` JSON-RPC:
 * initialize -> initialized -> thread/resume -> thread/compact/start -> turn/completed.
 */
import '../test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { compactCodexThread } from '../../official-providers/provider-codex/lib/compact.js';
import { createCodexProvider } from '../../official-providers/provider-codex/lib/codex.js';

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
    model: 'gpt-5.4',
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
  assert.deepEqual(recorded[0]!.sent[2]!.params, { threadId: 'thr-42', cwd: '/repo/project', model: 'gpt-5.4' });
  assert.deepEqual(recorded[0]!.sent[3]!.params, { threadId: 'thr-42' });
});

test('compactCodexThread: rejects on RPC error from thread/resume or thread/compact/start', async () => {
  const { binary } = makeFakeBinary((msg, emit) => {
    if (msg.id === 1) emit(`${JSON.stringify({ id: 1, result: {} })}\n`);
    if (msg.id === 2) emit(`${JSON.stringify({ id: 2, error: { code: -32602, message: 'thread not found' } })}\n`);
  });
  await assert.rejects(
    () => compactCodexThread(binary, { missionId: 'm-2', sessionId: 'thr-missing', scratch: '/tmp/scratch/m-2', timeoutMs: 5_000 }),
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
    () => compactCodexThread(failBin, { missionId: 'm-3', sessionId: 'thr-1', scratch: '/tmp/scratch/m-3', timeoutMs: 5_000 }),
    /codex compaction failed: context limit/,
  );

  const { binary: exitBin } = makeFakeBinary((msg, emit, exit) => {
    if (msg.id === 1) {
      emit(`${JSON.stringify({ id: 1, result: {} })}\n`);
      exit(1);
    }
  });
  await assert.rejects(
    () => compactCodexThread(exitBin, { missionId: 'm-4', sessionId: 'thr-1', scratch: '/tmp/scratch/m-4', timeoutMs: 5_000 }),
    /exited before compaction completed/,
  );
});

test('compactCodexThread: rejects when sessionId or scratch is empty', async () => {
  const { binary, recorded } = makeFakeBinary(() => {});
  await assert.rejects(
    () => compactCodexThread(binary, { missionId: 'm-5', sessionId: '   ', scratch: '/tmp/scratch/m-5', timeoutMs: 5_000 }),
    /requires a session id/,
  );
  await assert.rejects(
    () => compactCodexThread(binary, { missionId: 'm-5', sessionId: 'thr-1', timeoutMs: 5_000 }),
    /requires a mission scratch directory/,
  );
  assert.equal(recorded.length, 0);
});

test('compactCodexThread: merges ctx.env with CODEX_HOME and aborts cleanly via signal', async () => {
  const controller = new AbortController();
  const { binary, recorded } = makeFakeBinary((msg, emit) => {
    if (msg.id === 1) emit(`${JSON.stringify({ id: 1, result: {} })}\n`);
    if (msg.id === 2) emit(`${JSON.stringify({ id: 2, result: {} })}\n`);
    if (msg.id === 3) {
      emit(`${JSON.stringify({ id: 3, result: {} })}\n`);
      controller.abort(new Error('mission killed'));
    }
  });

  await assert.rejects(
    () => compactCodexThread(binary, {
      missionId: 'm-abort',
      sessionId: 'thr-abort',
      scratch: '/tmp/scratch/m-abort',
      env: { CODEX_API_KEY: 'sk-test', EXTRA_FLAG: '1' },
      signal: controller.signal,
      timeoutMs: 10_000,
    }),
    /mission killed/,
  );
  assert.equal(recorded.length, 1);
  assert.deepEqual(recorded[0]!.opts.env, {
    CODEX_API_KEY: 'sk-test',
    EXTRA_FLAG: '1',
    CODEX_HOME: '/tmp/scratch/m-abort',
  });
  assert.equal(recorded[0]!.stopped, true);
});

test('compactCodexThread: reports pre_tokens from scratch snapshot and post_tokens from notification', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'timon-codex-compact-'));
  try {
    const sessDir = join(scratch, 'sessions', '2026', '10', '25');
    mkdirSync(sessDir, { recursive: true });
    const rollout = join(sessDir, 'rollout-2026-10-25.jsonl');
    writeFileSync(rollout, `${JSON.stringify({
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: { last_token_usage: { input_tokens: 48_000, output_tokens: 2_000 }, model_context_window: 200_000 },
      },
    })}\n`);

    const { binary } = makeFakeBinary((msg, emit) => {
      if (msg.id === 1) emit(`${JSON.stringify({ id: 1, result: {} })}\n`);
      if (msg.id === 2) emit(`${JSON.stringify({ id: 2, result: {} })}\n`);
      if (msg.id === 3) {
        emit(`${JSON.stringify({ id: 3, result: {} })}\n`);
        emit(`${JSON.stringify({
          method: 'thread/tokenUsage/updated',
          params: { threadId: 'thr-tok', tokenUsage: { last: { totalTokens: 6_400, inputTokens: 6_000, outputTokens: 400 } } },
        })}\n`);
        emit(`${JSON.stringify({ method: 'item/completed', params: { threadId: 'thr-tok', item: { type: 'contextCompaction' } } })}\n`);
        emit(`${JSON.stringify({ method: 'turn/completed', params: { threadId: 'thr-tok', turn: { status: 'completed' } } })}\n`);
      }
    });

    const result = await compactCodexThread(binary, {
      missionId: 'm-tok',
      sessionId: 'thr-tok',
      scratch,
      timeoutMs: 10_000,
    });
    assert.deepEqual(result, {
      metadata: {
        method: 'thread/compact/start',
        context_compaction: true,
        pre_tokens: 48_000,
        post_tokens: 6_000,
      },
    });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('compactCodexThread: leaves post_tokens undefined when rollout is unchanged and no tokenUsage notification arrives', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'timon-codex-compact-stale-'));
  try {
    const sessDir = join(scratch, 'sessions', '2026', '10', '25');
    mkdirSync(sessDir, { recursive: true });
    const rollout = join(sessDir, 'rollout-2026-10-25.jsonl');
    writeFileSync(rollout, `${JSON.stringify({
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: { last_token_usage: { input_tokens: 52_000, output_tokens: 1_500 }, model_context_window: 200_000 },
      },
    })}\n`);

    const { binary } = makeFakeBinary((msg, emit) => {
      if (msg.id === 1) emit(`${JSON.stringify({ id: 1, result: {} })}\n`);
      if (msg.id === 2) emit(`${JSON.stringify({ id: 2, result: {} })}\n`);
      if (msg.id === 3) {
        emit(`${JSON.stringify({ id: 3, result: {} })}\n`);
        emit(`${JSON.stringify({ method: 'item/completed', params: { threadId: 'thr-stale', item: { type: 'contextCompaction' } } })}\n`);
        emit(`${JSON.stringify({ method: 'turn/completed', params: { threadId: 'thr-stale', turn: { status: 'completed' } } })}\n`);
      }
    });

    const result = await compactCodexThread(binary, {
      missionId: 'm-stale',
      sessionId: 'thr-stale',
      scratch,
      timeoutMs: 10_000,
    });
    assert.deepEqual(result, {
      metadata: {
        method: 'thread/compact/start',
        context_compaction: true,
        pre_tokens: 52_000,
      },
    });
    assert.equal(result.metadata.post_tokens, undefined);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('codex session.compact.run: injects profile env / API key and isolates named account profiles', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'timon-codex-dialect-'));
  try {
    const scratch = join(dir, 'scratch');
    const authDir = join(dir, 'auth');
    mkdirSync(scratch, { recursive: true });
    mkdirSync(authDir, { recursive: true });
    writeFileSync(join(authDir, 'auth.json'), JSON.stringify({ tokens: { access_token: 'fresh-tok' } }));

    const { binary, recorded } = makeFakeBinary((msg, emit) => {
      if (msg.id === 1) emit(`${JSON.stringify({ id: 1, result: {} })}\n`);
      if (msg.id === 2) emit(`${JSON.stringify({ id: 2, result: {} })}\n`);
      if (msg.id === 3) {
        emit(`${JSON.stringify({ id: 3, result: {} })}\n`);
        emit(`${JSON.stringify({ method: 'turn/completed', params: { threadId: 'thr-auth', turn: { status: 'completed' } } })}\n`);
      }
    });

    const provider = createCodexProvider(
      {
        binary,
        runtime: {
          usage: {
            isUsageNotSignedInError: () => false,
            UsageNotSignedInError: Error,
          },
          events: {
            extractInitSessionId: () => undefined,
          },
        },
        account: { of: (profile: { account?: unknown }) => profile?.account },
      } as never,
      { warn() {}, info() {}, error() {}, debug() {} } as never,
    );
    const run = provider.session.compact.run;

    // 1. API-key via ctx.env when host auth.json is present: auth.json is NOT linked and CODEX_API_KEY is forwarded
    await run({
      missionId: 'm-env-api',
      sessionId: 'thr-auth',
      scratch,
      env: { CODEX_AUTH_DIR: authDir, CODEX_API_KEY: 'sk-env-key' },
      profile: { id: 'codex', cmd: 'codex', env: {} },
      timeoutMs: 10_000,
    });
    assert.equal(recorded[0]!.opts.env?.CODEX_API_KEY, 'sk-env-key');
    assert.equal(recorded[0]!.opts.env?.CODEX_HOME, scratch);
    assert.equal(existsSync(join(scratch, 'auth.json')), false);

    // 2. API-key profile with custom profile.env
    await run({
      missionId: 'm-api',
      sessionId: 'thr-auth',
      scratch,
      env: { CODEX_AUTH_DIR: authDir },
      profile: { id: 'codex', cmd: 'codex', env: { OPENAI_BASE_URL: 'https://proxy.example', CODEX_API_KEY: 'sk-prof-key' } },
      timeoutMs: 10_000,
    });
    assert.equal(recorded[1]!.opts.env?.OPENAI_BASE_URL, 'https://proxy.example');
    assert.equal(recorded[1]!.opts.env?.CODEX_API_KEY, 'sk-prof-key');
    assert.equal(recorded[1]!.opts.env?.CODEX_HOME, scratch);
    assert.equal(existsSync(join(scratch, 'auth.json')), false);

    // 3. Named account profile: blanks CODEX_API_KEY and copies/links auth.json into scratch
    await run({
      missionId: 'm-acct',
      sessionId: 'thr-auth',
      scratch,
      env: { CODEX_AUTH_DIR: authDir },
      profile: {
        id: 'codex@work',
        cmd: 'codex',
        env: { CODEX_EXTRA: 'yes' },
        account: { id: 'work', name: 'Work', configDir: authDir },
      },
      timeoutMs: 10_000,
    });
    assert.equal(recorded[2]!.opts.env?.CODEX_API_KEY, '');
    assert.equal(recorded[2]!.opts.env?.CODEX_EXTRA, 'yes');
    assert.equal(recorded[2]!.opts.env?.CODEX_HOME, scratch);
    assert.match(readFileSync(join(scratch, 'auth.json'), 'utf8'), /fresh-tok/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
