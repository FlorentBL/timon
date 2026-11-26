/**
 * Routes a third-party plugin may not take in the `page` slot: the product's
 * own paths. Copy of `orchestrator/src/plugins/reserved-routes.ts`, where the
 * manifest is refused for the same routes (the two packages share no import);
 * `plugin-page-route-collision.test.ts` keeps the two lists equal.
 *
 * Checked again here because a page registers its key in the browser, and
 * nothing ties that key to the route its manifest declared: a page declaring
 * `/acme` could still register `/kanban` while the Kanban is off, or
 * `/workflows/x` ahead of the product's `/workflows/*`.
 */

/** First segments the product serves, or will serve while a module is on. */
export const RESERVED_ROUTE_SEGMENTS: readonly string[] = Object.freeze([
  'activate', 'activity', 'agents', 'agents-grid', 'api', 'apps', 'bots', 'brain', 'browser',
  'capabilities', 'chat', 'company', 'confirm-email', 'dashboard', 'dreams', 'edit', 'events',
  'invite', 'islands', 'kanban', 'license', 'login', 'mcp', 'memory', 'messages', 'missions',
  'multichat', 'notifications', 'onboarding', 'pipelines', 'plugins', 'profile', 'projects',
  'remote', 'routines', 'secrets', 'settings', 'setup', 'skills', 'terminal', 'trace', 'triggers',
  'workflows',
]);

/**
 * Starts of a first segment the login proxy skips (its `matcher` in
 * `app/src/proxy.ts`): a page there would paint without the session gate.
 */
export const RESERVED_ROUTE_PREFIXES: readonly string[] = Object.freeze([
  'icon-', 'logo-', 'manifest', 'workbox',
]);

/**
 * The reserved segment `route` falls under, or `null` when a plugin may take
 * it. `route` is a path (`/acme`, `/acme/*`); the home (`/`) is the product's.
 */
export function reservedRouteSegment(route: string): string | null {
  const first = route.split(/[/?#]/).filter(Boolean)[0] ?? '';
  if (!first) return '/';
  if (RESERVED_ROUTE_SEGMENTS.includes(first)) return `/${first}`;
  const prefix = RESERVED_ROUTE_PREFIXES.find((p) => first.startsWith(p));
  return prefix ? `/${prefix}` : null;
}
