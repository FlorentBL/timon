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
writeFileSync(join(HOME, 'timon.config.json'), JSON.stringify({ version: 1 }));

const { registerRoutes } = await import('./plugins-bundled/agents/routes.js');
const { invalidateSettingsCache } = await import('./settings.js');
const {
  OAUTH_CALLBACK_PATH, mcpIdOfState, oauthState, putPending, resetOAuthFlowsForTests,
} = await import('./oauth.js');

const SECRET_CODE = 'code-that-must-never-leak';
let tokenAnswer: { status: number; body: unknown } = { status: 200, body: { access_token: 'at', token_type: 'Bearer' } };

const app = express();
app.post('/token', (_req, res) => { res.status(tokenAnswer.status).json(tokenAnswer.body); });
registerRoutes(app);
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
test.after(() => { server.close(); });

const warnings: string[] = [];
const realWarn = console.warn;
console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')); };
test.after(() => { console.warn = realWarn; });

function startFlow(mcpId: string, back: { return_to?: string; return_path?: '/mcp' | '/apps' } = {}): string {
  const state = oauthState(mcpId);
  putPending(state, {
    mcp_id: mcpId, code_verifier: 'verifier', redirect_uri: `${base}${OAUTH_CALLBACK_PATH}`,
    metadata: { authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token` },
    client: { client_id: 'client' }, created_at: Date.now(), ...back,
  });
  return state;
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
  assert.doesNotMatch(html, /timon\.localhost/);
  assert.match(html, /unknown or expired/);
  assert.match(html, /Go back to the Timon window/);
  assert.doesNotMatch(html, new RegExp(SECRET_CODE));
});

test('an expired flow links back to where its server last started from, without redirecting', async () => {
  resetOAuthFlowsForTests();
  startFlow('cloudflare', { return_to: 'http://localhost:3101', return_path: '/apps' });
  const { status, html } = await callback({ state: `gone~cloudflare`, code: SECRET_CODE });
  assert.equal(status, 400);
  assert.equal(redirectTarget(html), null);
  assert.match(html, /href="http:\/\/localhost:3101\/apps\?oauth=error&amp;id=cloudflare&amp;error=/);
});

test('a callback replayed after a success says so, and does not redirect or notify twice', async () => {
  resetOAuthFlowsForTests();
  tokenAnswer = { status: 200, body: { access_token: 'at', token_type: 'Bearer' } };
  const state = startFlow('cloudflare', { return_to: 'http://localhost:3101', return_path: '/apps' });
  const first = await callback({ state, code: SECRET_CODE });
  assert.equal(first.status, 200);
  assert.equal(redirectTarget(first.html), 'http://localhost:3101/apps?oauth=success&id=cloudflare');
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
  const state = startFlow('cloudflare', { return_to: 'http://localhost:3101' });
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

test('a provider error that is not a code is not echoed', async () => {
  resetOAuthFlowsForTests();
  const state = startFlow('cloudflare');
  const { html } = await callback({ state, error: '<script>alert(1)</script>' });
  assert.match(html, /The publisher refused the authorization\./);
  assert.doesNotMatch(html, /alert\(1\)/);
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

test('a state carries the id of its server, and only a valid id is read back', () => {
  assert.equal(mcpIdOfState(oauthState('cloudflare')), 'cloudflare');
  assert.equal(mcpIdOfState('no-separator'), null);
  assert.equal(mcpIdOfState('abc~../etc'), null);
});
