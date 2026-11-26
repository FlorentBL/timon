import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { URL_HEADER } from './workspace-route';

/** The app folder: this file lives in `src/lib/`. */
const appDir = join(__dirname, '..', '..');

/**
 * The regression of the packaged AppImage (04/09/2026, step 5.9.6): every page
 * answered HTTP 500 with `TypeError: Invalid URL` before the proxy's
 * redirect ever reached the browser.
 *
 * The proxy (`src/proxy.ts`, the `middleware` of Next 15 and before) is
 * never called directly in production: Next wraps it in
 * `next/dist/server/web/adapter.js`, which REPARSES the `Location` header with
 * `new NextURL(location, opts)` — no base — and therefore throws on a relative
 * one. Testing the exported function alone said everything was fine (it did,
 * for three commits). So this suite drives the adapter that ships in
 * `node_modules`, not a hand-written stand-in.
 *
 * The runtime globals below are what the edge sandbox provides and plain Node
 * does not; the adapter reads them at call time. Set BEFORE Next is imported:
 * `createAsyncLocalStorage` captures `globalThis.AsyncLocalStorage` when its
 * module is first loaded, hence the dynamic imports.
 */
(globalThis as unknown as { self?: unknown }).self ??= globalThis;
(globalThis as unknown as { AsyncLocalStorage?: unknown }).AsyncLocalStorage ??= AsyncLocalStorage;

/**
 * The adapter reads `__NEXT_NO_MIDDLEWARE_URL_NORMALIZE`, which `next build`
 * inlines from `skipProxyUrlNormalize` (`build/define-env.js`). We
 * read the REAL config file rather than hardcoding `true`: if someone drops
 * that flag, these tests must fail, not silently test another product.
 */
const nextConfig = require('../../next.config.mjs').default as { skipProxyUrlNormalize?: boolean; skipMiddlewareUrlNormalize?: boolean };
process.env.__NEXT_NO_MIDDLEWARE_URL_NORMALIZE = nextConfig.skipProxyUrlNormalize ? 'true' : '';

type AdapterResult = { response: Response };

/** One request through the real proxy adapter. `url` is what the Next
 *  server builds internally (loopback-normalized), `headers` what the client
 *  actually sent. */
async function throughAdapter(
  url: string,
  headers: Record<string, string>,
  handler?: (req: unknown) => unknown,
): Promise<Response> {
  const { adapter } = await import('next/dist/server/web/adapter');
  const { proxy } = await import('../proxy');
  const out = await adapter({
    handler: (handler ?? proxy) as never,
    page: '/proxy',
    request: {
      url,
      method: 'GET',
      headers,
      body: undefined,
      signal: new AbortController().signal,
    },
  } as never) as unknown as AdapterResult;
  return out.response;
}

test('an anonymous page request survives the adapter and keeps the client origin', async () => {
  // `http://localhost:3110/...` is what the server composes from its own bind
  // address (`next-server.js:1162`); `Host` is what the browser sent.
  const res = await throughAdapter('http://localhost:3110/dashboard', { host: '127.0.0.1:3110' });
  assert.equal(res.status, 307);
  const location = res.headers.get('location');
  // Red before the fix: the adapter threw `Invalid URL` and the server
  // answered 500 — no Location at all.
  assert.ok(location, 'no Location header: the adapter swallowed the redirect');
  // Origin preserved EXACTLY, after the adapter: no hop to `localhost`, which
  // is the IPv4/IPv6 loop of step 5.9.1.
  assert.equal(location, 'http://127.0.0.1:3110/login');
});

test('an IPv6 client keeps its own origin too', async () => {
  const res = await throughAdapter('http://localhost:3110/chat', { host: '[::1]:3110' });
  assert.equal(res.headers.get('location'), 'http://[::1]:3110/login');
});

test('behind an HTTPS proxy the public origin is kept, scheme included', async () => {
  const res = await throughAdapter('http://localhost:3110/dashboard', {
    host: 'timon.example.com',
    'x-forwarded-proto': 'https',
  });
  assert.equal(res.headers.get('location'), 'https://timon.example.com/login');
});

/**
 * A `Host` the browser cannot have sent must not become the origin of our own
 * redirect, and above all must not throw: `new URL('http://x:99999')` is
 * rejected, and an unhandled throw here IS the 500 this step exists to remove.
 */
test('an unusable Host falls back instead of crashing', async () => {
  for (const host of ['evil.com:99999', 'user@evil.com', 'evil.com/login']) {
    const res = await throughAdapter('http://localhost:3110/dashboard', { host });
    assert.equal(res.status, 307, `no redirect for Host: ${host}`);
    assert.equal(res.headers.get('location'), 'http://localhost:3110/login');
  }
});

/** `X-Forwarded-Host` is not read: anyone can send it, and it would choose
 *  the origin of our redirect. */
test('X-Forwarded-Host does not move the redirect', async () => {
  const res = await throughAdapter('http://localhost:3110/dashboard', {
    host: '127.0.0.1:3110',
    'x-forwarded-host': 'evil.com',
  });
  assert.equal(res.headers.get('location'), 'http://127.0.0.1:3110/login');
});

test('a session still passes, and the redirect stays same-origin', async () => {
  const res = await throughAdapter('http://localhost:3110/dashboard', {
    host: '127.0.0.1:3110',
    cookie: 'timon_session=abc',
  });
  assert.notEqual(res.status, 307);
  assert.equal(res.headers.get('location'), null);
});

/**
 * The witness of the bug itself, kept green forever: whatever the proxy
 * does, it must never hand a relative `Location` to the adapter. This is the
 * exact response shape shipped between 5.9.1 and 5.9.6.
 */
test('a relative Location is what breaks the adapter', async () => {
  const { NextResponse } = await import('next/server');
  const relative = () => new NextResponse(null, { status: 307, headers: { location: '/login' } });
  await assert.rejects(
    () => throughAdapter('http://localhost:3110/dashboard', { host: '127.0.0.1:3110' }, relative),
    /Invalid URL/,
  );
});

/**
 * Next 16 renamed `skipMiddlewareUrlNormalize` and refuses to start when both
 * names are set, and refuses a `middleware.ts` next to `proxy.ts`: either
 * leftover would take every page down, not just the redirect.
 */
test('the config and the source tree carry the Next 16 names only', () => {
  assert.equal(nextConfig.skipProxyUrlNormalize, true);
  assert.equal(nextConfig.skipMiddlewareUrlNormalize, undefined);
  for (const ext of ['ts', 'js', 'mjs']) {
    assert.equal(existsSync(join(appDir, 'src', `middleware.${ext}`)), false, `src/middleware.${ext} would clash with src/proxy.ts`);
  }
});

test('the proxy is exported under the name Next 16 loads, with its matcher', async () => {
  const mod = await import('../proxy');
  assert.equal(typeof mod.proxy, 'function');
  assert.equal('middleware' in mod, false, 'a leftover `middleware` export would mean an unfinished rename');
  assert.ok(mod.config.matcher.length > 0);
});

test('a blank session cookie is no session', async () => {
  const res = await throughAdapter('http://localhost:3110/dashboard', {
    host: '127.0.0.1:3110',
    cookie: 'timon_session=%20%20',
  });
  assert.equal(res.status, 307);
  assert.equal(res.headers.get('location'), 'http://127.0.0.1:3110/login');
});

test('a public page is served without a session, never sent to /login', async () => {
  for (const path of ['/login', '/onboarding']) {
    const res = await throughAdapter(`http://localhost:3110${path}`, { host: '127.0.0.1:3110' });
    assert.notEqual(res.status, 307, `${path} redirected`);
    assert.equal(res.headers.get('location'), null);
  }
});

/** The layout reads the requested URL from this header to seed the workspace
 *  before the first paint; the adapter carries it as a request override. */
test('a signed-in page request forwards the requested URL to the render', async () => {
  const res = await throughAdapter('http://localhost:3110/chat?project=demo', {
    host: '127.0.0.1:3110',
    cookie: 'timon_session=abc',
  });
  assert.equal(res.headers.get(`x-middleware-request-${URL_HEADER}`), '/chat?project=demo');
  assert.ok(res.headers.get('x-middleware-override-headers')?.split(',').includes(URL_HEADER));
});
