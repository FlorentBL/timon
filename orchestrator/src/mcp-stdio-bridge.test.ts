/**
 * The daemon's bridge of a stdio MCP server with variables (TODO #1071): the
 * CLI's configuration holds a relay address and token, never a variable; the
 * relay refuses an anonymous caller and a token of another mission; the
 * process the daemon started speaks streamable HTTP on one side and JSON-RPC
 * lines on the other; and it ends with its mission.
 */
import './test-home.js';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { request, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { bus } from './bus.js';
import { dbApi } from './db.js';
import { isBridgedStdioMcp, mcpStdioBridgeLaunch, resolveLaunchServers, stdioRelayTarget, upsertMcp } from './mcp.js';
import { createMcpRelayMiddleware } from './mcp-relay-server.js';
import { MCP_RELAY_HEADER, mcpRelayLaunchTarget } from './mcp-relay.js';
import { serializeCodexMcpToml, serializeGrokMcpToml, serializeMcpJson } from './backends/mcp-serialize.js';
import { StdioBridgeManager, MAX_BRIDGES_PER_MISSION, type StdioBridgeSpec } from './mcp-stdio-bridge.js';
import { leftOutMessage, startStdioBridge, startStdioBridgeLifecycle, stdioBridges } from './mcp-stdio-bridges.js';
import { decodeDaemonMessage } from './daemon-message.js';
import { resolveMasterKey } from './secrets/key.js';

resolveMasterKey({ keyring: null });

const SECRET = 'stdio-secret-value-0123456789abcdef';

// A minimal MCP server on stdio: refuses a call before its handshake, prints a stray log line first.
const dir = mkdtempSync(join(tmpdir(), 'timon-stdio-bridge-'));
const SERVER = join(dir, 'fake-mcp.mjs');
writeFileSync(SERVER, `
import { createInterface } from 'node:readline';
let ready = false;
const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
process.stdout.write('fake server starting\\n');
process.stderr.write('stderr noise ' + (process.env.BRIDGE_SECRET ?? '') + '\\n');
createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  if (m.method === 'initialize') return send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' }, client: m.params.clientInfo.name } });
  if (m.method === 'notifications/initialized') { ready = true; return; }
  if (m.id === undefined) return;
  if (!ready) return send({ jsonrpc: '2.0', id: m.id, error: { code: -32002, message: 'not initialized' } });
  if (m.method === 'tools/list') return send({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'secret' }] } });
  if (m.method === 'tools/call' && m.params.name === 'secret') return send({ jsonrpc: '2.0', id: m.id, result: { value: process.env.BRIDGE_SECRET, cwd: process.cwd() } });
  if (m.method === 'tools/call' && m.params.name === 'pid') return send({ jsonrpc: '2.0', id: m.id, result: { pid: process.pid } });
  if (m.method === 'tools/call' && m.params.name === 'progress') {
    send({ jsonrpc: '2.0', method: 'notifications/progress', params: { progress: 1 } });
    return send({ jsonrpc: '2.0', id: m.id, result: { done: true } });
  }
  send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'unknown' } });
});
`);

// Everything the daemon prints: searched for the variable at the end.
const logged: string[] = [];
for (const level of ['log', 'warn', 'error', 'info'] as const) {
  const original = console[level].bind(console);
  console[level] = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); original(...args); };
}

// The test runner's marker: a node child that inherits it believes it is a test file and speaks TAP.
const { NODE_TEST_CONTEXT: _runnerMarker, ...childEnv } = process.env;

const CWD = mkdtempSync(join(tmpdir(), 'timon-stdio-bridge-cwd-'));
upsertMcp({ id: 'secret-stdio', transport: { type: 'stdio', command: process.execPath, args: [SERVER], env: { BRIDGE_SECRET: SECRET } } });
upsertMcp({ id: 'plain-stdio', transport: { type: 'stdio', command: process.execPath, args: [SERVER] } });

const missions: Record<string, string> = { 'm-alice': 'alice', 'm-alice-2': 'alice', 'm-bob': 'bob' };
const testBridges = new StdioBridgeManager({
  spawn: (spec: StdioBridgeSpec) => spawn(spec.command, spec.args, { cwd: spec.cwd ?? CWD, env: { ...childEnv, ...spec.env }, stdio: ['pipe', 'pipe', 'pipe'] }),
  stop: (child) => child.kill('SIGTERM'),
});
const app = express();
app.use(createMcpRelayMiddleware({
  missionAgent: (id) => missions[id] ?? null,
  attached: (missionId, agent) => missions[missionId] === agent,
  bridge: async (missionId, _agent, serverId) => {
    const launch = mcpStdioBridgeLaunch(serverId);
    if (!launch) return null;
    const got = await testBridges.ensure(missionId, serverId, launch.target, () => ({ ...launch, cwd: CWD }));
    return 'bridge' in got ? got.bridge : null;
  },
}));
app.use((_req, res) => { res.status(418).json({ fell: 'through' }); });
const relayServer = app.listen(0, '127.0.0.1');
await once(relayServer, 'listening');
const relayPort = (relayServer.address() as AddressInfo).port;

after(() => {
  testBridges.stopAll();
  stdioBridges.stopAll();
  relayServer.close();
});

function target(agent = 'alice', missionId = 'm-alice') {
  const launch = mcpStdioBridgeLaunch('secret-stdio');
  assert.ok(launch);
  const minted = mcpRelayLaunchTarget({ id: 'secret-stdio', url: launch.target }, { agent, missionId }, { port: relayPort });
  assert.ok(minted, 'a relay target');
  return minted;
}

type Reply = { status: number; headers: IncomingHttpHeaders; body: string };

function call(url: string, options: { method?: string; headers?: Record<string, string>; body?: unknown } = {}): Promise<Reply> {
  const parsed = new URL(url);
  return new Promise((resolve, reject) => {
    const req = request({
      host: '127.0.0.1', port: relayPort, path: parsed.pathname, method: options.method ?? 'POST',
      headers: { host: `127.0.0.1:${relayPort}`, 'content-type': 'application/json', accept: 'application/json', ...(options.headers ?? {}) },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(options.body === undefined ? undefined : JSON.stringify(options.body));
  });
}

const INIT = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'cli', version: '1' } } };

function gone(pid: number): boolean {
  try { process.kill(pid, 0); return false; } catch { return true; }
}

async function waitGone(pid: number): Promise<boolean> {
  for (let i = 0; i < 100; i++) {
    if (gone(pid)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

test('only a stdio server with variables is bridged; its route follows its command', () => {
  assert.equal(isBridgedStdioMcp('secret-stdio'), true);
  assert.equal(isBridgedStdioMcp('plain-stdio'), false, 'nothing to hide: the CLI starts it as before');
  assert.equal(isBridgedStdioMcp('../etc'), false);
  assert.notEqual(stdioRelayTarget({ command: 'a', args: ['b'] }), stdioRelayTarget({ command: 'a', args: ['c'] }));
});

test('the configuration written for every CLI holds the relay, never the variable', async () => {
  const started: string[] = [];
  const servers = await resolveLaunchServers(
    ['secret-stdio', 'plain-stdio'],
    () => null,
    async (server) => { started.push(server.id); return { url: 'http://127.0.0.1:1/mcp-relay/r/alice', headers: { [MCP_RELAY_HEADER]: 'tok' } }; },
  );
  assert.deepEqual(started, ['secret-stdio']);
  const bridged = servers.find((s) => s.name === 'secret-stdio');
  assert.equal(bridged?.type, 'http');
  for (const text of [serializeMcpJson(servers), serializeCodexMcpToml(servers), serializeGrokMcpToml(servers)]) {
    assert.ok(text);
    assert.equal(text.includes(SECRET), false, 'the variable is in no CLI configuration');
    assert.equal(text.includes('BRIDGE_SECRET'), false);
  }
});

test('FAIL-CLOSED: a bridge that does not start leaves the server out, never written in clear', async () => {
  const servers = await resolveLaunchServers(['secret-stdio'], () => null, async () => null);
  assert.deepEqual(servers, []);
  const nothing = await resolveLaunchServers(['secret-stdio'], () => null, async () => null);
  assert.equal(JSON.stringify(nothing).includes(SECRET), false);
});

test('REFUSAL: anonymous, forged, another agent\'s token — one 403, the process is never started', async () => {
  const alice = target();
  const bob = target('bob', 'm-bob');
  const anonymous = await call(alice.url, { body: INIT });
  assert.equal(anonymous.status, 403);
  const forged = await call(alice.url, { headers: { [MCP_RELAY_HEADER]: alice.headers[MCP_RELAY_HEADER]!.replace('m-alice', 'm-alice-2') }, body: INIT });
  assert.equal(forged.status, 403, 'a token rewritten for another mission is refused');
  const bobOnAlice = await call(alice.url, { headers: bob.headers, body: INIT });
  assert.equal(bobOnAlice.status, 403, 'a token of another agent\'s mission is refused');
  const bobPath = new URL(bob.url);
  const aliceOnBob = await call(`http://127.0.0.1:${relayPort}${bobPath.pathname}`, { headers: alice.headers, body: INIT });
  assert.equal(aliceOnBob.status, 403);
  assert.equal(testBridges.size, 0, 'no refused request started a process');
});

test('initialize, then a call: the variable reaches the server and its answer comes back as JSON or a stream', async () => {
  const t = target();
  const init = await call(t.url, { headers: t.headers, body: INIT });
  assert.equal(init.status, 200);
  assert.equal(JSON.parse(init.body).result.serverInfo.name, 'fake');
  const notified = await call(t.url, { headers: t.headers, body: { jsonrpc: '2.0', method: 'notifications/initialized' } });
  assert.equal(notified.status, 202);
  const secret = await call(t.url, { headers: t.headers, body: { jsonrpc: '2.0', id: 'a', method: 'tools/call', params: { name: 'secret' } } });
  assert.equal(secret.status, 200);
  const answer = JSON.parse(secret.body);
  assert.equal(answer.id, 'a');
  assert.equal(answer.result.value, SECRET, 'the daemon gave the server its variable');
  const streamed = await call(t.url, {
    headers: { ...t.headers, accept: 'application/json, text/event-stream' },
    body: { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'progress' } },
  });
  assert.match(String(streamed.headers['content-type']), /text\/event-stream/);
  const events = streamed.body.split('\n\n').filter(Boolean).map((e) => JSON.parse(e.split('data: ')[1]!));
  assert.equal(events[0].method, 'notifications/progress', 'a notification of the call travels on its stream');
  assert.deepEqual(events.at(-1), { jsonrpc: '2.0', id: 2, result: { done: true } });
  const batch = await call(t.url, { headers: t.headers, body: [{ jsonrpc: '2.0', id: 3, method: 'tools/list' }, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'nope' } }] });
  const answers = JSON.parse(batch.body) as Array<{ id: number }>;
  assert.deepEqual(answers.map((a) => a.id).sort(), [3, 4]);
  const del = await call(t.url, { method: 'DELETE', headers: t.headers });
  assert.equal(del.status, 405, 'the session lives as long as the mission, not the client');
});

test('a process the CLI never initialized (daemon restarted) gets the bridge\'s own handshake first', async () => {
  const t = target('alice', 'm-alice-2');
  const list = await call(t.url, { headers: t.headers, body: { jsonrpc: '2.0', id: 9, method: 'tools/list' } });
  assert.equal(list.status, 200);
  assert.deepEqual(JSON.parse(list.body).result.tools, [{ name: 'secret' }]);
  testBridges.stopMission('m-alice-2');
});

test('a new initialize on the same mission restarts the server from a clean state', async () => {
  const t = target();
  const first = JSON.parse((await call(t.url, { headers: t.headers, body: { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'pid' } } })).body).result.pid as number;
  await call(t.url, { headers: t.headers, body: INIT });
  await call(t.url, { headers: t.headers, body: { jsonrpc: '2.0', method: 'notifications/initialized' } });
  const second = JSON.parse((await call(t.url, { headers: t.headers, body: { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'pid' } } })).body).result.pid as number;
  assert.notEqual(first, second);
  assert.ok(await waitGone(first), 'the previous process ended');
  testBridges.stopMission('m-alice');
  assert.ok(await waitGone(second), 'stopping the mission ends its process');
});

test('caps: no more than the per-mission limit of bridges', async () => {
  const manager = new StdioBridgeManager({
    spawn: () => spawn(process.execPath, [SERVER], { env: childEnv, stdio: ['pipe', 'pipe', 'pipe'] }),
    stop: (child) => child.kill('SIGTERM'),
  });
  const spec = () => ({ command: process.execPath, args: [SERVER], env: {}, cwd: CWD });
  for (let i = 0; i < MAX_BRIDGES_PER_MISSION; i++) {
    assert.ok('bridge' in await manager.ensure('m-cap', `s${i}`, 'fp', spec));
  }
  const refused = await manager.ensure('m-cap', 'one-more', 'fp', spec);
  assert.ok('reason' in refused && /already runs/.test(refused.reason));
  manager.stopAll();
  assert.equal(manager.size, 0);
});

test('a command that does not exist does not start, and says so', async () => {
  const manager = new StdioBridgeManager({
    spawn: (spec) => spawn(spec.command, spec.args, { stdio: ['pipe', 'pipe', 'pipe'] }),
    stop: (child) => child.kill('SIGTERM'),
  });
  const refused = await manager.ensure('m-x', 's', 'fp', () => ({ command: join(dir, 'missing-binary'), args: [], env: {}, cwd: null }));
  assert.ok('reason' in refused && refused.reason === 'ENOENT');
  assert.equal(manager.size, 0);
});

test('the daemon\'s own bridge, through the host: started at launch, in the mission\'s folder, ended with the mission', async () => {
  const stop = startStdioBridgeLifecycle();
  try {
    dbApi.createMission('m-life', 'alice', 'bridge life cycle');
    const launch = mcpStdioBridgeLaunch('secret-stdio')!;
    const marker = process.env.NODE_TEST_CONTEXT;
    delete process.env.NODE_TEST_CONTEXT;
    try {
      assert.equal(await startStdioBridge('m-life', 'alice', { id: 'secret-stdio', target: launch.target }, CWD), true);
    } finally {
      if (marker !== undefined) process.env.NODE_TEST_CONTEXT = marker;
    }
    const bridge = stdioBridges.get('m-life', 'secret-stdio');
    assert.ok(bridge?.alive);
    // Talk to it directly, as the relay would.
    const app2 = express();
    app2.post('/x', express.raw({ type: '*/*' }), (req, res) => { void bridge.post(req, res, req.body as Buffer); });
    const srv = app2.listen(0, '127.0.0.1');
    await once(srv, 'listening');
    const port = (srv.address() as AddressInfo).port;
    const reply = await new Promise<string>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, path: '/x', method: 'POST', headers: { 'content-type': 'application/json' } }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      });
      req.on('error', reject);
      req.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'pid' } }));
    });
    srv.close();
    const pid = JSON.parse(reply).result.pid as number;
    assert.equal(gone(pid), false);
    bus.publish({ kind: 'mission_complete', missionId: 'm-life', status: 'completed', exitCode: 0 });
    assert.ok(await waitGone(pid), 'the process ended with its mission');
    assert.equal(stdioBridges.get('m-life', 'secret-stdio'), undefined);
  } finally {
    stop();
  }
});

test('a server left out raises a notice the webview translates, naming no variable', async () => {
  upsertMcp({ id: 'gone-stdio', transport: { type: 'stdio', command: join(dir, 'missing-binary'), args: [], env: { BRIDGE_SECRET: SECRET } } });
  dbApi.createMission('m-gone', 'alice', 'left out');
  const launch = mcpStdioBridgeLaunch('gone-stdio')!;
  assert.equal(await startStdioBridge('m-gone', 'alice', { id: 'gone-stdio', target: launch.target }, CWD), false);
  const card = dbApi.listNotifications({ limit: 50 }).find((n) => n.title === 'MCP server gone-stdio left out');
  assert.ok(card, 'the notice is written');
  const code = decodeDaemonMessage(card.message_code);
  assert.equal(code?.code, 'mcp_server_left_out');
  assert.equal(code?.params.serverId, 'gone-stdio');
  assert.equal(code?.params.cause, 'start');
  assert.ok(!JSON.stringify(card).includes(SECRET));
});

test('each reason of a left-out server maps to a cause the locales name', () => {
  const cases: Array<[string, string, number]> = [
    ['its variables cannot be read from the secrets vault', 'vault', 0],
    ['this mission already runs 8 bridged MCP servers', 'mission_limit', 8],
    ['the daemon already runs 48 bridged MCP servers', 'daemon_limit', 48],
    ['restarted too often', 'restarts', 0],
    ['stopped', 'stopped', 0],
    ['EACCES', 'start', 0],
  ];
  for (const [reason, cause, max] of cases) {
    assert.deepEqual(leftOutMessage('s', reason).params, { serverId: 's', cause, max, detail: reason });
  }
});

test('LOGS: the variable is never printed', () => {
  assert.equal(logged.some((line) => line.includes(SECRET)), false);
});
