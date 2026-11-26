/**
 * An MCP authorization started before a restart of the daemon still completes
 * after it (TODO #1199). The pending flow is sealed in the database under the
 * vault's master key: no `code_verifier` nor `state` in clear, a short life,
 * one use. A state nobody issued, an expired one, or a row the vault cannot
 * open is refused; and the route that starts a flow refuses an anonymous caller.
 */
import { createTestAccount } from '../tests/helpers/accounts.js';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

const HOME = mkdtempSync(join(tmpdir(), 'timon-oauth-pending-'));
process.env.TIMON_HOME = HOME;
process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';
delete process.env.TIMON_PUBLIC_APP_URL;
writeFileSync(join(HOME, 'timon.config.json'), JSON.stringify({ version: 1, app: { enabled: true, listen: { port: 3101 } } }));

await import('../tests/helpers/paid-license.js');
const { createDaemonAuthMiddleware } = await import('./plugins-bundled/http/auth.js');
const { dbApi, db } = await import('./db.js');
const { hashPassword } = await import('./users/password.js');
const { registerRoutes } = await import('./plugins-bundled/agents/routes.js');
const { upsertMcp, getMcp } = await import('./mcp.js');
const { readMcpOAuthTokens } = await import('./mcp-oauth-store.js');
const { apiPort } = await import('./api-url.js');
const { isSealed } = await import('./secrets/box.js');
const { setActiveModules, resetActiveModules } = await import('./kernel/module-state.js');
const { sealedColumnRows } = await import('./secrets/sealed-columns.js');
const {
  OAUTH_CALLBACK_PATH, oauthRedirectUri, oauthState, putPending, resetOAuthFlowsForTests, restartOAuthFlowsForTests,
} = await import('./oauth.js');
const { pendingFlowRowsForTests } = await import('./mcp-oauth-pending.js');

const DAEMON_TOKEN = 'witness-daemon-token';
const PUBLIC_APP = 'http://timon.localhost';
const SECRET_CODE = 'code-that-must-never-leak';

// One account exists: anonymous is no longer the first-run setup.
createTestAccount(dbApi, { email: 'robin@example.com', name: 'Robin', passwordHash: await hashPassword('super-secret'), isSuperadmin: true });

/** The publisher, on its own server: it records what the token exchange sent. */
const exchanges: URLSearchParams[] = [];
const publisher = express();
publisher.post('/token', express.urlencoded({ extended: false }), (req, res) => {
  exchanges.push(new URLSearchParams(req.body as Record<string, string>));
  res.json({ access_token: 'at-after-restart', token_type: 'Bearer' });
});
const publisherServer = publisher.listen(0, '127.0.0.1');
await once(publisherServer, 'listening');
const issuer = `http://127.0.0.1:${(publisherServer.address() as AddressInfo).port}`;

// The real MCP routes, behind the real middleware.
const app = express();
app.use(createDaemonAuthMiddleware({ token: DAEMON_TOKEN, required: true }));
app.use(express.json());
registerRoutes(app);
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
test.after(() => { server.close(); publisherServer.close(); });

const warnings: string[] = [];
const realWarn = console.warn;
console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')); };
test.after(() => { console.warn = realWarn; });

function addServer(id: string): void {
  upsertMcp({
    id,
    transport: {
      type: 'http', url: `${issuer}/mcp/${id}`,
      oauth: {
        metadata: { authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token` },
        client: { client_id: 'client' },
        redirect_uri: oauthRedirectUri('', apiPort()),
      },
    },
  });
}

/** Starts a flow the way the app does, and returns its authorize URL. */
async function start(id: string): Promise<URL> {
  const r = await fetch(`${base}/api/mcp/${id}/oauth/start`, {
    method: 'POST',
    headers: { authorization: `Bearer ${DAEMON_TOKEN}`, 'content-type': 'application/json', referer: `${PUBLIC_APP}/apps` },
    body: JSON.stringify({ return_path: '/apps' }),
  });
  assert.equal(r.status, 200, await r.clone().text());
  return new URL(((await r.json()) as { authorize_url: string }).authorize_url);
}

async function callback(query: Record<string, string>): Promise<{ status: number; html: string }> {
  const r = await fetch(`${base}${OAUTH_CALLBACK_PATH}?${new URLSearchParams(query).toString()}`);
  return { status: r.status, html: await r.text() };
}

function backLink(html: string): string | null {
  const m = html.match(/<a href="([^"]*)">Back to Timon<\/a>/);
  return m ? m[1].replace(/&amp;/g, '&') : null;
}

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

test('an anonymous caller cannot start a flow, and its forged callback is refused', async () => {
  resetOAuthFlowsForTests();
  addServer('anon-check');
  const r = await fetch(`${base}/api/mcp/anon-check/oauth/start`, { method: 'POST' });
  assert.equal(r.status, 401);
  assert.equal(pendingFlowRowsForTests().length, 0, 'nothing stored for an anonymous caller');
  const { status, html } = await callback({ state: oauthState('anon-check'), code: SECRET_CODE });
  assert.equal(status, 400);
  assert.match(html, /unknown or expired/);
});

test('a flow started before a restart completes after it', async () => {
  resetOAuthFlowsForTests();
  exchanges.length = 0;
  addServer('survivor');
  const authorize = await start('survivor');
  const state = authorize.searchParams.get('state') ?? '';
  const challenge = authorize.searchParams.get('code_challenge') ?? '';
  assert.ok(state && challenge);

  restartOAuthFlowsForTests();
  const { status, html } = await callback({ state, code: SECRET_CODE });
  assert.equal(status, 200, html);
  assert.equal(exchanges.length, 1);
  const verifier = exchanges[0].get('code_verifier') ?? '';
  assert.equal(b64url(createHash('sha256').update(verifier).digest()), challenge, 'the verifier the flow was started with');
  assert.equal(exchanges[0].get('code'), SECRET_CODE);
  const saved = getMcp('survivor');
  assert.ok(saved && saved.transport.type === 'http');
  assert.equal(readMcpOAuthTokens('survivor', saved.transport.url)?.access_token, 'at-after-restart');
  assert.equal(pendingFlowRowsForTests().length, 0, 'a used flow leaves the table at once');
  assert.ok(backLink(html)?.startsWith(`${PUBLIC_APP}/apps?oauth=success&id=survivor`), String(backLink(html)));

  // One use only, across processes too.
  restartOAuthFlowsForTests();
  const replay = await callback({ state, code: SECRET_CODE });
  assert.equal(replay.status, 400);
  assert.equal(exchanges.length, 1, 'no second exchange');
});

test('the stored flow is sealed: neither the verifier nor the state in clear', async () => {
  resetOAuthFlowsForTests();
  exchanges.length = 0;
  addServer('sealed');
  const state = (await start('sealed')).searchParams.get('state') ?? '';
  const rows = pendingFlowRowsForTests();
  assert.equal(rows.length, 1);
  const [row] = rows;
  assert.ok(isSealed(row.flow), 'the flow is a vault envelope');
  assert.equal(row.state_hash, createHash('sha256').update(state).digest('hex'));
  assert.equal(row.mcp_id, 'sealed');
  assert.equal(row.return_to, PUBLIC_APP);
  assert.equal(row.return_path, '/apps');
  const raw = JSON.stringify(rows);
  assert.doesNotMatch(raw, new RegExp(state.split('~')[0]), 'the state is never stored');
  assert.doesNotMatch(raw, /code_verifier|verifier/);
  // The envelope rotates with the vault.
  assert.ok(sealedColumnRows().some((r) => r.spec.table === 'mcp_oauth_pending' && r.key === row.state_hash));

  // The verifier the exchange receives appears nowhere in the table.
  restartOAuthFlowsForTests();
  await callback({ state, code: SECRET_CODE });
  const verifier = exchanges[0]?.get('code_verifier') ?? '';
  assert.ok(verifier.length > 20);
  assert.doesNotMatch(raw, new RegExp(verifier));
  for (const w of warnings) {
    assert.doesNotMatch(w, new RegExp(verifier));
    assert.doesNotMatch(w, new RegExp(state.split('~')[0]));
  }
});

test('a flow that expired across the restart is refused, deleted, and links back to its app', async () => {
  resetOAuthFlowsForTests();
  exchanges.length = 0;
  const state = oauthState('late');
  putPending(state, {
    mcp_id: 'late', code_verifier: 'verifier-late', redirect_uri: `${base}${OAUTH_CALLBACK_PATH}`,
    metadata: { authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token` },
    client: { client_id: 'client' }, created_at: Date.now() - 11 * 60 * 1000,
    return_to: PUBLIC_APP, return_path: '/apps',
  });
  assert.equal(pendingFlowRowsForTests().length, 1);
  restartOAuthFlowsForTests();
  const { status, html } = await callback({ state, code: SECRET_CODE });
  assert.equal(status, 400);
  assert.match(html, /unknown or expired/);
  assert.equal(exchanges.length, 0);
  assert.equal(pendingFlowRowsForTests().length, 0, 'the expired row is cleaned');
  assert.ok(backLink(html)?.startsWith(`${PUBLIC_APP}/apps?oauth=error&id=late&`), String(backLink(html)));
  // A forged state naming the same server gets nothing of it.
  const forged = await callback({ state: 'forged~late', code: SECRET_CODE });
  assert.equal(forged.status, 400);
  assert.doesNotMatch(forged.html, /timon\.localhost|id=late/);
});

test('an unknown state after a restart is refused without an exchange', async () => {
  resetOAuthFlowsForTests();
  exchanges.length = 0;
  addServer('known');
  await start('known');
  restartOAuthFlowsForTests();
  const { status, html } = await callback({ state: oauthState('known'), code: SECRET_CODE });
  assert.equal(status, 400);
  assert.match(html, /unknown or expired/);
  assert.equal(exchanges.length, 0);
  assert.equal(pendingFlowRowsForTests().length, 1, 'the real flow is untouched');
});

test('a row moved under another state does not open: refused, never exchanged', async () => {
  resetOAuthFlowsForTests();
  exchanges.length = 0;
  addServer('swap-a');
  addServer('swap-b');
  const a = (await start('swap-a')).searchParams.get('state') ?? '';
  await start('swap-b');
  const rows = pendingFlowRowsForTests();
  const rowA = rows.find((r) => r.mcp_id === 'swap-a')!;
  const rowB = rows.find((r) => r.mcp_id === 'swap-b')!;
  // B's envelope under A's key: bound to B's identity, it must not open as A's.
  db.prepare(`UPDATE mcp_oauth_pending SET flow = ? WHERE state_hash = ?`).run(rowB.flow, rowA.state_hash);
  restartOAuthFlowsForTests();
  const { status, html } = await callback({ state: a, code: SECRET_CODE });
  assert.equal(status, 400);
  assert.match(html, /unknown or expired/);
  assert.equal(exchanges.length, 0);
});

test('without a vault a flow stays in memory only, and a restart loses it', async () => {
  resetOAuthFlowsForTests();
  exchanges.length = 0;
  addServer('no-vault');
  setActiveModules(['core-db']);
  try {
    const state = (await start('no-vault')).searchParams.get('state') ?? '';
    assert.equal(pendingFlowRowsForTests().length, 0, 'nothing written in clear');
    assert.ok(warnings.some((w) => w.includes('kept in memory only')));
    restartOAuthFlowsForTests();
    const { status } = await callback({ state, code: SECRET_CODE });
    assert.equal(status, 400);
    assert.equal(exchanges.length, 0);
  } finally {
    resetActiveModules();
  }
});

test('deleting a server deletes its stored flows', async () => {
  resetOAuthFlowsForTests();
  addServer('gone');
  addServer('stays');
  await start('gone');
  await start('stays');
  const { deleteMcp } = await import('./mcp.js');
  assert.equal(deleteMcp('gone'), true);
  assert.deepEqual(pendingFlowRowsForTests().map((r) => r.mcp_id), ['stays']);
});
