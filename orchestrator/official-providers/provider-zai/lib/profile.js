// @ts-check
/**
 * `zai` rides on the `claude` CLI, pointed at Z.ai's Anthropic-compatible endpoint (the one its
 * GLM Coding Plan answers on; a key on the pay-as-you-go endpoint goes through `ZAI_BASE_URL`).
 * It has no sign-in folder: the key is the vault entry `ZAI_API_KEY`, or the same name in the
 * daemon's environment. The claude dialect gives the profile a config folder of its own, so the
 * user's `~/.claude` is never read for it.
 *
 * Only the global endpoint is declared. Z.ai's mainland China platform is a separate account with
 * its own keys, and its Anthropic URL is not confirmed by its documentation: a user who needs it
 * sets `ZAI_BASE_URL`.
 *
 * No `fallbackRank`: an automatic switch would move every prompt of a quota that ran dry onto the
 * user's Coding Plan, whose terms cap concurrency. The profile stays reachable through a manual
 * fallback (task, series, global setting).
 */
import { manifestBackend } from './manifest.js';

const FLAGSHIP = 'glm-5.4';
const FAST = 'glm-5.3-flash';

/** @type {import('@timon-ai/sdk/provider').BackendProfile} */
export const ZAI_PROFILE = {
  id: 'zai',
  credentialDirs: manifestBackend('zai').credentialDirs,
  dialect: 'claude',
  label: 'GLM (Z.ai)',
  vendor: 'Z.ai',
  brand: 'zhipu',
  custom: true,
  envFrom: {
    ANTHROPIC_AUTH_TOKEN: 'ZAI_API_KEY',
    ANTHROPIC_BASE_URL: 'ZAI_BASE_URL',
  },
  env: {
    ANTHROPIC_AUTH_TOKEN: { secret: 'ZAI_API_KEY' },
    ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic',
    // Z.ai's own setting for the claude CLI: a long GLM turn outlasts the CLI's default timeout.
    API_TIMEOUT_MS: '3000000',
    // The CLI picks Anthropic model names for its own sub-agents and background calls; this
    // endpoint serves none of them.
    ANTHROPIC_DEFAULT_OPUS_MODEL: FLAGSHIP,
    ANTHROPIC_DEFAULT_SONNET_MODEL: FLAGSHIP,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: FAST,
  },
  defaultModel: FLAGSHIP,
  models: [
    { slug: FLAGSHIP, label: 'GLM-5.4', tier: 'flagship' },
    { slug: 'glm-5.3', label: 'GLM-5.3', tier: 'mid' },
    { slug: FAST, label: 'GLM-5.3-Flash', tier: 'small' },
  ],
};
