/**
 * HTTP MCP servers in `session/new` (TODO #1179), end to end through `defineProvider(...).codec.openSession`
 * over in-memory pipes: declared as ACP's `McpServerHttp` to an agent that announced
 * `mcpCapabilities.http` at `initialize` (opencode 1.19 does, and connects with the headers given), left
 * out for one that did not (Hermes, agy), so a shape it may refuse never fails the whole session.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TMP_HOME = mkdtempSync(join(tmpdir(), 'timon-acp-mcp-http-'));
process.env.TIMON_HOME = TMP_HOME;
process.on('exit', () => rmSync(TMP_HOME, { recursive: true, force: true }));

const { defineProvider } = await import('./provider.js');
const { announcedMcp } = await import('./driver.js');
const { createAcpReplayPeer } = await import('../../../../packages/sdk/src/testing/acp-checks.js');
type Services = Parameters<typeof defineProvider>[0];

const STDIO = { type: 'stdio', name: 'local', command: 'node', args: ['s.mjs'], env: { K: 'v' } } as const;
const HTTP = { type: 'http', name: 'remote', url: 'http://127.0.0.1:3001/mcp-relay/x', headers: { 'X-Relay-Token': 'tok' } } as const;
const services = { mcp: async () => ({ servers: [STDIO, HTTP] }) } as unknown as Services;

/** Opens a session for an agent announcing `capabilities`; returns the `mcpServers` of its `session/new`. */
async function declared(capabilities: Record<string, unknown>): Promise<unknown> {
  const peer = createAcpReplayPeer([
    { on: 'initialize', reply: { protocolVersion: 1, agentCapabilities: capabilities, authMethods: [] } },
    { on: 'session/new', reply: { sessionId: 's-1' } },
  ]);
  const definition = defineProvider(services, { id: 'acme', args: ['acp'], binary: { names: ['acme-agent'] } });
  assert.equal(definition.codec.kind, 'driver');
  if (definition.codec.kind !== 'driver') return null;
  const spawn = {
    agentName: 'acme', systemPrompt: '', message: 'hi', resumeSession: null, missionId: `m-${Math.random()}`, cfg: { cwd: TMP_HOME },
  } as never;
  const driver = definition.codec.openSession({
    io: peer.io, spawn, host: { emit: () => undefined, requestPermission: async () => ({ allow: false }) }, profileId: 'acme',
  });
  try {
    await driver.start();
    const sessionNew = peer.received.find((m) => m.method === 'session/new');
    return (sessionNew?.params as { mcpServers?: unknown } | undefined)?.mcpServers;
  } finally {
    driver.close();
    peer.close();
  }
}

const STDIO_ENTRY = { name: 'local', command: 'node', args: ['s.mjs'], env: [{ name: 'K', value: 'v' }] };

test('an agent that announces mcpCapabilities.http is declared the HTTP servers, headers as name/value pairs', async () => {
  assert.deepEqual(await declared({ mcpCapabilities: { http: true, sse: true } }), [
    STDIO_ENTRY,
    { type: 'http', name: 'remote', url: HTTP.url, headers: [{ name: 'X-Relay-Token', value: 'tok' }] },
  ]);
});

test('an agent that announces no HTTP support is declared the stdio servers only', async () => {
  assert.deepEqual(await declared({}), [STDIO_ENTRY], 'nothing announced (Hermes, agy)');
  assert.deepEqual(await declared({ mcpCapabilities: { http: false, sse: true } }), [STDIO_ENTRY], 'sse alone is not http');
  assert.deepEqual(await declared({ mcpCapabilities: { http: 'yes' } }), [STDIO_ENTRY], 'only a literal true counts');
});

test('the announcement is read from agentCapabilities, whatever else the handshake carries', () => {
  assert.deepEqual(announcedMcp({ agentCapabilities: { mcpCapabilities: { http: true } } }), { http: true });
  assert.deepEqual(announcedMcp({ mcpCapabilities: { http: true } }), { http: false }, 'a top-level key is not the agent\'s capability');
  assert.deepEqual(announcedMcp({ agentCapabilities: null }), { http: false });
  assert.deepEqual(announcedMcp({}), { http: false });
});
