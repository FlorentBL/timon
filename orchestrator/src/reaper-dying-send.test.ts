/**
 * A reply in a conversation the reaper is stopping (TIM-0167).
 *
 * The idle reap sends SIGTERM and the entry stays in `running` until the CLI
 * exits. A message arriving in that window was written to the dying process, or
 * answered 404 `mission_not_running`, and the chat then spawned a twin mission
 * on the same session. The fake CLI here takes 100 ms to exit after its SIGTERM.
 */
import './test-home.js';
import '../tests/helpers/paid-license.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { tmpdir } from 'node:os';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import express from 'express';

const MIN = 60_000;

process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';
process.env.TIMON_REAP_CHAT_IDLE_MS = String(60 * MIN);

const { getHost } = await import('./host/index.js');
await import('../tests/helpers/claude-provider.js');
const { spawnAgent, upsertAgent, reapStaleMissions, killAgent } = await import('./agent.js');
const { dbApi } = await import('./db.js');
const { invalidateSettingsCache } = await import('./settings.js');
const { registerRoutes } = await import('./plugins-bundled/missions/routes.js');

type FakeChild = ChildProcessWithoutNullStreams & { signals: string[]; written: () => string };

/** A CLI that takes a moment to die: the window the reply falls into. */
function slowDyingChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  (child as { pid: number }).pid = process.pid; // alive for the reaper's liveness probe
  (child as { exitCode: number | null }).exitCode = null;
  (child as { signalCode: NodeJS.Signals | null }).signalCode = null;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  const input: string[] = [];
  child.stdin.on('data', (chunk: Buffer) => input.push(chunk.toString()));
  child.written = () => input.join('');
  child.signals = [];
  child.kill = ((signal?: NodeJS.Signals | number) => {
    const name = typeof signal === 'string' ? signal : 'SIGTERM';
    child.signals.push(name);
    if (child.signals.length === 1) {
      setTimeout(() => {
        (child as { signalCode: NodeJS.Signals | null }).signalCode = name as NodeJS.Signals;
        child.emit('exit', null, name);
        child.emit('close', null, name);
      }, 100);
    }
    return true;
  }) as ChildProcessWithoutNullStreams['kill'];
  return child;
}

const AGENT = 'tim0167.witness';
upsertAgent({
  name: AGENT,
  system_prompt: 'witness — does nothing.',
  config: { backend: 'claude', model: 'opus', cwd: tmpdir(), skills: [], mcp_servers: [], memory_scope: 'NONE' },
});

const host = getHost();
const originalSpawn = host.spawn;
const children: FakeChild[] = [];
host.spawn = (() => {
  const child = slowDyingChild();
  children.push(child);
  return child;
}) as typeof host.spawn;

const tick = (ms = 20): Promise<void> => new Promise((r) => setTimeout(r, ms));
const line = (obj: unknown): string => `${JSON.stringify(obj)}\n`;
const RESULT = {
  type: 'result', subtype: 'success', is_error: false, num_turns: 1, duration_ms: 100, total_cost_usd: 0.1,
  usage: { input_tokens: 10, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
};

/** A chat whose first turn is over, on provider session `session`. */
async function idleChat(session: string): Promise<{ missionId: string; child: FakeChild }> {
  const missionId = await spawnAgent(AGENT, 'hello', { channel: 'chat' });
  const child = children[children.length - 1]!;
  child.stdout.write(line({ type: 'system', subtype: 'init', session_id: session, tools: [], mcp_servers: [] }));
  child.stdout.write(line(RESULT));
  await tick(40);
  assert.equal(dbApi.getMission(missionId)?.session_id, session);
  return { missionId, child };
}

async function post(path: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const app = express();
  app.use(express.json());
  registerRoutes(app);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const { port } = server.address() as AddressInfo;
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() as Record<string, unknown> };
  } finally {
    server.close();
  }
}

const runningOfAgent = (): string[] =>
  dbApi.listRunningMissions().filter((m) => m.agent_name === AGENT).map((m) => m.id);

test.afterEach(async () => {
  for (const id of runningOfAgent()) killAgent(id, { source: 'test' });
  await tick(150);
});

test('a reply sent between the reaper SIGTERM and the exit resumes the same mission', async () => {
  const { missionId, child } = await idleChat('tim0167-session-a');
  invalidateSettingsCache();
  reapStaleMissions([], Date.now() + 61 * MIN);
  assert.deepEqual(child.signals, ['SIGTERM'], 'the reaper stopped the chat');
  assert.ok(!child.signalCode, 'still exiting: the window of the incident');

  const spawned = children.length;
  const reply = await post(`/api/agents/${missionId}/send`, { input: 'are you still there?\n' });
  assert.equal(reply.status, 200, JSON.stringify(reply.body));
  assert.equal(reply.body.resumed, true);
  assert.equal(children.length, spawned + 1, 'one new process, for the same mission');
  assert.ok(!child.written().includes('are you still there?'), 'nothing written to the dying CLI');
  assert.ok(children[children.length - 1]!.written().includes('are you still there?'));
  assert.equal(dbApi.getMission(missionId)?.status, 'running');
  assert.deepEqual(runningOfAgent(), [missionId], 'no twin mission');
});

test('a send to a mission that does not exist says so, the one case the chat may start over', async () => {
  const res = await post('/api/agents/00000000-0000-4000-8000-000000000000/send', { input: 'hi' });
  assert.equal(res.status, 404);
  assert.equal(res.body.code, 'mission_not_found');
});

test.after(() => {
  host.spawn = originalSpawn;
});
