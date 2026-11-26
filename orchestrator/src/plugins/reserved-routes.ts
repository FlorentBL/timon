/**
 * Routes a third-party `page` may not declare: the product's own paths.
 *
 * Reserved by first segment, never by exact path. A Next page (`/chat`) wins
 * over the catch-all only for the paths it serves, a page a bundled module
 * registers (`/kanban`) holds its key only while the module mounts it, and an
 * exact key beats a product wildcard (`/workflows/*`) for that one path. A
 * whole segment closes the three at once: `/chat/x`, `/kanban` with the
 * Kanban off, `/workflows/x`.
 *
 * Copied in `app/src/lib/plugin-host/reserved-routes.ts`, which the browser
 * checks when a plugin registers in the `page` slot (the two packages share
 * no import). `app/src/lib/plugin-page-route-collision.test.ts` keeps the
 * two lists equal and checks they cover every Next page and every page a
 * bundled module registers; `reserved-routes.test.ts` checks the bundled
 * identities.
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
