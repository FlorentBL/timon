/**
 * Qwen Code as the release's official provider (`official-providers/provider-qwen`): what its row and its
 * manifest declare, the command line, the profile, the sign-in sentence, the session opened through the
 * backend (permissions on the card, the agent's own modes, Timon's MCP servers), the model probe and the
 * version floor. Always against scripted stand-ins, never a real `qwen`: the agent's own answers were
 * recorded from Qwen Code 0.28.4 (`provider-qwen/lib/agent.js`). The trust of a real launch is in
 * `acp-trust.test.ts`, the generic ACP contract in `acp.test.ts`.
 */
import '../test-home.js';
import '../../tests/helpers/paid-license.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn as nodeSpawn } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';
process.env.PORT = '3010';
const HERE = dirname(fileURLToPath(import.meta.url));
const FAKE = join(HERE, '..', 'backends', 'acp', '__fixtures__', 'fake-acp-agent.mjs');
const posix = process.platform !== 'win32';

/**
 * A `qwen` on the PATH that answers the model probe the way Qwen Code 0.28.4 does (`session/new` of a
 * session signed in through an OpenAI-compatible key, trimmed), and writes the arguments it was started
 * with next to itself. A shell script, hence POSIX only; elsewhere an empty stand-in makes the profile exist.
 */
const BIN = mkdtempSync(join(tmpdir(), 'timon-qwen-bin-'));
process.on('exit', () => rmSync(BIN, { recursive: true, force: true }));
const ARGV_FILE = join(BIN, 'argv.json');
const RECORDED_SESSION_NEW = {
  sessionId: '82e40376-6d9e-4071-89bd-68887e3db405',
  models: {
    currentModelId: '$runtime|openai|qwen3-coder-plus(openai)',
    availableModels: [{ modelId: '$runtime|openai|qwen3-coder-plus(openai)', name: 'qwen3-coder-plus', description: null }],
  },
  modes: { currentModeId: 'default', availableModes: ['plan', 'default', 'auto-edit', 'auto', 'yolo'].map((id) => ({ id, name: id })) },
};
if (posix) {
  const agent = join(BIN, 'qwen-agent.mjs');
  writeFileSync(agent, [
    "import { createInterface } from 'node:readline';",
    "import { writeFileSync } from 'node:fs';",
    `writeFileSync(${JSON.stringify(ARGV_FILE)}, JSON.stringify(process.argv.slice(2)));`,
    "const send = (o) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...o }) + '\\n');",
    "createInterface({ input: process.stdin }).on('line', (l) => { const m = JSON.parse(l);",
    "  if (m.method === 'initialize') send({ id: m.id, result: { protocolVersion: 1, authMethods: [{ id: 'openai', name: 'Use OpenAI API key' }] } });",
    `  else if (m.method === 'session/new') send({ id: m.id, result: ${JSON.stringify(RECORDED_SESSION_NEW)} });`,
    "  else if (m.id !== undefined) send({ id: m.id, error: { code: -32601, message: 'Method not found' } });",
    '});',
  ].join('\n'));
  writeFileSync(join(BIN, 'qwen'), `#!/bin/sh\nif [ "$1" = "--version" ]; then echo 0.28.4; exit 0; fi\nexec "${process.execPath}" "${agent}" "$@"\n`);
  chmodSync(join(BIN, 'qwen'), 0o755);
} else {
  writeFileSync(join(BIN, 'qwen.cmd'), '');
}
process.env.PATH = `${BIN}${delimiter}${process.env.PATH ?? ''}`;

const { mountOfficialProviders, buildUnderSeal } = await import('../../tests/helpers/official-providers.js');
assert.ok((await mountOfficialProviders()).includes('provider-qwen'));
const { activeProfiles, backendTakesHttpMcp, backendTrust, getDialect, isProductBackend, profileDeclarations, registeredBackendOwners } = await import('../backends/registry.js');
const { getBackend } = await import('../backends/index.js');
const { BUILTIN_DECLARATIONS } = await import('../backends/builtin-declarations.js');
const { openLaunchSeal, closeLaunchSeal } = await import('../backends/launch-seal.js');
const { QWEN_AGENT, QWEN_SIGN_IN } = await import('../../official-providers/provider-qwen/lib/agent.js');
const { QWEN_PROFILE } = await import('../../official-providers/provider-qwen/lib/profile.js');
const { withMinimumVersion } = await import('../../official-providers/provider-qwen/lib/version.js');
type BuildSpawnOpts = import('../backends/types.js').BuildSpawnOpts;
type NormalizedEvent = import('../backends/types.js').NormalizedEvent;
type Dialect = import('../backends/types.js').Dialect;
type NativeProviderDefinition = import('../backends/engine/definition.js').NativeProviderDefinition;

const ARGS = ['--acp', '--approval-mode', 'default'];
const dialect = (): Dialect => getDialect('qwen') as Dialect;

function opts(over: Partial<BuildSpawnOpts> = {}, cfg: Partial<BuildSpawnOpts['cfg']> = {}): BuildSpawnOpts {
  return {
    agentName: 'timon.qwen-test',
    systemPrompt: 'You are a Timon agent.',
    message: 'hello',
    resumeSession: null,
    cfg: { cwd: tmpdir(), permission_mode: 'auto', ...cfg },
    missionId: `mission-${Math.random().toString(36).slice(2, 10)}`,
    ...over,
  };
}

/** A session on `qwen` through the backend, the scripted fake agent behind its pipes. */
function open(cfg: Partial<BuildSpawnOpts['cfg']> = {}, env: Record<string, string> = {}) {
  const child = nodeSpawn(process.execPath, [FAKE], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...env } });
  child.stderr.resume();
  const events: NormalizedEvent[] = [];
  const asks: unknown[] = [];
  const spawn = opts({}, cfg);
  const seal = openLaunchSeal(spawn.missionId, 'qwen', spawn, () => 'issued-token');
  const driver = getBackend('qwen').openSession!({
    io: { stdin: child.stdin, stdout: child.stdout },
    spawn,
    host: {
      emit: (ev) => { events.push(ev); },
      requestPermission: async (req) => { asks.push(req); return { allow: true }; },
    },
  });
  return { driver, events, asks, close: () => { driver.close(); child.kill('SIGKILL'); closeLaunchSeal(seal); } };
}

function said(events: NormalizedEvent[]): string {
  return events.filter((e) => e.type === 'assistant_delta').map((e) => (e.payload as { text: string }).text).join('');
}

test('registered by its own plugin under the `qwen` id, as one of the release\'s own providers', () => {
  assert.equal(registeredBackendOwners().dialects.qwen, 'provider-qwen');
  assert.equal(backendTrust('qwen'), 'official');
  assert.equal(isProductBackend('qwen'), true);
});

test('a session-driven, resumable agent that asks Timon before its tool uses, with stdio MCP servers only', () => {
  const d = dialect();
  assert.equal(d.persistentProcess, true);
  assert.equal(d.finishMissionOnExit, true);
  assert.equal(d.sessionResumable, true);
  assert.equal(d.sessionStore, 'global');
  assert.equal(d.permissionModel, 'protocol');
  assert.equal(d.permissionsByAgent?.('qwen') ?? false, false, 'in `default` Qwen Code sends session/request_permission');
  assert.equal(typeof d.discoverModels, 'function');
  assert.equal(d.localEnv, undefined, 'no user file may set a variable on this dialect');
  // Qwen Code announces HTTP and SSE servers too; the ACP driver declares the stdio ones only.
  assert.equal(backendTakesHttpMcp('qwen'), false);
});

test('the manifest is the one place the program and the sign-in folder are written', () => {
  const manifest = JSON.parse(readFileSync(join(HERE, '..', '..', 'official-providers', 'provider-qwen', 'package.json'), 'utf8')) as {
    timon: { provider: { binaries: Array<{ name: string }>; credentialDirs: string[] } };
  };
  const declared = profileDeclarations('qwen');
  assert.deepEqual(declared?.binary?.names, ['qwen']);
  assert.deepEqual(declared?.credentialDirs, ['.qwen']);
  assert.equal(declared?.spans, 'stream-json');
  assert.deepEqual(manifest.timon.provider.binaries.map((b) => b.name), ['qwen'], 'the program the operator authorizes');
  assert.deepEqual(manifest.timon.provider.credentialDirs, ['.qwen']);

  const product = BUILTIN_DECLARATIONS.qwen!;
  const publicOnly = JSON.parse(JSON.stringify(product.binary, (key, value) => (key === 'standaloneInstaller' ? undefined : value)));
  assert.deepEqual(JSON.parse(JSON.stringify(declared?.binary)), publicOnly, 'the plugin declares what the product reads');
  assert.deepEqual(product.binary?.install, { any: { kind: 'npm', package: '@qwen-code/qwen-code' } });
  assert.match(product.binary?.standaloneInstaller?.posix ?? '', /^curl -fsSL https:\/\/qwen-code-assets\.oss-cn-hangzhou\.aliyuncs\.com\/installation\/install-qwen-standalone\.sh \| bash$/);
  assert.match(product.binary?.standaloneInstaller?.windows ?? '', /^irm https:\/\/qwen-code-assets\.oss-cn-hangzhou\.aliyuncs\.com\/installation\/install-qwen-standalone\.ps1 \| iex$/);
  assert.deepEqual(product.binary?.searchDirs, { win32: ['${LOCALAPPDATA}/qwen-code/bin'] }, 'where the Windows installer writes qwen.cmd');
  assert.deepEqual(product.updateCheck, { latest: { npm: '@qwen-code/qwen-code' }, supportedMajor: 0 });
});

test('signing in is `qwen` then `/auth`, never the removed `qwen auth`, and never an API key Timon would hold', () => {
  assert.equal(BUILTIN_DECLARATIONS.qwen?.signInCommand, 'qwen');
  assert.equal(BUILTIN_DECLARATIONS.qwen?.signInThen, '/auth');
  assert.equal(QWEN_AGENT.signIn?.fallback, QWEN_SIGN_IN);
  assert.equal(QWEN_AGENT.signIn?.byMethod?.openai, QWEN_SIGN_IN, 'the one method Qwen Code announces is the per-token key: the sentence still points at /auth');
  assert.match(QWEN_SIGN_IN, /`qwen`.*`\/auth`/);
  assert.doesNotMatch(JSON.stringify(QWEN_AGENT.signIn), /qwen auth|OPENAI_API_KEY/);
  assert.equal(QWEN_AGENT.authenticateWith, undefined, '`authenticate openai` would sign in with a key billed by the token');
});

test('the profile names its program, pins the verified version, invents no model and passes no variable', () => {
  const entry = activeProfiles().find((candidate) => candidate.profile.id === 'qwen');
  assert.ok(entry, 'the profile exists once its CLI is found');
  assert.equal(QWEN_PROFILE.dialect, 'qwen');
  assert.equal(QWEN_PROFILE.label, 'Qwen Code');
  assert.equal(QWEN_PROFILE.brand, 'qwen', 'the logo the app already carries');
  assert.equal(QWEN_PROFILE.requiredBinary, 'qwen');
  assert.equal(QWEN_PROFILE.minCliVersion, '0.28.4');
  assert.equal(QWEN_PROFILE.defaultModel, null);
  assert.deepEqual(QWEN_PROFILE.models, []);
  assert.equal(QWEN_PROFILE.env, undefined);
  assert.equal(QWEN_PROFILE.envFrom, undefined);
});

test('buildSpawn: `qwen --acp --approval-mode default`; nothing goes on stdin or argv', async () => {
  const o = opts();
  const spawn = await buildUnderSeal('qwen', o);
  assert.match(spawn.cmd, /qwen/);
  assert.deepEqual(spawn.args, ARGS, 'the approval mode wins over a `yolo` in the user\'s ~/.qwen/settings.json');
  assert.equal(spawn.initialStdin, null);
  assert.equal(spawn.cwd, o.cfg.cwd);
  assert.ok(!spawn.args.some((a) => a.includes(o.systemPrompt) || a.includes(o.message)));
});

test('through the backend: Qwen Code asks, Timon\'s card answers', async () => {
  const s = open();
  try {
    const info = await s.driver.start();
    assert.equal(info.capabilities.permissionsByAgent, undefined);
    s.events.length = 0;
    await s.driver.prompt('perm');
    assert.equal(s.asks.length, 1);
    assert.equal(said(s.events), 'selected:allow');
  } finally {
    s.close();
  }
});

test('only `plan` switches the agent\'s own mode; every other permission mode keeps `default`, where it asks', async () => {
  assert.deepEqual({ ...QWEN_AGENT.sessionModes }, { plan: 'plan' });
  const cases = [['plan', 'mode:plan via:set_mode'], ['default', /^mode:default /], ['acceptEdits', /^mode:default /], ['auto', /^mode:default /], ['bypassPermissions', /^mode:default /]] as const;
  for (const [mode, expected] of cases) {
    const s = open({ permission_mode: mode }, { FAKE_ACP_MODES: '1' });
    try {
      await s.driver.start();
      s.events.length = 0;
      await s.driver.prompt('mode');
      if (typeof expected === 'string') assert.equal(said(s.events), expected, mode);
      else assert.match(said(s.events), expected, mode);
    } finally {
      s.close();
    }
  }
});

test('the session declares Timon\'s two MCP servers over stdio', async () => {
  const s = open();
  try {
    await s.driver.start();
    s.events.length = 0;
    await s.driver.prompt('mcp');
    const servers = JSON.parse(said(s.events)) as Array<{ name: string; command: string; type?: string }>;
    assert.deepEqual(servers.map((x) => x.name), ['timon', 'timon_ask']);
    for (const server of servers) assert.equal(server.command, 'node', server.name);
  } finally {
    s.close();
  }
});

test('an agent that is not signed in names `/auth` inside `qwen`', async () => {
  const s = open({}, { FAKE_ACP_AUTH: '1' });
  try {
    await assert.rejects(() => s.driver.start(), /run `qwen` in a terminal on this machine, type `\/auth`/);
  } finally {
    s.close();
  }
});

test('the model list comes from the agent\'s own `session/new`, started with the same command line', { skip: !posix }, async () => {
  const entry = activeProfiles().find((candidate) => candidate.profile.id === 'qwen')!;
  const resolved = await entry.runtimeFor();
  const found = await dialect().discoverModels!(resolved.runtime);
  assert.deepEqual(found.map((model) => (typeof model === 'string' ? model : model.slug)), ['$runtime|openai|qwen3-coder-plus(openai)']);
  assert.deepEqual(JSON.parse(readFileSync(ARGV_FILE, 'utf8')), ARGS);
});

/* ── The version floor ─────────────────────────────────────────────────── */

function floored(version: string | null | Error) {
  const launches: string[] = [];
  const asked: string[] = [];
  const inner = { id: 'qwen', launch: async () => { launches.push('launched'); return { cmd: 'qwen', args: [], env: {}, initialStdin: null }; } } as unknown as NativeProviderDefinition;
  const services = { binary: { version: async (name: string) => { asked.push(name); if (version instanceof Error) throw version; return version; } } } as never;
  return { definition: withMinimumVersion(inner, services, 'qwen'), launches, asked };
}
const PROFILE = { id: 'qwen', cmd: 'qwen', env: {}, minCliVersion: '0.28.4' };

test('a Qwen Code older than the verified version is refused with the command that updates it', async () => {
  const old = floored('0.27.9');
  await assert.rejects(old.definition.launch(opts(), PROFILE), /Qwen Code 0\.27\.9 is older than 0\.28\.4.*npm install -g @qwen-code\/qwen-code@latest/);
  assert.deepEqual(old.launches, []);
  assert.deepEqual(old.asked, ['qwen']);
});

test('the verified version and a newer one start, and the version is asked once', async () => {
  for (const version of ['0.28.4', 'qwen 0.29.0', '1.0.0']) {
    const ok = floored(version);
    await ok.definition.launch(opts(), PROFILE);
    await ok.definition.launch(opts(), PROFILE);
    assert.deepEqual(ok.launches, ['launched', 'launched'], version);
    assert.deepEqual(ok.asked, ['qwen'], version);
  }
});

test('an unreadable version is no verdict: the launch goes ahead', async () => {
  for (const version of [null, 'unknown', new Error('spawn failed')]) {
    const unread = floored(version);
    await unread.definition.launch(opts(), PROFILE);
    assert.deepEqual(unread.launches, ['launched']);
  }
  const unpinned = floored('0.1.0');
  await unpinned.definition.launch(opts(), { ...PROFILE, minCliVersion: undefined });
  assert.deepEqual(unpinned.asked, [], 'a profile without a floor asks nothing');
});

