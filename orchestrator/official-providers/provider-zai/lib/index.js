// @ts-check
import { ZAI_PROFILE } from './profile.js';

export const name = 'provider-zai';

/** @param {import('@timon-ai/sdk/provider').ProviderPluginContext} ctx */
export function apply(ctx) { ctx.provider.registerProductProfile(ZAI_PROFILE); }
