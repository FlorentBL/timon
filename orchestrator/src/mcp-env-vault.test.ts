/**
 * The variables of a stdio MCP server live in the vault, not in
 * `~/.timon/mcp/<id>.json` (TODO #1071): stored there, read back masked by
 * every reader, carried over by a masked save while the command is unchanged,
 * read by the daemon's bridge only, moved there from an older file — and, when
 * the vault cannot take them, left in the file without loss, the server held
 * back, no value in any log or error.
 */
import './test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MCP_DIR, deleteMcp, getMcp, listMcp, mcpStdioBridgeLaunch, migrateMcpHeadersToVault, missionTransport, presentMcpServer,
  redactMcpServer, resolveLaunchServers, upsertMcp, type McpStoredServer,
} from './mcp.js';
import { getSecret, readSecretValue, resetRotationCheck, updateSecret } from './secrets/store.js';
import { resetMasterKeyCache, resolveMasterKey } from './secrets/key.js';
import { SECRET_KEY_FILE } from './paths.js';
import { resetActiveModules, setActiveModules } from './kernel/module-state.js';

resolveMasterKey({ keyring: null });

const STDIO = { type: 'stdio' as const, command: 'npx', args: ['-y', 'some-mcp'] };

function fileOf(id: string): string {
  return readFileSync(join(MCP_DIR, `${id}.json`), 'utf8');
}

function refsOf(id: string): Record<string, string> {
  const s = getMcp(id);
  return s?.transport.type === 'stdio'
    ? Object.fromEntries(Object.entries(s.transport.env_secrets ?? {}).map(([k, ref]) => [k, ref.secret_id]))
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

test('variables go to the vault: the file names the secret, only the bridge reads the value', () => {
  const saved = upsertMcp({ id: 'env-typed', transport: { ...STDIO, env: { API_KEY: 'env-key-123', EMPTY: '' } } });
  assert.ok(!fileOf('env-typed').includes('env-key-123'), 'the value is not in the server file');
  assert.ok(!JSON.stringify(saved).includes('env-key-123'));
  const refs = refsOf('env-typed');
  assert.deepEqual(Object.keys(refs), ['API_KEY']);
  assert.equal(getSecret(refs.API_KEY!)?.name, 'MCP_ENV_TYPED_ENV_API_KEY');
  assert.equal(getSecret(refs.API_KEY!)?.grants.length, 0, 'granted to nobody: no agent environment receives it');
  assert.deepEqual(mcpStdioBridgeLaunch('env-typed')?.env, { EMPTY: '', API_KEY: 'env-key-123' });
});

test('every reader gets the variables masked, the editor too, and never which secret holds them', () => {
  for (const view of [presentMcpServer(getMcp('env-typed')!), redactMcpServer(getMcp('env-typed')!)]) {
    assert.deepEqual(view.transport, { ...STDIO, env: { EMPTY: '***', API_KEY: '***' } });
    assert.ok(!JSON.stringify(view).includes('env_secrets'));
  }
});

test('a masked save keeps the value, a new value replaces its secret, a removed variable loses it', () => {
  const before = refsOf('env-typed').API_KEY!;
  upsertMcp({ id: 'env-typed', description: 'edited', transport: { ...STDIO, env: { API_KEY: '***', EMPTY: '***' } } });
  assert.equal(refsOf('env-typed').API_KEY, before);
  assert.equal(mcpStdioBridgeLaunch('env-typed')?.env.API_KEY, 'env-key-123');
  upsertMcp({ id: 'env-typed', transport: { ...STDIO, env: { API_KEY: 'env-key-456' } } });
  assert.equal(getSecret(before) ?? null, null, 'the replaced value is deleted from the vault');
  assert.equal(mcpStdioBridgeLaunch('env-typed')?.env.API_KEY, 'env-key-456');
  const current = refsOf('env-typed').API_KEY!;
  upsertMcp({ id: 'env-typed', transport: { ...STDIO, env: {} } });
  assert.equal(getSecret(current) ?? null, null);
  assert.equal(mcpStdioBridgeLaunch('env-typed'), null, 'no variable left: no bridge');
  deleteMcp('env-typed');
});

test('a mask never follows the server to another command; a mission is refused, naming no value', () => {
  upsertMcp({ id: 'env-moved', transport: { ...STDIO, env: { TOKEN: 'env-moved-secret' } } });
  assert.throws(
    () => upsertMcp({ id: 'env-moved', transport: { type: 'stdio', command: 'curl', args: ['evil'], env: { TOKEN: '***' } } }),
    (err: Error) => /command or args changed/.test(err.message) && !err.message.includes('env-moved-secret'),
  );
  const refused = missionTransport(getMcp('env-moved'), { type: 'stdio', command: 'curl', args: [], env: { TOKEN: '***' } });
  assert.ok('refusal' in refused && /command or args changed/.test(refused.refusal));
  const kept = missionTransport(getMcp('env-moved'), { ...STDIO, env: { TOKEN: '***' } });
  assert.ok('transport' in kept);
  const id = refsOf('env-moved').TOKEN!;
  deleteMcp('env-moved');
  assert.equal(getSecret(id) ?? null, null, 'deleting the server deletes its variables');
});

test('vault off: the variables stay in the file, the server is held back; the vault back, the migration moves them', async () => {
  setActiveModules(['@timon/agents']);
  try {
    const { logs } = await capturingLogs(() => upsertMcp({ id: 'env-off', transport: { ...STDIO, env: { K: 'env-off-secret' } } }));
    assert.match(logs, /env-off: its variables stay in its file/);
    assert.ok(!logs.includes('env-off-secret'));
    assert.ok(fileOf('env-off').includes('env-off-secret'), 'nothing is lost');
    assert.equal(listMcp().find((s) => s.id === 'env-off')?.held_back, 'vault_off');
    assert.deepEqual(redactMcpServer(getMcp('env-off')!).transport, { ...STDIO, env: { K: '***' } });
  } finally {
    resetActiveModules();
  }
  const { value } = await capturingLogs(() => migrateMcpHeadersToVault());
  assert.ok(value.moved.includes('env-off'));
  assert.ok(!fileOf('env-off').includes('env-off-secret'));
  assert.equal(mcpStdioBridgeLaunch('env-off')?.env.K, 'env-off-secret');
  deleteMcp('env-off');
});

test('a legacy file with variables in clear is moved once', async () => {
  mkdirSync(MCP_DIR, { recursive: true });
  const legacy: McpStoredServer = { id: 'env-legacy', name: 'env-legacy', transport: { ...STDIO, env: { OLD: 'env-legacy-secret' } } };
  writeFileSync(join(MCP_DIR, 'env-legacy.json'), JSON.stringify(legacy));
  const first = await capturingLogs(() => migrateMcpHeadersToVault());
  assert.ok(first.value.moved.includes('env-legacy'));
  assert.ok(!first.logs.includes('env-legacy-secret'));
  assert.ok(!fileOf('env-legacy').includes('env-legacy-secret'));
  const second = await capturingLogs(() => migrateMcpHeadersToVault());
  assert.ok(!second.value.moved.includes('env-legacy'), 'idempotent');
  deleteMcp('env-legacy');
});

test('with the bridge switched off, the launch writes the variables read from the vault, as before', async () => {
  upsertMcp({ id: 'env-legacy-launch', transport: { ...STDIO, env: { K: 'env-launch-secret' } } });
  const servers = await resolveLaunchServers(['env-legacy-launch'], () => null);
  assert.deepEqual(servers, [{ type: 'stdio', name: 'env-legacy-launch', command: 'npx', args: ['-y', 'some-mcp'], env: { K: 'env-launch-secret' } }]);
  deleteMcp('env-legacy-launch');
});

test('switching the vault module on again moves what the file kept while it was off, without a reboot', async () => {
  setActiveModules(['@timon/agents']);
  try {
    await capturingLogs(() => upsertMcp({ id: 'env-rearm', transport: { ...STDIO, env: { K: 'env-rearm-secret' } } }));
    assert.ok(fileOf('env-rearm').includes('env-rearm-secret'));
  } finally {
    resetActiveModules();
  }
  const { apply } = await import('./plugins-bundled/secrets-vault/index.js');
  const express = (await import('express')).default;
  const { logs } = await capturingLogs(() => apply({ http: { router: () => express() }, effect: () => undefined } as never));
  assert.ok(!fileOf('env-rearm').includes('env-rearm-secret'), 'moved when the module came back');
  assert.ok(!logs.includes('env-rearm-secret'));
  assert.equal(mcpStdioBridgeLaunch('env-rearm')?.env.K, 'env-rearm-secret');
  deleteMcp('env-rearm');
});

/** Runs `fn` as if the account's home were `home`: `os.homedir()` reads these. */
function underHome<T>(home: string, fn: () => T): T {
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    return fn();
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

test('a path under the home is sealed as ~/…, so an archive imported under another home finds it there', () => {
  const typed = join(homedir(), 'mcp-data', 'db.sqlite');
  upsertMcp({ id: 'env-path', transport: { ...STDIO, env: { DB: typed, TOKEN: 'env-path-secret' } } });
  const stored = getMcp('env-path')!;
  assert.ok(stored.transport.type === 'stdio');
  const refs = stored.transport.env_secrets!;
  assert.equal(refs.DB?.home, true);
  assert.equal(refs.TOKEN?.home, undefined, 'a value that is no path stays as typed');
  assert.equal(readSecretValue(refs.DB!.secret_id), '~/mcp-data/db.sqlite');
  assert.equal(mcpStdioBridgeLaunch('env-path')?.env.DB, typed, 'read back where it was typed');
  const elsewhere = mkdtempSync(join(tmpdir(), 'timon-other-home-'));
  assert.equal(underHome(elsewhere, () => mcpStdioBridgeLaunch('env-path')?.env.DB), join(elsewhere, 'mcp-data', 'db.sqlite'));
  assert.equal(mcpStdioBridgeLaunch('env-path')?.env.TOKEN, 'env-path-secret');
  deleteMcp('env-path');
});

test('a path sealed before the vault wrote ~/… is rewritten by the migration, once, naming no value', async () => {
  const typed = join(homedir(), 'old-sealed', 'config.json');
  upsertMcp({ id: 'env-old-path', transport: { ...STDIO, env: { CONF: typed } } });
  // As a vault written before this change left it: the absolute value, no flag.
  const before = getMcp('env-old-path')!;
  assert.ok(before.transport.type === 'stdio');
  const ref = before.transport.env_secrets!.CONF!;
  updateSecret(ref.secret_id, { value: typed });
  writeFileSync(join(MCP_DIR, 'env-old-path.json'), JSON.stringify({
    ...before, transport: { ...before.transport, env_secrets: { CONF: { secret_id: ref.secret_id, typed: true } } },
  }));
  assert.equal(mcpStdioBridgeLaunch('env-old-path')?.env.CONF, typed, 'an absolute value without the flag reads as it is');
  const { logs } = await capturingLogs(() => migrateMcpHeadersToVault());
  assert.ok(!logs.includes(typed));
  assert.equal(JSON.parse(fileOf('env-old-path')).transport.env_secrets.CONF.home, true);
  assert.equal(readSecretValue(ref.secret_id), '~/old-sealed/config.json');
  assert.equal(mcpStdioBridgeLaunch('env-old-path')?.env.CONF, typed);
  const again = fileOf('env-old-path');
  await capturingLogs(() => migrateMcpHeadersToVault());
  assert.equal(fileOf('env-old-path'), again, 'idempotent');
  deleteMcp('env-old-path');
});

test('a master key that reads again (keyring unlocked) moves what the file kept meanwhile, without a reboot', async () => {
  const { apply } = await import('./plugins-bundled/secrets-vault/index.js');
  const express = (await import('express')).default;
  const disposers: Array<() => void> = [];
  const effect = (fn: () => (() => void) | void) => { const off = fn(); if (off) disposers.push(off); };
  await capturingLogs(() => apply({ http: { router: () => express() }, effect } as never));
  // A sealed secret: without one, a missing key is a fresh install, not a locked vault.
  upsertMcp({ id: 'env-probe', transport: { ...STDIO, env: { P: 'probe' } } });
  const probe = refsOf('env-probe').P!;
  const key = readFileSync(SECRET_KEY_FILE);
  unlinkSync(SECRET_KEY_FILE); resetMasterKeyCache(); resetRotationCheck();
  try {
    const { logs } = await capturingLogs(() => upsertMcp({ id: 'env-locked', transport: { ...STDIO, env: { K: 'env-locked-secret' } } }));
    assert.ok(fileOf('env-locked').includes('env-locked-secret'), 'kept in the file while the key is unreadable');
    assert.ok(!logs.includes('env-locked-secret'));
  } finally {
    // The key is back, the cache left as the failure left it: the next read recovers it.
    writeFileSync(SECRET_KEY_FILE, key, { mode: 0o600 }); resetRotationCheck();
  }
  try {
    const { logs } = await capturingLogs(async () => {
      readSecretValue(probe);
      await new Promise((resolve) => setImmediate(resolve));
    });
    assert.ok(!fileOf('env-locked').includes('env-locked-secret'), 'moved once the key read again');
    assert.ok(!logs.includes('env-locked-secret'));
    assert.match(logs, /env-locked moved into the secrets vault once the master key read again/);
    assert.equal(mcpStdioBridgeLaunch('env-locked')?.env.K, 'env-locked-secret');
  } finally {
    for (const off of disposers) off();
    deleteMcp('env-locked');
    deleteMcp('env-probe');
  }
});
