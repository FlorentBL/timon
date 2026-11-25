/**
 * Where the OAuth callback page sends the browser (TIM-0165). A failed
 * callback stays on a readable page of the daemon and only redirects to an
 * app URL someone configured: the default `http://timon.localhost` answers
 * only behind the Docker proxy. A state already used answers what happened to
 * it instead of "unknown state", and no code or provider body reaches the
 * page, the redirect or the log.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

const HOME = mkdtempSync(join(tmpdir(), 'timon-oauth-return-'));
process.env.TIMON_HOME = HOME;
process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';
delete process.env.TIMON_PUBLIC_APP_URL;
// The app this daemon serves itself: `http://localhost:3101` is a trusted origin.
writeFileSync(join(HOME, 'timon.config.json'), JSON.stringify({ version: 1, app: { enabled: true, listen: { port: 3101 } } }));

const { registerRoutes, trustedReturnOrigin } = await import('./plugins-bundled/agents/routes.js');
const { invalidateSettingsCache } = await import('./settings.js');
const { upsertMcp } = await import('./mcp.js');
const {
  OAUTH_CALLBACK_PATH, PENDING_MAX, USED_MAX, oauthFlowCountsForTests, oauthRedirectUri, oauthState, putPending,
  resetOAuthFlowsForTests, takePending, usedState,
} = await import('./oauth.js');
const { deleteMcp } = await import('./mcp.js');
const { apiPort } = await import('./api-url.js');

/** The configured public app URL (default `http://timon.localhost`): trusted, and distinct from the local app. */
const PUBLIC_APP = 'http://timon.localhost';
const LOCAL_APP = 'http://localhost:3101';

const SECRET_CODE = 'code-that-must-never-leak';
let tokenAnswer: { status: number; body: unknown } = { status: 200, body: { access_token: 'at', token_type: 'Bearer' } };
/** A raw body for the token endpoint, sent as JSON whatever it holds. */
let rawTokenAnswer: string | null = null;

const app = express();
app.use(express.json());
app.post('/token', (_req, res) => {
  if (rawTokenAnswer !== null) { res.status(200).type('application/json').send(rawTokenAnswer); return; }
  res.status(tokenAnswer.status).json(tokenAnswer.body);
});
registerRoutes(app);
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
test.after(() => { server.close(); });

const warnings: string[] = [];
const realWarn = console.warn;
console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')); };
test.after(() => { console.warn = realWarn; });

function startFlow(
  mcpId: string,
  back: { return_to?: string; return_path?: '/mcp' | '/apps' } = {},
  createdAt = Date.now(),
): string {
  const state = oauthState(mcpId);
  putPending(state, {
    mcp_id: mcpId, code_verifier: 'verifier', redirect_uri: `${base}${OAUTH_CALLBACK_PATH}`,
    metadata: { authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token` },
    client: { client_id: 'client' }, created_at: createdAt, ...back,
  });
  return state;
}

function backLink(html: string): string | null {
  const m = html.match(/<a href="([^"]*)">Back to Timon<\/a>/);
  return m ? m[1].replace(/&amp;/g, '&') : null;
}

async function callback(query: Record<string, string>): Promise<{ status: number; html: string }> {
  const r = await fetch(`${base}${OAUTH_CALLBACK_PATH}?${new URLSearchParams(query).toString()}`);
  return { status: r.status, html: await r.text() };
}

function redirectTarget(html: string): string | null {
  const m = html.match(/location\.replace\("([^"]*)"\)/);
  return m ? m[1] : null;
}

test('an unknown state never redirects to an unconfigured .localhost host', async () => {
  resetOAuthFlowsForTests();
  const { status, html } = await callback({ state: 'forged', code: SECRET_CODE });
  assert.equal(status, 400);
  assert.equal(redirectTarget(html), null, 'a failure stays on the page');
  assert.match(html, /unknown or expired/);
  assert.ok(backLink(html)?.startsWith(`${LOCAL_APP}/mcp?oauth=error&error=`), String(backLink(html)));
  assert.doesNotMatch(html, new RegExp(SECRET_CODE));
});

test('a forged state naming a known server never gets the origin its flow remembered', async () => {
  resetOAuthFlowsForTests();
  startFlow('cloudflare', { return_to: PUBLIC_APP, return_path: '/apps' });
  const { status, html } = await callback({ state: 'forged~cloudflare', code: SECRET_CODE });
  assert.equal(status, 400);
  assert.equal(redirectTarget(html), null);
  assert.doesNotMatch(html, /timon\.localhost/);
  assert.doesNotMatch(html, /\/apps/);
  assert.doesNotMatch(html, /cloudflare/, 'a state nobody issued names no server');
  assert.ok(backLink(html)?.startsWith(`${LOCAL_APP}/mcp?`), String(backLink(html)));
});

test('an expired flow links back to where it started, without redirecting', async () => {
  resetOAuthFlowsForTests();
  const state = startFlow('cloudflare', { return_to: PUBLIC_APP, return_path: '/apps' }, Date.now() - 11 * 60 * 1000);
  const { status, html } = await callback({ state, code: SECRET_CODE });
  assert.equal(status, 400);
  assert.match(html, /unknown or expired/);
  assert.equal(redirectTarget(html), null);
  assert.ok(backLink(html)?.startsWith(`${PUBLIC_APP}/apps?oauth=error&id=cloudflare&error=`), String(backLink(html)));
});

test('a flow whose origin is no longer trusted links to the local app instead', async () => {
  resetOAuthFlowsForTests();
  const state = startFlow('cloudflare', { return_to: 'https://evil.example' });
  const { html } = await callback({ state, error: 'access_denied' });
  assert.doesNotMatch(html, /evil\.example/);
  assert.ok(backLink(html)?.startsWith(`${LOCAL_APP}/mcp?`), String(backLink(html)));
});

test('a return origin is one the daemon knows its app under, never a third party', () => {
  assert.equal(trustedReturnOrigin(`${LOCAL_APP}/mcp?x=1`), LOCAL_APP);
  assert.equal(trustedReturnOrigin('HTTP://LOCALHOST:3101/'), LOCAL_APP);
  assert.equal(trustedReturnOrigin('http://127.0.0.1:3101'), 'http://127.0.0.1:3101');
  assert.equal(trustedReturnOrigin(`${PUBLIC_APP}/apps`), PUBLIC_APP);
  for (const hostile of [
    'https://evil.example',
    '//evil.example',
    '/\\evil.example',
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'ftp://localhost:3101',
    'http://localhost:3102',
    'https://localhost:3101',
    'http://evil.localhost',
    'http://localhost:3101@evil.example',
    'http://user:pass@localhost:3101',
    'http://%65vil.example',
    'http://evil.example%2f@localhost:3101',
    'http://timon.localhost.evil.example',
    '',
  ]) {
    assert.equal(trustedReturnOrigin(hostile), null, hostile);
  }
});

test('the start of a flow ignores an Origin or Referer of another site', async () => {
  resetOAuthFlowsForTests();
  const id = 'return-check';
  upsertMcp({
    id,
    transport: {
      type: 'http', url: `${base}/mcp`,
      oauth: {
        metadata: { authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token` },
        client: { client_id: 'client' },
        redirect_uri: oauthRedirectUri('', apiPort()),
      },
    },
  });
  for (const [headers, expected] of [
    [{ origin: 'https://evil.example', referer: 'https://evil.example/page' }, LOCAL_APP],
    [{ origin: 'null', referer: `${PUBLIC_APP}/mcp` }, PUBLIC_APP],
  ] as const) {
    const r = await fetch(`${base}/api/mcp/${id}/oauth/start`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: '{}',
    });
    assert.equal(r.status, 200, await r.clone().text());
    const { authorize_url } = await r.json() as { authorize_url: string };
    const state = new URL(authorize_url).searchParams.get('state') ?? '';
    const { html } = await callback({ state, error: 'access_denied' });
    assert.doesNotMatch(html, /evil\.example/);
    assert.ok(backLink(html)?.startsWith(`${expected}/mcp?oauth=error&id=${id}&`), String(backLink(html)));
  }
});

test('a callback replayed after a success says so, and does not redirect or notify twice', async () => {
  resetOAuthFlowsForTests();
  tokenAnswer = { status: 200, body: { access_token: 'at', token_type: 'Bearer' } };
  const state = startFlow('cloudflare', { return_to: PUBLIC_APP, return_path: '/apps' });
  const first = await callback({ state, code: SECRET_CODE });
  assert.equal(first.status, 200);
  assert.equal(redirectTarget(first.html), `${PUBLIC_APP}/apps?oauth=success&id=cloudflare`);
  assert.match(first.html, /BroadcastChannel/);

  const replay = await callback({ state, code: SECRET_CODE });
  assert.equal(replay.status, 200);
  assert.match(replay.html, /already authorized/);
  assert.equal(redirectTarget(replay.html), null);
  assert.doesNotMatch(replay.html, /BroadcastChannel/);
});

test('a callback replayed after a failure says the link was already used', async () => {
  resetOAuthFlowsForTests();
  const state = startFlow('cloudflare');
  assert.equal((await callback({ state })).status, 400, 'no code: the flow fails');
  const replay = await callback({ state, code: SECRET_CODE });
  assert.equal(replay.status, 409);
  assert.match(replay.html, /already used/);
});

test('a refused exchange names the status and the OAuth error, never the provider body', async () => {
  resetOAuthFlowsForTests();
  warnings.length = 0;
  tokenAnswer = { status: 400, body: { error: 'invalid_grant', error_description: `code ${SECRET_CODE} is invalid` } };
  const state = startFlow('cloudflare', { return_to: PUBLIC_APP });
  const { status, html } = await callback({ state, code: SECRET_CODE });
  assert.equal(status, 500);
  assert.match(html, /token exchange failed: HTTP 400 \(invalid_grant\)/);
  assert.equal(redirectTarget(html), null, 'a failure stays on the page');
  assert.doesNotMatch(html, new RegExp(SECRET_CODE));
  assert.ok(warnings.some((w) => w.includes('[mcp-oauth]')), 'the refusal is logged');
  for (const w of warnings) {
    assert.doesNotMatch(w, new RegExp(SECRET_CODE));
    assert.doesNotMatch(w, new RegExp(state.split('~')[0]), 'the state is not logged');
  }
});

test('a provider error outside the RFC list becomes unknown_error, and its description is never read', async () => {
  resetOAuthFlowsForTests();
  warnings.length = 0;
  // Shaped like a code verifier: base64url, which a pattern filter would let through.
  const VERIFIER_LIKE = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
  for (const error of [VERIFIER_LIKE, '<script>alert(1)</script>', 'login_required']) {
    const state = startFlow('cloudflare', { return_to: PUBLIC_APP });
    const { html } = await callback({ state, error, error_description: `leaked ${VERIFIER_LIKE}` });
    assert.match(html, /The publisher refused the authorization \(unknown_error\)\./);
    assert.doesNotMatch(html, new RegExp(VERIFIER_LIKE));
    assert.doesNotMatch(html, /alert\(1\)|login_required|leaked/);
  }
  const state = startFlow('cloudflare', { return_to: PUBLIC_APP });
  const { html } = await callback({ state, error: 'access_denied', error_description: 'leaked text' });
  assert.match(html, /The publisher refused the authorization \(access_denied\)\./);
  assert.ok(backLink(html)?.includes('error=The%20publisher%20refused%20the%20authorization%20(access_denied)'), String(backLink(html)));
  assert.doesNotMatch(html, /leaked/);
  for (const w of warnings) assert.doesNotMatch(w, new RegExp(`${VERIFIER_LIKE}|leaked`));
});

test('a malformed token response fails with a generic error, without an excerpt of the body', async () => {
  resetOAuthFlowsForTests();
  warnings.length = 0;
  const TOKEN = 'at-secret-that-must-not-leak';
  rawTokenAnswer = `{"access_token":"${TOKEN}",`;
  try {
    const state = startFlow('cloudflare', { return_to: PUBLIC_APP });
    const { status, html } = await callback({ state, code: SECRET_CODE });
    assert.equal(status, 500);
    assert.match(html, /token exchange failed: the token response is not valid JSON/);
    assert.doesNotMatch(html, new RegExp(TOKEN));
    for (const w of warnings) assert.doesNotMatch(w, new RegExp(TOKEN));
  } finally {
    rawTokenAnswer = null;
  }
});

test('a failure redirects only to an app URL configured on purpose', async () => {
  resetOAuthFlowsForTests();
  process.env.TIMON_PUBLIC_APP_URL = 'https://timon.example.com/';
  invalidateSettingsCache();
  try {
    const { html } = await callback({ state: 'forged' });
    const target = redirectTarget(html);
    assert.ok(target?.startsWith('https://timon.example.com/mcp?oauth=error&error='), String(target));
  } finally {
    delete process.env.TIMON_PUBLIC_APP_URL;
    invalidateSettingsCache();
  }
});

test('the flow tables never grow past their cap, the oldest entry going first', () => {
  resetOAuthFlowsForTests();
  const states = Array.from({ length: PENDING_MAX + 10 }, (_, i) => startFlow(`flood-${i}`));
  assert.equal(oauthFlowCountsForTests().pending, PENDING_MAX);
  assert.equal(takePending(states[0]), null, 'the oldest pending flow was evicted');
  assert.ok(takePending(states.at(-1)!), 'the newest is kept');

  resetOAuthFlowsForTests();
  const used: string[] = [];
  for (let i = 0; i < USED_MAX + 10; i++) {
    const state = startFlow(`used-${i}`);
    takePending(state);
    used.push(state);
  }
  assert.equal(oauthFlowCountsForTests().used, USED_MAX);
  assert.equal(usedState(used[0]), null, 'the oldest used state was evicted');
  assert.ok(usedState(used.at(-1)!));

  resetOAuthFlowsForTests();
  for (let i = 0; i < USED_MAX + 10; i++) startFlow(`expired-${i}`, {}, Date.now() - 11 * 60 * 1000);
  startFlow('fresh');
  const counts = oauthFlowCountsForTests();
  assert.equal(counts.pending, 1, 'expired flows leave the pending table');
  assert.ok(counts.used <= USED_MAX, `expired flows stay capped (${counts.used})`);
});

test('a state expires from the used table after its lifetime', () => {
  resetOAuthFlowsForTests();
  const state = startFlow('aged', {}, Date.now() - 21 * 60 * 1000);
  assert.equal(takePending(state), null);
  assert.equal(usedState(state), null, 'expired 11 minutes ago: past the used lifetime too');
});

test('deleting a server forgets its flows: its states no longer give back an origin', async () => {
  resetOAuthFlowsForTests();
  const id = 'deleted-server';
  upsertMcp({ id, transport: { type: 'http', url: `${base}/mcp` } });
  const pendingState = startFlow(id, { return_to: PUBLIC_APP, return_path: '/apps' });
  const usedOne = startFlow(id, { return_to: PUBLIC_APP, return_path: '/apps' });
  takePending(usedOne);
  const other = startFlow('kept-server');
  assert.equal(deleteMcp(id), true);
  assert.equal(usedState(usedOne), null);
  for (const state of [pendingState, usedOne]) {
    const { status, html } = await callback({ state, code: SECRET_CODE });
    assert.equal(status, 400);
    assert.doesNotMatch(html, /timon\.localhost|deleted-server/);
  }
  assert.ok(takePending(other), 'another server keeps its flow');
});

