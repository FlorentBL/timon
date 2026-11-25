// @ts-check
/**
 * Qwen Code as an official provider plugin, written against `ctx.provider` and nothing else
 * (`docs/PROVIDERS-SDK.md` § 11.1, § 12.1). The agent is a row handed to the daemon's ACP runtime
 * (`agent.js`), its profile is in `profile.js`, the version floor in `version.js`. The ACP
 * registry's `qwen-code` entry is not used: it runs through `npx`, which the catalogue refuses.
 */
import { QWEN_AGENT } from './agent.js';
import { QWEN_PROFILE } from './profile.js';
import { withMinimumVersion } from './version.js';

export const name = 'provider-qwen';

/** @param {import('@timon-ai/sdk/provider').ProviderPluginContext} ctx */
export function apply(ctx) {
  const definition = ctx.provider.runtime.acp.defineProvider(ctx.provider, QWEN_AGENT);
  ctx.provider.registerProvider(withMinimumVersion(definition, ctx.provider, QWEN_AGENT.binary.names[0] ?? 'qwen'));
  ctx.provider.registerProductProfile(QWEN_PROFILE);
}
