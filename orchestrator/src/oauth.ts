/**
 * OAuth 2.1 client for remote MCP servers.
 *
 * Implements the bits of the MCP authorization spec we actually need to let
 * users click a button and authorize a hosted MCP from the TIMON UI:
 *   - Resource/AS metadata discovery (RFC 9728 + RFC 8414).
 *   - Dynamic Client Registration (RFC 7591) — required for almost every
 *     MCP server in the wild today since they don't pre-register clients.
 *   - Authorization code flow with PKCE S256 (RFC 7636).
 *   - Refresh tokens.
 *
 * Pending PKCE state (code_verifier) lives in memory: it is a secret, and
 * the round-trip lasts the few seconds the user takes to click "Authorize".
 * A restart mid-flow loses it, and the callback page then says to start again.
 * A state that was used is remembered a while longer, so a callback the
 * browser replays (a double navigation on the consent page) is told what
 * already happened instead of "unknown state".
 */
import { createHash, randomBytes } from 'node:crypto';
import type { OAuthClient, OAuthMetadata, OAuthTokens } from './plugins/contract/mcp-servers.js';
export type { OAuthClient, OAuthMetadata, OAuthTokens } from './plugins/contract/mcp-servers.js';

export type PendingAuth = {
  mcp_id: string;
  code_verifier: string;
  redirect_uri: string;
  metadata: OAuthMetadata;
  client: OAuthClient;
  created_at: number;
  /** The app origin the browser goes back to after the callback: one of the
   *  origins the daemon knows its app under, checked at /oauth/start. */
  return_to?: string;
  /** The app page the browser goes back to (`OAUTH_RETURN_PATHS`), `/mcp` when absent. */
  return_path?: OAuthReturnPath;
};

/** Where a finished authorization may send the browser back: a closed list, never a caller's path. */
export const OAUTH_RETURN_PATHS = ['/mcp', '/apps'] as const;
export type OAuthReturnPath = typeof OAUTH_RETURN_PATHS[number];

export function oauthReturnPath(value: unknown): OAuthReturnPath | undefined {
  return (OAUTH_RETURN_PATHS as readonly unknown[]).includes(value) ? value as OAuthReturnPath : undefined;
}

/** Path of the callback the publisher sends the browser back to (a public route: `state` + PKCE are its credential). */
export const OAUTH_CALLBACK_PATH = '/api/mcp/oauth/callback';

/**
 * The redirect URI registered with a publisher. A public https address when
 * one is configured (remote access through a proxy); otherwise the daemon's
 * own loopback address (RFC 8252 § 7.3). Publishers accept plain http only
 * for `localhost` itself: Supabase refuses `http://api.timon.localhost`, the
 * old default, at dynamic registration — and nothing answered there anyway.
 */
export function oauthRedirectUri(publicApiUrl: string | null | undefined, port: number): string {
  const base = (publicApiUrl ?? '').trim().replace(/\/+$/, '');
  if (/^https:\/\/[^/]+/i.test(base)) return `${base}${OAUTH_CALLBACK_PATH}`;
  return `http://localhost:${port}${OAUTH_CALLBACK_PATH}`;
}

const PENDING = new Map<string, PendingAuth>();
const PENDING_TTL_MS = 10 * 60 * 1000;

/** What became of a state once its callback arrived, or of a flow left unanswered. */
export type UsedStateOutcome = 'in_progress' | 'ok' | 'failed' | 'expired';
export type UsedState = OAuthReturn & { mcp_id: string; outcome: UsedStateOutcome; used_at: number };
/** Where the browser goes back after a callback: the app origin and page. */
export type OAuthReturn = { return_to?: string; return_path?: OAuthReturnPath };

/**
 * States this daemon issued whose flow is over: consumed by a callback, or
 * expired unanswered. Only a state found here or in `PENDING` gives a callback
 * the origin its flow started from: a state nobody issued gets nothing of it.
 */
const USED = new Map<string, UsedState>();
/** How long a consumed state still answers a replayed callback. */
export const USED_STATE_TTL_MS = 10 * 60 * 1000;

function returnOf(p: OAuthReturn): OAuthReturn {
  return {
    ...(p.return_to ? { return_to: p.return_to } : {}),
    ...(p.return_path ? { return_path: p.return_path } : {}),
  };
}

function reapPending(): void {
  const now = Date.now();
  for (const [k, v] of PENDING) {
    if (now - v.created_at <= PENDING_TTL_MS) continue;
    PENDING.delete(k);
    // Kept a while as expired, so a late callback still links back to its app.
    USED.set(k, { mcp_id: v.mcp_id, outcome: 'expired', used_at: v.created_at + PENDING_TTL_MS, ...returnOf(v) });
  }
  for (const [k, v] of USED) {
    if (now - v.used_at > USED_STATE_TTL_MS) USED.delete(k);
  }
}

export function putPending(state: string, p: PendingAuth): void {
  reapPending();
  PENDING.set(state, p);
}

/** The pending flow of `state`, once: the state is then kept as used (`usedState`). */
export function takePending(state: string): PendingAuth | null {
  reapPending();
  const v = PENDING.get(state);
  if (!v) return null;
  PENDING.delete(state);
  USED.set(state, { mcp_id: v.mcp_id, outcome: 'in_progress', used_at: Date.now(), ...returnOf(v) });
  return v;
}

/** Record how the exchange of a used state ended, for a replayed callback. */
export function settleState(state: string, outcome: Exclude<UsedStateOutcome, 'in_progress' | 'expired'>): void {
  const used = USED.get(state);
  if (used) USED.set(state, { ...used, outcome });
}

/** A state this daemon issued whose flow is over, within `USED_STATE_TTL_MS`. */
export function usedState(state: string): UsedState | null {
  reapPending();
  return USED.get(state) ?? null;
}

/**
 * Separates the random part of a state from the MCP id it carries. The id is
 * not a secret (the publisher sees the server it authorizes), and it is never
 * read back: a callback learns its server from the flow its state names.
 */
const STATE_ID_SEPARATOR = '~';

/** A fresh state for an authorization of `mcpId`. */
export function oauthState(mcpId: string): string {
  return `${randomState()}${STATE_ID_SEPARATOR}${mcpId}`;
}

/** Test hook: forget every flow, as a restart of the daemon does. */
export function resetOAuthFlowsForTests(): void {
  PENDING.clear();
  USED.clear();
}

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

export function randomState(): string {
  return b64url(randomBytes(24));
}

/**
 * Resolve the OAuth metadata for an MCP HTTP endpoint.
 *
 * Strategy:
 *   1. Probe the MCP URL with an unauthenticated POST. If we get a 401 with
 *      a `WWW-Authenticate: Bearer resource_metadata="..."` hint, follow it.
 *   2. Otherwise try `/.well-known/oauth-protected-resource` relative to the
 *      MCP URL — if present it gives us the authorization_servers[] list.
 *   3. Fall back to `/.well-known/oauth-authorization-server` on the MCP's
 *      origin (common for self-hosted MCPs that serve auth from the same host).
 */
export async function discoverOAuth(mcpUrl: string): Promise<OAuthMetadata> {
  const origin = new URL(mcpUrl).origin;

  // (1) probe the MCP endpoint and look at the WWW-Authenticate hint
  let resourceMetadataUrl: string | undefined;
  try {
    const r = await fetch(mcpUrl, {
      method: 'POST',
      headers: { accept: 'application/json,text/event-stream', 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'timon', version: '0' } },
      }),
    });
    if (r.status === 401) {
      const www = r.headers.get('www-authenticate') || '';
      const m = www.match(/resource_metadata="([^"]+)"/i);
      if (m) resourceMetadataUrl = m[1];
    }
  } catch {
    // network failure here is fine — we fall through to well-known probing.
  }

  // (2) explicit resource-metadata URL → fetch it, follow authorization_servers
  const triedAsUrls: string[] = [];
  if (resourceMetadataUrl) {
    const rmd = await fetchJson(resourceMetadataUrl);
    const asList = Array.isArray(rmd?.authorization_servers) ? rmd.authorization_servers : [];
    for (const as of asList) {
      if (typeof as === 'string') triedAsUrls.push(asMetadataUrl(as));
    }
  }

  // (3) try /.well-known/oauth-protected-resource at the MCP's origin
  if (!triedAsUrls.length) {
    const rmd = await fetchJsonSafe(origin + '/.well-known/oauth-protected-resource');
    const asList = Array.isArray(rmd?.authorization_servers) ? rmd.authorization_servers : [];
    for (const as of asList) {
      if (typeof as === 'string') triedAsUrls.push(asMetadataUrl(as));
    }
  }

  // (4) last resort: AS metadata directly on the MCP's origin
  if (!triedAsUrls.length) {
    triedAsUrls.push(origin + '/.well-known/oauth-authorization-server');
  }

  for (const url of triedAsUrls) {
    const md = await fetchJsonSafe(url);
    const auth = typeof md?.authorization_endpoint === 'string' ? md.authorization_endpoint : null;
    const tok = typeof md?.token_endpoint === 'string' ? md.token_endpoint : null;
    if (auth && tok) {
      const reg = typeof md?.registration_endpoint === 'string' ? md.registration_endpoint : undefined;
      const scopes = Array.isArray(md?.scopes_supported)
        ? (md!.scopes_supported as unknown[]).filter((x): x is string => typeof x === 'string')
        : undefined;
      const ccm = Array.isArray(md?.code_challenge_methods_supported)
        ? (md!.code_challenge_methods_supported as unknown[]).filter((x): x is string => typeof x === 'string')
        : undefined;
      return {
        authorization_endpoint: auth,
        token_endpoint: tok,
        registration_endpoint: reg,
        scopes_supported: scopes,
        code_challenge_methods_supported: ccm,
      };
    }
  }

  throw new Error(
    'could not discover OAuth metadata for ' + mcpUrl +
    ' (tried WWW-Authenticate hint, /.well-known/oauth-protected-resource, /.well-known/oauth-authorization-server)',
  );
}

function asMetadataUrl(asIssuer: string): string {
  // Per RFC 8414 the metadata URL is /.well-known/oauth-authorization-server
  // appended to the issuer's *path*, not always its origin. For most
  // real-world MCP setups the issuer is just the origin so this is a no-op.
  const u = new URL(asIssuer);
  const path = u.pathname.replace(/\/$/, '');
  return `${u.origin}/.well-known/oauth-authorization-server${path}`;
}

async function fetchJson(url: string): Promise<Record<string, unknown>> {
  const r = await fetch(url, { headers: { accept: 'application/json' } });
  if (!r.ok) throw new Error(`fetch ${url} → ${r.status}`);
  return (await r.json()) as Record<string, unknown>;
}

async function fetchJsonSafe(url: string): Promise<Record<string, unknown> | null> {
  try {
    return await fetchJson(url);
  } catch {
    return null;
  }
}

/**
 * RFC 7591 Dynamic Client Registration. Most MCP servers don't pre-issue
 * client_ids so we register one on the fly the first time we authorize.
 */
export async function dynamicRegister(
  metadata: OAuthMetadata,
  redirectUri: string,
  clientName = 'TIMON',
): Promise<OAuthClient> {
  if (!metadata.registration_endpoint) {
    throw new Error('authorization server does not support dynamic client registration');
  }
  const r = await fetch(metadata.registration_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      client_name: clientName,
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none', // public client + PKCE
    }),
  });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw new Error(`dynamic client registration failed: ${r.status} ${body.slice(0, 200)}`);
  }
  const j = (await r.json()) as Record<string, unknown>;
  const client_id = j.client_id;
  if (typeof client_id !== 'string') throw new Error('registration response missing client_id');
  return { client_id, client_secret: typeof j.client_secret === 'string' ? j.client_secret : undefined };
}

export function buildAuthorizeUrl(
  metadata: OAuthMetadata,
  client: OAuthClient,
  redirectUri: string,
  state: string,
  challenge: string,
  scope?: string,
): string {
  const u = new URL(metadata.authorization_endpoint);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', client.client_id);
  u.searchParams.set('redirect_uri', redirectUri);
  u.searchParams.set('state', state);
  u.searchParams.set('code_challenge', challenge);
  u.searchParams.set('code_challenge_method', 'S256');
  if (scope) u.searchParams.set('scope', scope);
  return u.toString();
}

export async function exchangeCode(
  metadata: OAuthMetadata,
  client: OAuthClient,
  redirectUri: string,
  code: string,
  codeVerifier: string,
): Promise<OAuthTokens> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: client.client_id,
    code_verifier: codeVerifier,
  });
  if (client.client_secret) body.set('client_secret', client.client_secret);
  const r = await fetch(metadata.token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: body.toString(),
  });
  if (!r.ok) {
    // The status and the OAuth error code only: the provider's body may echo
    // the code it refuses, and this message reaches the callback page and the log.
    const errorCode = await r.json().then((j: unknown) => oauthErrorCode((j as { error?: unknown } | null)?.error)).catch(() => null);
    throw new OAuthExchangeError(`token exchange failed: HTTP ${r.status}${errorCode ? ` (${errorCode})` : ''}`);
  }
  return parseTokenResponse(await tokenResponseJson(r, 'token exchange failed'));
}

/**
 * The error codes a publisher may send (RFC 6749 §4.1.2.1 and §5.2, plus
 * `invalid_target` of RFC 8707, which MCP uses). A closed list: a free-form
 * value can carry anything, the code verifier included, and the code reaches
 * the page, its link and the log.
 */
export const OAUTH_ERROR_CODES = [
  'invalid_request', 'unauthorized_client', 'access_denied', 'unsupported_response_type',
  'invalid_scope', 'server_error', 'temporarily_unavailable',
  'invalid_client', 'invalid_grant', 'unsupported_grant_type', 'invalid_target',
] as const;
export type OAuthErrorCode = typeof OAUTH_ERROR_CODES[number] | 'unknown_error';

/** A known OAuth error code, else `unknown_error`: never the value itself. */
export function oauthErrorCode(value: unknown): OAuthErrorCode {
  return (OAUTH_ERROR_CODES as readonly unknown[]).includes(value) ? value as OAuthErrorCode : 'unknown_error';
}

/**
 * A failed token exchange, worded for the callback page and the log: a
 * status and a known error code at most, never the publisher's body.
 */
export class OAuthExchangeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OAuthExchangeError';
  }
}

/**
 * The JSON body of a token response. The parser's own error quotes the start
 * of what it could not read, which may be a token: it is replaced.
 */
async function tokenResponseJson(r: Response, what: string): Promise<unknown> {
  try {
    return await r.json();
  } catch {
    throw new OAuthExchangeError(`${what}: the token response is not valid JSON`);
  }
}

/**
 * A refused refresh names its HTTP status only: the provider's body may echo
 * the refresh token it refuses, and this error ends up in the daemon's log.
 */
export class OAuthRefreshError extends Error {
  constructor(readonly status: number) {
    super(`refresh failed: HTTP ${status}`);
    this.name = 'OAuthRefreshError';
  }
}

export async function refreshTokens(
  metadata: OAuthMetadata,
  client: OAuthClient,
  refreshToken: string,
): Promise<OAuthTokens> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: client.client_id,
  });
  if (client.client_secret) body.set('client_secret', client.client_secret);
  const r = await fetch(metadata.token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: body.toString(),
  });
  if (!r.ok) {
    await r.body?.cancel().catch(() => undefined);
    throw new OAuthRefreshError(r.status);
  }
  const next = parseTokenResponse(await tokenResponseJson(r, 'refresh failed'));
  // Servers may omit refresh_token on refresh → keep the old one.
  if (!next.refresh_token) next.refresh_token = refreshToken;
  return next;
}

function parseTokenResponse(j: unknown): OAuthTokens {
  const o = (j ?? {}) as Record<string, unknown>;
  const access_token = o.access_token;
  if (typeof access_token !== 'string') throw new OAuthExchangeError('token response missing access_token');
  const expires_in = typeof o.expires_in === 'number' ? o.expires_in : undefined;
  return {
    access_token,
    token_type: typeof o.token_type === 'string' ? o.token_type : 'Bearer',
    refresh_token: typeof o.refresh_token === 'string' ? o.refresh_token : undefined,
    expires_at: expires_in ? Date.now() + expires_in * 1000 : undefined,
    scope: typeof o.scope === 'string' ? o.scope : undefined,
  };
}
