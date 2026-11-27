import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import type { AddressInfo } from 'node:net';

async function harness(t: TestContext, respond: (path: string, body: any) => { status?: number; body: unknown }) {
  const requests: { path: string; auth?: string; body: any }[] = [];
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const part of req) raw += part;
    const body = JSON.parse(raw);
    requests.push({ path: req.url!, auth: req.headers.authorization, body });
    const out = respond(req.url!, body);
    res.statusCode = out.status ?? 200;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(out.body));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => server.close());
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const child = spawn(process.execPath, [fileURLToPath(new URL('../bin/computer-mcp.mjs', import.meta.url))], {
    env: { ...process.env, TIMON_API_TOKEN: 'mission-token', TIMON_ORCH_URL: origin }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(() => { child.kill(); });
  let id = 0;
  const replies = new Map<number, (value: any) => void>();
  createInterface({ input: child.stdout }).on('line', (line) => { const v = JSON.parse(line); replies.get(v.id)?.(v); replies.delete(v.id); });
  const call = (method: string, params?: unknown) => new Promise<any>((resolve, reject) => {
    const n = ++id;
    const timer = setTimeout(() => reject(new Error('MCP reply timed out')), 5000);
    replies.set(n, (v) => { clearTimeout(timer); resolve(v); });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: n, method, params })}\n`);
  });
  return { requests, call };
}

test('computer MCP lists the ten tools and warns about screenshots and passwords', async (t) => {
  const { call } = await harness(t, () => ({ body: {} }));
  const { result } = await call('tools/list');
  assert.deepEqual(result.tools.map((x: any) => x.name).sort(), [
    'computer_click', 'computer_cursor_position', 'computer_double_click', 'computer_drag', 'computer_key',
    'computer_move', 'computer_screenshot', 'computer_scroll', 'computer_type', 'computer_wait',
  ]);
  const text = result.tools.map((x: any) => x.description).join(' ');
  assert.match(text, /screenshot/i);
  assert.match(text, /Never type a password/);
});

test('computer MCP posts to /api/computer/:command with the mission token and returns screenshots as images', async (t) => {
  const { requests, call } = await harness(t, (path) => path.endsWith('/screenshot')
    ? { body: { ok: true, result: { mimeType: 'image/png', data: 'AAAA', width: 10, height: 5 } } }
    : { body: { ok: true, result: { clicked: true } } });
  const shot = await call('tools/call', { name: 'computer_screenshot', arguments: {} });
  assert.deepEqual(shot.result.content[0], { type: 'image', data: 'AAAA', mimeType: 'image/png' });
  const click = await call('tools/call', { name: 'computer_click', arguments: { x: 1, y: 2 } });
  assert.match(click.result.content[0].text, /clicked/);
  assert.deepEqual(requests.map((r) => [r.path, r.auth, r.body]), [
    ['/api/computer/screenshot', 'Bearer mission-token', {}],
    ['/api/computer/click', 'Bearer mission-token', { x: 1, y: 2 }],
  ]);
});

test('computer MCP surfaces a daemon refusal as a tool error', async (t) => {
  const { call } = await harness(t, () => ({ status: 403, body: { error: 'computer_use_disabled', message: 'Computer use is turned off for this agent.' } }));
  const out = await call('tools/call', { name: 'computer_move', arguments: { x: 1, y: 1 } });
  assert.equal(out.result.isError, true);
  assert.match(out.result.content[0].text, /turned off/);
});
