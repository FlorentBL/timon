/**
 * A credential passed to a stdio MCP server as an argument (`--api-key xyz`,
 * `--token=xyz`, `--header "Authorization: Bearer xyz"`) is sealed in the vault
 * like a variable (TODO #1181): masked for every reader, kept by a masked save
 * while the command is unchanged, handed to the daemon's bridge only, never
 * written into a CLI's configuration, a log or an error.
 */
import './test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { hasSecretArgs, maskSecretArgs, namesSecret, secretArgSpot } from './mcp-arg-secrets.js';
import {
  MCP_DIR, deleteMcp, getMcp, listMcp, mcpStdioBridgeLaunch, migrateMcpHeadersToVault, missionTransport, presentMcpServer,
  redactMcpServer, resolveLaunchServers, stdioRelayTarget, upsertMcp, type McpStoredServer,
} from './mcp.js';
import { getSecret } from './secrets/store.js';
import { resolveMasterKey } from './secrets/key.js';
import { resetActiveModules, setActiveModules } from './kernel/module-state.js';

resolveMasterKey({ keyring: null });

const KEY = 'arg-secret-value-0123456789';

function fileOf(id: string): string {
  return readFileSync(join(MCP_DIR, `${id}.json`), 'utf8');
}

function argRefsOf(id: string): Record<string, string> {
  const s = getMcp(id);
  return s?.transport.type === 'stdio'
    ? Object.fromEntries(Object.entries(s.transport.args_secrets ?? {}).map(([k, ref]) => [k, ref.secret_id]))
    : {};
}

async function capturingLogs<T>(fn: () => T | Promise<T>): Promise<{ value: T; logs: string }> {
  const lines: string[] = [];
  const original = { warn: console.warn, log: console.log, error: console.error };
  const sink = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  console.warn = sink; console.log = sink; console.error = sink;
  try {
    return { value: await fn(), logs: lines.join('\n') };
  } finally {
    Object.assign(console, original);
  }
}

test('a credential is recognised by the flag or header naming it, not by its value', () => {
  for (const name of ['--api-key', '--apikey', '--token', '--access-token', '--github-personal-access-token', '--client-secret', '--password', '-key', 'Authorization', 'X-Api-Key']) {
    assert.equal(namesSecret(name), true, name);
  }
  for (const name of ['--key-file', '--token-url', '--auth-type', '--no-auth', '--keyboard', '--author', '--port', '--secret-env', '-y']) {
    assert.equal(namesSecret(name), false, name);
  }
  const args = ['-y', 'some-mcp', '--api-key', 'k1', '--token=k2', '--header', 'Authorization: Bearer k3', '--key-file', '/tmp/k', '--verbose'];
  assert.deepEqual(args.map((_, i) => secretArgSpot(args, i)?.prefix ?? null), [
    null, null, null, '', '--token=', null, 'Authorization: ', null, null, null,
  ]);
  assert.deepEqual(maskSecretArgs(args), ['-y', 'some-mcp', '--api-key', '***', '--token=***', '--header', 'Authorization: ***', '--key-file', '/tmp/k', '--verbose']);
  assert.equal(secretArgSpot(['--token', '--verbose'], 1), null, 'a flag after a flag is no value');
  assert.equal(hasSecretArgs(['-y', 'some-mcp']), false);
});

const ARGS = ['-y', 'some-mcp', '--api-key', KEY, '--header', `Authorization: Bearer ${KEY}-h`];

test('credential arguments go to the vault: the file and every reader see ***, the bridge the value', () => {
  const saved = upsertMcp({ id: 'arg-typed', transport: { type: 'stdio', command: 'npx', args: ARGS } });
  assert.ok(!fileOf('arg-typed').includes(KEY), 'the value is not in the server file');
  assert.ok(!JSON.stringify(saved).includes(KEY));
  const refs = argRefsOf('arg-typed');
  assert.deepEqual(Object.keys(refs).sort(), ['3', '5']);
  assert.equal(getSecret(refs['3']!)?.name, 'MCP_ARG_TYPED_ARG_3');
  assert.equal(getSecret(refs['3']!)?.grants.length, 0);
  const masked = ['-y', 'some-mcp', '--api-key', '***', '--header', 'Authorization: ***'];
  for (const view of [presentMcpServer(getMcp('arg-typed')!), redactMcpServer(getMcp('arg-typed')!)]) {
    assert.deepEqual(view.transport, { type: 'stdio', command: 'npx', args: masked });
  }
  assert.deepEqual(mcpStdioBridgeLaunch('arg-typed')?.args, ARGS);
  assert.ok(!stdioRelayTarget(getMcp('arg-typed')!.transport as never).includes(KEY), 'the route never derives from the value');
});

test('a server with a credential argument is bridged: the CLI gets the relay, never the argument', async () => {
  const bridged = await resolveLaunchServers(['arg-typed'], undefined, async () => ({ url: 'http://127.0.0.1:1/mcp-relay/r/a', headers: { 'x-timon-mcp-relay': 't' } }));
  assert.deepEqual(bridged, [{ type: 'http', name: 'arg-typed', url: 'http://127.0.0.1:1/mcp-relay/r/a', headers: { 'x-timon-mcp-relay': 't' } }]);
  // The bridge switched off: the launch writes the arguments read from the vault, as for variables.
  const plain = await resolveLaunchServers(['arg-typed'], () => null);
  assert.deepEqual(plain, [{ type: 'stdio', name: 'arg-typed', command: 'npx', args: ARGS, env: {} }]);
});

test('a masked save keeps the value; a new value replaces its secret; another command refuses the mask', () => {
  const masked = ['-y', 'some-mcp', '--api-key', '***', '--header', 'Authorization: ***'];
  const before = argRefsOf('arg-typed');
  upsertMcp({ id: 'arg-typed', description: 'edited', transport: { type: 'stdio', command: 'npx', args: masked } });
  assert.deepEqual(argRefsOf('arg-typed'), before);
  assert.deepEqual(mcpStdioBridgeLaunch('arg-typed')?.args, ARGS);

  upsertMcp({ id: 'arg-typed', transport: { type: 'stdio', command: 'npx', args: ['-y', 'some-mcp', '--api-key', 'new-key-456', '--header', 'Authorization: ***'] } });
  assert.equal(getSecret(before['3']!) ?? null, null, 'the replaced value is deleted from the vault');
  assert.equal(argRefsOf('arg-typed')['5'], before['5']);
  assert.equal(mcpStdioBridgeLaunch('arg-typed')?.args[3], 'new-key-456');

  assert.throws(
    () => upsertMcp({ id: 'arg-typed', transport: { type: 'stdio', command: 'curl', args: masked } }),
    (err: Error) => /args\.3 is the masked value/.test(err.message) && /command or args changed/.test(err.message) && !err.message.includes(KEY),
  );
  const refused = missionTransport(getMcp('arg-typed'), { type: 'stdio', command: 'npx', args: [...masked, '--endpoint', 'https://evil.example'] });
  assert.ok('refusal' in refused && /command or args changed/.test(refused.refusal));
  const kept = missionTransport(getMcp('arg-typed'), { type: 'stdio', command: 'npx', args: masked });
  assert.ok('transport' in kept);
});

test('removing the argument or the server deletes its secret', () => {
  const refs = argRefsOf('arg-typed');
  // Other arguments are another target: a mask is not carried there, the kept value is typed again.
  assert.throws(() => upsertMcp({ id: 'arg-typed', transport: { type: 'stdio', command: 'npx', args: ['-y', 'some-mcp', '--header', 'Authorization: ***'] } }));
  upsertMcp({ id: 'arg-typed', transport: { type: 'stdio', command: 'npx', args: ['-y', 'some-mcp', '--header', 'Authorization: Bearer again'] } });
  assert.equal(getSecret(refs['3']!) ?? null, null);
  assert.equal(getSecret(refs['5']!) ?? null, null);
  assert.deepEqual(Object.keys(argRefsOf('arg-typed')), ['3']);
  const last = argRefsOf('arg-typed')['3']!;
  deleteMcp('arg-typed');
  assert.equal(getSecret(last) ?? null, null);
});

test('vault off: the argument stays in the file, masked to readers; the vault back, the migration seals it', async () => {
  setActiveModules(['@timon/agents']);
  try {
    const { logs } = await capturingLogs(() => upsertMcp({ id: 'arg-off', transport: { type: 'stdio', command: 'npx', args: ['some-mcp', `--token=${KEY}`] } }));
    assert.match(logs, /arg-off: its credential arguments stay in its file/);
    assert.ok(!logs.includes(KEY));
    assert.ok(fileOf('arg-off').includes(KEY), 'nothing is lost');
    assert.equal(listMcp().find((s) => s.id === 'arg-off')?.held_back, 'vault_off');
    assert.deepEqual(redactMcpServer(getMcp('arg-off')!).transport, { type: 'stdio', command: 'npx', args: ['some-mcp', '--token=***'] });
    assert.ok('transport' in missionTransport(getMcp('arg-off'), { type: 'stdio', command: 'npx', args: ['some-mcp', '--token=***'] }));
  } finally {
    resetActiveModules();
  }
  const { value, logs } = await capturingLogs(() => migrateMcpHeadersToVault());
  assert.ok(value.moved.includes('arg-off'));
  assert.ok(!logs.includes(KEY));
  assert.ok(!fileOf('arg-off').includes(KEY));
  assert.deepEqual(mcpStdioBridgeLaunch('arg-off')?.args, ['some-mcp', `--token=${KEY}`]);
  const again = await capturingLogs(() => migrateMcpHeadersToVault());
  assert.ok(!again.value.moved.includes('arg-off'), 'idempotent');
  deleteMcp('arg-off');
});

test('a legacy file with a credential argument in clear is sealed at the next migration', async () => {
  mkdirSync(MCP_DIR, { recursive: true });
  const legacy: McpStoredServer = { id: 'arg-legacy', name: 'arg-legacy', transport: { type: 'stdio', command: 'npx', args: ['some-mcp', '--password', KEY] } };
  writeFileSync(join(MCP_DIR, 'arg-legacy.json'), JSON.stringify(legacy));
  await capturingLogs(() => migrateMcpHeadersToVault());
  assert.ok(!fileOf('arg-legacy').includes(KEY));
  assert.deepEqual(mcpStdioBridgeLaunch('arg-legacy')?.args, ['some-mcp', '--password', KEY]);
  const id = argRefsOf('arg-legacy')['2']!;
  deleteMcp('arg-legacy');
  assert.equal(getSecret(id) ?? null, null);
});

test('a file edited by hand so that the argument no longer matches its secret: the server is left out', async () => {
  upsertMcp({ id: 'arg-edited', transport: { type: 'stdio', command: 'npx', args: ['some-mcp', '--api-key', KEY] } });
  const record = JSON.parse(fileOf('arg-edited')) as McpStoredServer;
  assert.ok(record.transport.type === 'stdio');
  record.transport.args = ['some-mcp', '--api-key', 'typed-by-hand'];
  writeFileSync(join(MCP_DIR, 'arg-edited.json'), JSON.stringify(record));
  const { value, logs } = await capturingLogs(() => mcpStdioBridgeLaunch('arg-edited'));
  assert.equal(value, null);
  assert.match(logs, /argument 2 no longer matches/);
  assert.ok(!logs.includes(KEY));
  deleteMcp('arg-edited');
});
