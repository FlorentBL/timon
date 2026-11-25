/**
 * TODO #1094: `timon task get` and `timon status` say on stderr that the
 * mission waits on a card, while stdout stays the JSON a script reads. Witness
 * HTTP server on `127.0.0.1:0`, never the machine's daemon.
 */
import { mkdtempSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-cli-pending-permission-test-'));

const TIMON = fileURLToPath(new URL('../bin/timon', import.meta.url));
const MIN = 60_000;

function run(args: string[], body: unknown): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      const env = { ...process.env, TIMON_API: `http://127.0.0.1:${port}`, TIMON_RESOURCE_GUARD_ENABLED: '0' };
      delete env.TIMON_API_TOKEN;
      const child = spawn(process.execPath, [TIMON, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (c: Buffer | string) => { stdout += String(c); });
      child.stderr.on('data', (c: Buffer | string) => { stderr += String(c); });
      child.on('error', reject);
      child.on('close', (code) => server.close(() => resolve({ code, stdout, stderr })));
    });
  });
}

const waiting = () => ({
  kind: 'permission', tool_name: 'Bash', since: Date.now() - 3 * MIN,
  expires_at: Date.now() + 2 * MIN, remaining_ms: 2 * MIN + 30_000, count: 1,
});

test('task get prints the task on stdout and the wait on stderr', async () => {
  const task = { id: 'task-1', status: 'IN_PROGRESS', pending_permission: waiting() };
  const r = await run(['task', 'get', 'task-1'], { task });
  assert.equal(r.code, 0);
  assert.deepEqual(JSON.parse(r.stdout), task, 'stdout stays plain JSON');
  assert.match(r.stderr, /waiting for a permission \(Bash\) for 3 min, auto-deny in 2 min/);
});

test('status names a question, an endless wait and the other cards', async () => {
  const pending = { ...waiting(), kind: 'question', tool_name: 'ask_user', expires_at: null, remaining_ms: null, count: 2 };
  const r = await run(['status', 'mission-1'], { id: 'mission-1', pending_permission: pending });
  assert.equal(r.code, 0);
  assert.match(r.stderr, /waiting for an answer for 3 min, 2 cards open/);
  assert.doesNotMatch(r.stderr, /auto-deny/);
});

test('nothing on stderr when no card waits', async () => {
  const r = await run(['status', 'mission-1'], { id: 'mission-1', pending_permission: null });
  assert.equal(r.code, 0);
  assert.equal(r.stderr, '');
});
