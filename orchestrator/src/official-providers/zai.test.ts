/**
 * GLM (Z.ai) is a profile of the `provider-zai` plugin on the claude dialect, launched by
 * `provider-claude`: the same CLI, pointed at Z.ai's Anthropic-compatible endpoint with the user's
 * key. What the plugin owes is the profile itself (endpoint, key reference, the CLI's internal model
 * names mapped to GLM ones) and the guarantee that a launch reaches the CLI with all of it and
 * nothing of the user's own Claude setup. The key's resolution (environment, vault, override) is
 * covered with Kimi's in `backends/credentials.test.ts`.
 */
import '../test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createProviderContext, defineConformanceTests, dialectConformance } from '../../../packages/sdk/src/testing/index.js';
import { createClaudeProvider } from '../../official-providers/provider-claude/lib/claude.js';
import { createClaudeToken } from '../../official-providers/provider-claude/lib/token.js';
import { createClaudeUsage } from '../../official-providers/provider-claude/lib/usage.js';
import { apply } from '../../official-providers/provider-zai/lib/index.js';

// The contract the plugin's manifest declares, which `scratch.profile` needs.
const { timon: { apiVersion } } = JSON.parse(readFileSync(new URL('../../official-providers/provider-claude/package.json', import.meta.url), 'utf8')) as { timon: { apiVersion: number } };
const ctx = createProviderContext({ apiVersion });
const token = createClaudeToken(ctx.provider);
ctx.provider.registerProvider(createClaudeProvider(ctx.provider, token, createClaudeUsage(ctx.provider, token)));
apply(ctx);
const dialect = ctx.registered.dialect('claude');
// The conformance suite launches as `mission-contract-0001`: its system prompt is written there.
const scratch = await ctx.provider.scratch.mission({ missionId: 'mission-contract-0001' } as never);
process.on('exit', () => ctx.cleanup());

const profile = ctx.registered.productProfiles.find((p) => p.id === 'zai')!;
/** The profile's env as the daemon resolves it once the vault entry is found: the key in place of its reference. */
const env: Record<string, string> = Object.fromEntries(Object.entries(profile.env ?? {})
  .map(([key, value]) => [key, typeof value === 'string' ? value : 'zai-test-key']));

defineConformanceTests(test, dialectConformance(dialect, { id: 'zai', cmd: 'claude', env }, {
  transcript: readFileSync(join(import.meta.dirname, '../backends/__fixtures__/claude.jsonl'), 'utf8'),
  sessionId: '3f9a1c52-7e64-4d0b-9a11-0b2c8de41f77', cmd: 'claude', model: 'glm-5.4',
}, { cwd: scratch.path, scratchDirs: [scratch.path] }), '[Z.ai plugin]');

test('Z.ai declares the claude dialect, the global endpoint and a key read from the vault, never written', () => {
  assert.equal(profile.dialect, 'claude');
  assert.equal(profile.label, 'GLM (Z.ai)');
  assert.equal(profile.brand, 'zhipu', 'the logo the interface already ships');
  assert.equal(profile.custom, true);
  assert.deepEqual(profile.credentialDirs, [], 'no CLI of its own: no folder of the user\'s home to open or mask');
  assert.equal(profile.env?.ANTHROPIC_BASE_URL, 'https://api.z.ai/api/anthropic');
  assert.deepEqual(profile.env?.ANTHROPIC_AUTH_TOKEN, { secret: 'ZAI_API_KEY' });
  assert.deepEqual(profile.envFrom, { ANTHROPIC_AUTH_TOKEN: 'ZAI_API_KEY', ANTHROPIC_BASE_URL: 'ZAI_BASE_URL' });
  assert.ok(!Object.keys(profile.env ?? {}).includes('ANTHROPIC_API_KEY'), 'one credential variable, the one Z.ai documents');
});

test('Z.ai is never an automatic fallback: a quota running dry elsewhere does not land on a Coding Plan', () => {
  assert.equal(profile.fallbackRank, undefined);
});

test('Z.ai offers the GLM models of the Coding Plan, GLM-5.4 first, each with its tier', () => {
  assert.equal(profile.defaultModel, 'glm-5.4');
  assert.deepEqual(profile.models.map((m) => [m.slug, m.tier]), [['glm-5.4', 'flagship'], ['glm-5.3', 'mid'], ['glm-5.3-flash', 'small']]);
  // The CLI's own sub-agents ask for Anthropic names, which this endpoint does not serve.
  assert.equal(profile.env?.ANTHROPIC_DEFAULT_OPUS_MODEL, 'glm-5.4');
  assert.equal(profile.env?.ANTHROPIC_DEFAULT_SONNET_MODEL, 'glm-5.4');
  assert.equal(profile.env?.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'glm-5.3-flash');
  for (const key of ['ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL']) {
    assert.ok(profile.models.some((m) => m.slug === profile.env?.[key]), `${key} names a model the profile offers`);
  }
  assert.match(String(profile.env?.API_TIMEOUT_MS), /^\d+$/);
});

/** A launch of the Z.ai profile the way the daemon asks for one, in `mission`. */
const spawnOf = (mission: string, model: string | null = 'glm-5.4', resumeSession: string | null = null) => dialect.buildSpawn({
  agentName: 'zai.contract', systemPrompt: 'contract', message: 'ping', resumeSession, missionId: mission,
  cfg: { cwd: scratch.path, permission_mode: 'auto', mcp_servers: [], model },
} as never, { id: 'zai', cmd: 'claude', env } as never);

test('a Z.ai launch hands the CLI the endpoint, the key, the model mapping and the chosen GLM model', async () => {
  const spec = await spawnOf('mission-zai-launch-1');
  assert.equal(spec.cmd, 'claude');
  assert.equal(spec.env?.ANTHROPIC_BASE_URL, 'https://api.z.ai/api/anthropic');
  assert.equal(spec.env?.ANTHROPIC_AUTH_TOKEN, 'zai-test-key');
  assert.equal(spec.env?.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'glm-5.3-flash');
  assert.equal(spec.env?.API_TIMEOUT_MS, profile.env?.API_TIMEOUT_MS);
  assert.equal(spec.args[spec.args.indexOf('--model') + 1], 'glm-5.4');
  assert.ok(!spec.args.join(' ').includes('zai-test-key'), 'the key travels in the environment, never on the command line');
});

test('#1104: Z.ai\'s claude CLI keeps its config in the profile\'s own folder, the same across missions, never ~/.claude', async () => {
  const first = await spawnOf('mission-zai-config-1');
  const second = await spawnOf('mission-zai-config-2');
  const folder = ctx.provider.scratch.profile({ id: 'zai', cmd: 'claude', env }).path;
  assert.equal(first.env?.CLAUDE_CONFIG_DIR, folder);
  assert.equal(second.env?.CLAUDE_CONFIG_DIR, folder, 'a new mission must find the sessions of the previous one');
  assert.ok(!folder.includes(join('', '.claude')), `${folder} is the user's Claude folder`);
  assert.equal(first.env?.CLAUDE_CODE_OAUTH_TOKEN, undefined, 'the user\'s Claude sign-in never rides along to Z.ai');
});
