/**
 * Native compaction is DECLARED by a provider (`session.compact`), never read
 * off a backend's name: Claude and Grok declare a slash command (`/compact`),
 * Codex declares a programmatic `run` hook (`codex app-server` `thread/compact/start`),
 * Copilot declares none, and a third party declares either form the same way.
 * A Grok compaction turn is the one launch without `--verbatim`, or the CLI
 * would hand `/compact` to the model.
 */
import '../test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { TIMON_HOME } from '../paths.js';
import { mountOfficialProviders, stubCliBinaries, buildUnderSeal } from '../../tests/helpers/official-providers.js';
import { nativeCompactCommand, nativeCompactOf } from './capabilities.js';
import { catalogBackend } from './index.js';
import { definitionProblems } from './engine/definition-check.js';
import { dialectProblems } from './dialect-check.js';
import { dialectFromDefinition } from './engine/native.js';
import type { BuildSpawnOpts, NativeProviderDefinition } from './types.js';

process.env.CODEX_AUTH_DIR = join(TIMON_HOME, 'codex-auth');
mkdirSync(process.env.CODEX_AUTH_DIR, { recursive: true });
writeFileSync(join(process.env.CODEX_AUTH_DIR, 'auth.json'), JSON.stringify({ tokens: { access_token: 'test-only' } }));
process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';

await stubCliBinaries('grok', 'copilot', 'opencode');
await mountOfficialProviders();

function opts(over: Partial<BuildSpawnOpts> = {}): BuildSpawnOpts {
  return {
    agentName: 'acme.main', systemPrompt: 'Test', message: '/compact', resumeSession: 'session-1',
    missionId: randomUUID(), cfg: { cwd: TIMON_HOME }, ...over,
  };
}

test('claude and grok declare a command, codex declares a run hook, copilot declares none', () => {
  assert.equal(nativeCompactCommand('claude'), '/compact');
  assert.equal(nativeCompactCommand('grok'), '/compact');
  assert.equal(nativeCompactCommand('codex'), null);
  assert.equal(nativeCompactCommand('copilot'), null);
  assert.equal(nativeCompactCommand(null), null);
  assert.equal(nativeCompactCommand('no-such-backend'), null);

  const codexCompact = nativeCompactOf('codex');
  assert.ok(codexCompact && 'run' in codexCompact && typeof codexCompact.run === 'function');
  assert.equal(nativeCompactOf('copilot'), null);
});

test('an account instance compacts like its backend', () => {
  assert.equal(nativeCompactCommand('claude@acct1'), '/compact');
  assert.equal(nativeCompactCommand('codex@acct1'), null);
  const codexAcct = nativeCompactOf('codex@acct1');
  assert.ok(codexAcct && 'run' in codexAcct && typeof codexAcct.run === 'function');
});

test('the catalogue says which backends compact natively, and only when they do', () => {
  assert.equal(catalogBackend('claude')?.nativeCompact, true);
  assert.equal(catalogBackend('codex')?.nativeCompact, true);
  assert.equal(catalogBackend('copilot')?.nativeCompact, undefined);
});

test('grok: an ordinary turn keeps --verbatim, a compaction turn drops it', async () => {
  const plain = await buildUnderSeal('grok', opts({ message: '/etc/hosts is the file' }));
  assert.ok(plain.args.includes('--verbatim'));
  const command = await buildUnderSeal('grok', opts({ agentCommand: true }));
  assert.ok(!command.args.includes('--verbatim'));
  assert.ok(command.args.includes('-r'));
});

const MINIMAL = {
  id: 'acme-compact',
  transport: { kind: 'process-per-turn' },
  launch: async () => ({ cmd: 'acme', args: [], initialStdin: null }),
  codec: { kind: 'lines', parseLine: () => [], extractSessionId: () => null },
  session: { store: 'global', resumable: true },
  permission: { model: 'sandbox' },
  limits: { reporting: 'none' },
  mcp: { timon: false },
  declares: { binary: { names: ['acme'] } },
};

test('a third-party definition declares command or programmatic compaction, and the adapter carries it to the dialect', () => {
  const def = { ...MINIMAL, session: { ...MINIMAL.session, compact: { command: '/compact' } } };
  assert.deepEqual(definitionProblems(def), []);
  const dialect = dialectFromDefinition(def as unknown as NativeProviderDefinition);
  assert.deepEqual(dialect.nativeCompact, { command: '/compact' });

  const run = async (): Promise<void> => {};
  const progDef = { ...MINIMAL, session: { ...MINIMAL.session, compact: { run } } };
  assert.deepEqual(definitionProblems(progDef), []);
  const progDialect = dialectFromDefinition(progDef as unknown as NativeProviderDefinition);
  assert.ok(progDialect.nativeCompact && 'run' in progDialect.nativeCompact);
  assert.equal(progDialect.nativeCompact.run, run);

  assert.equal(dialectFromDefinition(MINIMAL as unknown as NativeProviderDefinition).nativeCompact, undefined);
});

test('a malformed declaration is refused, in a definition and in a dialect', () => {
  const run = async (): Promise<void> => {};
  for (const compact of [{}, { command: '' }, { command: 3 }, { run: 'not-a-fn' }, { command: '/compact', run }, '/compact']) {
    const def = { ...MINIMAL, session: { ...MINIMAL.session, compact } };
    assert.ok(definitionProblems(def).some((p) => p.includes('session.compact')), JSON.stringify(compact));
  }
  assert.ok(dialectProblems({ nativeCompact: { command: ' ' } }).some((p) => p.includes('nativeCompact')));
  assert.ok(dialectProblems({ nativeCompact: { command: '/compact', run } }).some((p) => p.includes('nativeCompact')));
});
