/**
 * TODO #1071 — the daemon runs a stdio MCP server with variables behind its relay only for an
 * agent that can be handed an HTTP server. An ACP agent (opencode, Hermes) is declared the stdio
 * servers alone (`serializeAcpMcpServers`): there it keeps the server, its variables sealed on the
 * plugin's side, as with the setting off. With the setting off, every backend gets that.
 */
import '../test-home.js';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BuildSpawnOpts, Dialect } from './types.js';

const { resolveMasterKey } = await import('../secrets/key.js');
const { upsertMcp } = await import('../mcp.js');
const { registerDialect, registerProfile, registerProvider, backendTakesHttpMcp } = await import('./registry.js');
const { defineProvider } = await import('./acp/provider.js');
const { openLaunchSeal, closeLaunchSeal } = await import('./launch-seal.js');
const { providerMcpPlan } = await import('./provider-mcp.js');
const { serializeAcpMcpServers } = await import('./mcp-serialize.js');
const { stdioBridges } = await import('../mcp-stdio-bridges.js');
const { invalidateSettingsCache } = await import('../settings.js');

// The relay mints its tokens with the vault's key.
resolveMasterKey({ keyring: null });

const SECRET = 'bridge-choice-secret-value-5d1e';
const dir = mkdtempSync(join(tmpdir(), 'timon-bridge-choice-'));
const SERVER = join(dir, 'idle-mcp.mjs');
// Never answers: the bridge only has to start it.
writeFileSync(SERVER, 'process.stdin.resume();\n');
upsertMcp({ id: 'choice-stdio', transport: { type: 'stdio', command: process.execPath, args: [SERVER], env: { CHOICE_SECRET: SECRET } } });

const OWNER = 'bridge-choice-test';
// A CLI that reads an MCP configuration with HTTP servers (claude, codex, grok, copilot).
const linesDialect: Dialect = {
  defaultCmd: 'acme-lines-cli',
  persistentProcess: false,
  finishMissionOnExit: false,
  sessionResumable: false,
  sessionStore: 'per-mission',
  permissionModel: 'none',
  rateLimitReporting: 'none',
  hostedConnectors: false,
  async buildSpawn(opts, profile) {
    return { cmd: profile.cmd, args: [], env: { ...profile.env }, cwd: opts.cfg.cwd, initialStdin: null };
  },
  writeUserInput() { /* nothing to write */ },
  parseLine: () => [],
  extractSessionId: () => null,
};
registerDialect(OWNER, 'choice-lines', linesDialect);
registerProfile(OWNER, { id: 'choice-lines-profile', label: 'Lines', vendor: 'Acme', dialect: 'choice-lines', models: [], defaultModel: null });

// An agent written as an ACP row, spread the way a plugin adds a member to it.
const acp = defineProvider({ mcp: async () => { throw new Error('not called here'); } }, {
  id: 'choice-acp', args: ['acp'], binary: { names: ['choice-acp'] },
});
registerProvider(OWNER, { ...acp });
registerProfile(OWNER, { id: 'choice-acp-profile', label: 'ACP', vendor: 'Acme', dialect: 'choice-acp', models: [], defaultModel: null });

const cwd = mkdtempSync(join(tmpdir(), 'timon-bridge-choice-cwd-'));
let n = 0;

async function planFor(backend: string) {
  const missionId = `bridge-choice-${++n}`;
  const spawn: BuildSpawnOpts = {
    agentName: 'choice.agent', missionId, systemPrompt: '', message: '', resumeSession: null,
    cfg: { cwd, browser_profile_id: null, mcp_servers: ['choice-stdio'] }, readOnlyTools: true,
  };
  const seal = openLaunchSeal(missionId, backend, spawn, () => 'mission-token');
  // The test runner's marker: a node child that inherits it believes it is a test file.
  const marker = process.env.NODE_TEST_CONTEXT;
  delete process.env.NODE_TEST_CONTEXT;
  try {
    const plan = await providerMcpPlan({ spawn, seal });
    const user = plan.servers.filter((s) => s.role === 'user');
    assert.equal(user.length, 1, 'the user\'s server is in the plan');
    return { plan, server: user[0]!, seal, missionId };
  } finally {
    if (marker !== undefined) process.env.NODE_TEST_CONTEXT = marker;
    closeLaunchSeal(seal);
  }
}

function setBridge(value: string | undefined): void {
  if (value === undefined) delete process.env.TIMON_MCP_STDIO_BRIDGE;
  else process.env.TIMON_MCP_STDIO_BRIDGE = value;
  invalidateSettingsCache();
}

after(() => {
  stdioBridges.stopAll();
  setBridge(undefined);
});

test('the registry reads the ACP mark off the codec, a spread definition included', () => {
  assert.equal(backendTakesHttpMcp('choice-acp-profile'), false);
  assert.equal(backendTakesHttpMcp('choice-acp-profile@0123456789'), false, 'an account instance reads its backend');
  assert.equal(backendTakesHttpMcp('choice-lines-profile'), true);
  assert.equal(backendTakesHttpMcp('nobody-registered-this'), true);
});

test('a backend that takes an HTTP MCP server gets the stdio server through the relay, its variable in the daemon', async () => {
  setBridge(undefined);
  const { server, missionId } = await planFor('choice-lines-profile');
  assert.equal(server.type, 'http');
  assert.ok(server.type === 'http' && server.url.includes('/mcp-relay/'), 'the daemon\'s relay');
  assert.equal(JSON.stringify(server).includes(SECRET), false);
  assert.equal(JSON.stringify(server).includes('CHOICE_SECRET'), false);
  assert.ok(stdioBridges.get(missionId, 'choice-stdio')?.alive, 'the daemon started the server');
});

test('an ACP backend gets the stdio server with its variables, sealed, and no bridge is started', async () => {
  setBridge(undefined);
  const { server, seal, missionId } = await planFor('choice-acp-profile');
  assert.equal(server.type, 'stdio');
  assert.ok(server.type === 'stdio');
  const ref = server.env.CHOICE_SECRET;
  assert.ok(ref && ref !== SECRET, 'a reference, never the value');
  assert.equal(seal.resolve(ref), SECRET, 'the reference stands for the variable');
  const { servers, skipped } = serializeAcpMcpServers([server]);
  assert.deepEqual(skipped, []);
  assert.equal(servers.length, 1, 'declared in session/new');
  assert.equal(stdioBridges.get(missionId, 'choice-stdio'), undefined);
});

test('the setting off: every backend gets the stdio server with its variables, as before', async () => {
  setBridge('0');
  try {
    for (const backend of ['choice-lines-profile', 'choice-acp-profile']) {
      const { server, seal, missionId } = await planFor(backend);
      assert.equal(server.type, 'stdio', backend);
      assert.ok(server.type === 'stdio');
      assert.equal(seal.resolve(server.env.CHOICE_SECRET ?? ''), SECRET, backend);
      assert.equal(stdioBridges.get(missionId, 'choice-stdio'), undefined, backend);
    }
  } finally {
    setBridge(undefined);
  }
});
