/**
 * The status line of a provider that rides on another provider's CLI with a
 * key and an endpoint of its own (Z.ai, Kimi on `claude`; Ollama Cloud on
 * `codex`; a DeepSeek endpoint added by hand). The CLI's own sign-in on this
 * computer is its owner's: it says nothing about whether that key exists.
 * Reported by testers on 27/11/2026: Z.ai with no key showed "Account
 * connected" because the host's `claude` was signed in.
 */
import '../../test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { PluginStatus } from '../../plugins/loader.js';

for (const name of ['ZAI_API_KEY', 'KIMI_API_KEY', 'OLLAMA_API_KEY', 'DEEPSEEK_API_KEY']) delete process.env[name];

const { mountOfficialProviders, stubCliBinaries } = await import('../../../tests/helpers/official-providers.js');
await stubCliBinaries('claude', 'codex');
await mountOfficialProviders();
const { orchestratorRoot, readBuiltinList } = await import('../../plugins/builtin.js');
const { readManifest } = await import('../../plugins/manifest.js');
const { registerFileProfile } = await import('../../backends/registry.js');
const {
  noteProviderSignedIn, primeProviderSignIn, providerSignedIn, resetProviderSignInForTest, setSignInEnv,
} = await import('../../backends/sign-in-state.js');
const { providersOverview } = await import('./provider-overview.js');

// What the "add a provider" page writes for DeepSeek: the claude CLI, DeepSeek's endpoint, a vault entry nobody created.
registerFileProfile('local-file', {
  id: 'deepseek', dialect: 'claude', label: 'DeepSeek', vendor: 'DeepSeek', custom: true,
  env: { ANTHROPIC_AUTH_TOKEN: { secret: 'DEEPSEEK_API_KEY' }, ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic' },
  models: [{ slug: 'deepseek-chat', label: 'deepseek-chat' }], defaultModel: 'deepseek-chat',
});

const root = orchestratorRoot();
const plugins = readBuiltinList(root).flatMap(({ source }): PluginStatus[] => {
  const res = readManifest(JSON.parse(readFileSync(join(resolve(root, source), 'package.json'), 'utf8')) as Record<string, unknown>);
  if (!res.ok || !res.manifest.kind.includes('provider')) return [];
  return [{ id: res.manifest.id, pkg: res.manifest.id, dir: '', version: '0.1.0', state: 'active', reason: null, error: null, signed: true, manifest: res.manifest, builtin: true } as PluginStatus];
});

const BORROWED = [
  { backend: 'zai', provider: 'provider-zai' },
  { backend: 'kimi', provider: 'provider-kimi' },
  { backend: 'ollama-cloud', provider: 'provider-ollama-cloud' },
  { backend: 'deepseek', provider: 'user:deepseek' },
];

function overview() {
  return new Map(providersOverview({ plugins, acpAgents: [], viewer: { id: 'admin', isSuperadmin: true } }).providers.map((p) => [p.id, p]));
}

test('the host CLIs are signed in; the profiles that ride on them with a missing key are not connected', async () => {
  resetProviderSignInForTest();
  setSignInEnv(() => ({ CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-test-token-long-enough', CODEX_API_KEY: 'codex-test-key' }));
  try {
    await primeProviderSignIn(['claude', 'codex', ...BORROWED.map((entry) => entry.backend)]);
    assert.equal(providerSignedIn('claude'), true);
    assert.equal(providerSignedIn('codex'), true);
    const byId = overview();
    assert.equal(byId.get('provider-claude')?.status, 'connected', 'the CLI owner keeps its sign-in');
    assert.equal(byId.get('provider-codex')?.status, 'connected');
    for (const { backend, provider } of BORROWED) {
      assert.equal(providerSignedIn(backend), null, `${backend}: the CLI's session is not its own`);
      const view = byId.get(provider);
      assert.ok(view, `${provider} is listed`);
      assert.equal(view.secret.required, true, `${provider} reads a key`);
      assert.equal(view.secret.present, false);
      assert.equal(view.connection.signedIn, null, `${provider}: the "This computer" row does not borrow the CLI's sign-in`);
      assert.equal(view.status, 'not-connected', `${provider} has no key`);
    }
  } finally {
    resetProviderSignInForTest();
  }
});

test('a turn that once worked does not make a provider whose key is gone connected', () => {
  resetProviderSignInForTest();
  try {
    noteProviderSignedIn('zai');
    const zai = overview().get('provider-zai')!;
    assert.equal(zai.connection.signedIn, null, 'the "This computer" row does not show it signed in either');
    assert.equal(zai.status, 'not-connected', 'the missing key outranks the remembered turn');
  } finally {
    resetProviderSignInForTest();
  }
});
