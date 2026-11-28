/**
 * Module `computer-use` — lets an agent that has the right drive the host's
 * mouse and keyboard through the desktop app. The daemon only authorizes and
 * relays: the desktop holds the screen and the stop switch.
 */
import type { Context } from '@deepseek-ai/cordis';
import type { ModuleManifest } from '../../kernel/registry.js';
import { registerComputerRoutes } from './routes.js';

export const manifest: ModuleManifest = {
  name: '@timon/computer-use',
  tier: 'opt',
  requires: [],
  inject: ['http', 'db'],
};

export const name = manifest.name;
export const inject = manifest.inject;

export function apply(ctx: Context): void {
  registerComputerRoutes(ctx.http.router());
}
