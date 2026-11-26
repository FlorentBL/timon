/**
 * `ctx.fetchPublicImage`: every refusal, and the one path that hands bytes
 * back. The network is a local server; the default destination policy (public
 * addresses only) is exercised on literals and fixed DNS answers, and opened
 * to the test server's name alone through the `destination` seam.
 */
import '../test-home.js';
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

const { TimonConfigSchema } = await import('../config/schema.js');
const { setConfig, resetConfig } = await import('../config/load.js');
const {
  fetchPublicImage, PluginPublicImageError, PUBLIC_ONLY, resetPublicImageState, sniffImageType,
} = await import('./public-image.js');
type PublicImageDeps = import('./public-image.js').PublicImageDeps;
type ErrorCode = import('./public-image.js').PluginPublicImageErrorCode;
type AddressLookup = import('./net-guard.js').AddressLookup;

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
const SVG = '<?xml version="1.0"?>\n<!-- logo -->\n<!DOCTYPE svg [ <!ENTITY a "b"> ]>\n<svg xmlns="http://www.w3.org/2000/svg"></svg>';

let server: Server;
let port = 0;
let seen: { method?: string; headers: IncomingHttpHeaders; url?: string }[] = [];
before(async () => {
  server = createServer((req, res) => {
    seen.push({ method: req.method, headers: req.headers, url: req.url });
    const path = req.url ?? '/';
    if (path === '/png') { res.writeHead(200, { 'content-type': 'text/plain' }); res.end(PNG); return; }
    if (path === '/html') { res.writeHead(200, { 'content-type': 'image/png' }); res.end('<html><body>hi</body></html>'); return; }
    if (path === '/svg') { res.writeHead(200, { 'content-type': 'text/xml' }); res.end(SVG); return; }
    if (path === '/missing') { res.writeHead(404); res.end('no'); return; }
    if (path === '/declared-big') { res.writeHead(200, { 'content-length': '5000' }); res.end(Buffer.concat([PNG, Buffer.alloc(5000 - PNG.length)])); return; }
    if (path === '/streamed-big') {
      // No Content-Length: only counting while reading can stop it.
      res.writeHead(200, { 'transfer-encoding': 'chunked' });
      res.write(PNG);
      for (let i = 0; i < 8; i++) res.write(Buffer.alloc(512));
      res.end();
      return;
    }
    if (path === '/slow') { res.writeHead(200); res.write(PNG.subarray(0, 4)); return; /* never ends */ }
    if (path === '/to-png') { res.writeHead(302, { location: '/png' }); res.end(); return; }
    if (path === '/to-metadata') { res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' }); res.end(); return; }
    if (path === '/to-lan') { res.writeHead(301, { location: 'http://lan.test/logo.png' }); res.end(); return; }
    if (path === '/to-v6-mapped') { res.writeHead(307, { location: 'http://[::ffff:127.0.0.1]/png' }); res.end(); return; }
    if (path === '/loop') { res.writeHead(302, { location: '/loop' }); res.end(); return; }
    res.writeHead(500); res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});
after(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  resetConfig();
  resetPublicImageState();
});

function policy(publicImages: Record<string, unknown> = {}): void {
  setConfig(TimonConfigSchema.parse({ pluginPolicy: { publicImages } }));
}
beforeEach(() => {
  policy();
  resetPublicImageState();
  seen = [];
});

let lookups = 0;
const fixed = (table: Record<string, string[]>): AddressLookup => async (host) => {
  lookups += 1;
  const answers = table[host];
  if (!answers) throw new Error('ENOTFOUND');
  return answers.map((address) => ({ address, family: address.includes(':') ? 6 as const : 4 as const }));
};
const lookup = fixed({
  'img.test': ['127.0.0.1'],
  'lan.test': ['10.0.0.5'],
  'mixed.test': ['93.184.216.34', '169.254.169.254'],
  'six.test': ['fe80::1'],
});
/** The test server's name is opened; every other host keeps the production policy. */
const deps: PublicImageDeps = {
  lookup,
  destination: (url) => (url.hostname === 'img.test' ? { allowPrivateNetwork: true, allowPlainHttp: true } : PUBLIC_ONLY),
};
const at = (path: string) => `http://img.test:${port}${path}`;

async function refused(promise: Promise<unknown>, code: ErrorCode, pattern?: RegExp): Promise<InstanceType<typeof PluginPublicImageError>> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof PluginPublicImageError, `expected a PluginPublicImageError, got ${String(error)}`);
    assert.equal(error.name, 'PluginPublicImageError');
    assert.equal(error.code, code, error.message);
    if (pattern) assert.match(error.message, pattern);
    return error;
  }
  assert.fail(`expected a \`${code}\` refusal`);
}

test('an image comes back with the type its bytes have, not the one the server claimed', async () => {
  const image = await fetchPublicImage('mail', at('/png'), undefined, deps);
  assert.equal(image.contentType, 'image/png');
  assert.ok(image.body instanceof Uint8Array);
  assert.deepEqual(Buffer.from(image.body), PNG);
  assert.equal(image.finalUrl, at('/png'));
  assert.equal(lookups > 0, true);
});

test('the request is a bare GET: nothing the plugin passes beyond the URL travels', async () => {
  const smuggled = { method: 'POST', body: 'secret', headers: { cookie: 'session=1', authorization: 'Bearer t' }, credentials: 'include' };
  await fetchPublicImage('mail', at('/png'), smuggled, deps);
  const request = seen.at(-1)!;
  assert.equal(request.method, 'GET');
  assert.deepEqual(Object.keys(request.headers).sort(), ['accept', 'accept-encoding', 'connection', 'host', 'user-agent']);
  assert.match(String(request.headers.accept), /^image\//);
  assert.match(String(request.headers['user-agent']), /ImageFetch\/1\.0$/);
});

test('the DNS answer that was checked is the one connected to', async () => {
  lookups = 0;
  await fetchPublicImage('mail', at('/png'), undefined, deps);
  // One resolution, judged, then pinned: the socket never asks DNS a second time.
  assert.equal(lookups, 1);
});

test('only http and https, and never credentials in the URL', async () => {
  await refused(fetchPublicImage('mail', 'ftp://img.test/logo.png', undefined, deps), 'destination_refused', /scheme/);
  await refused(fetchPublicImage('mail', 'file:///etc/passwd', undefined, deps), 'destination_refused', /scheme/);
  await refused(fetchPublicImage('mail', 'data:image/png;base64,iVBORw0KGgo=', undefined, deps), 'destination_refused', /scheme/);
  await refused(fetchPublicImage('mail', `http://user:pw@img.test:${port}/png`, undefined, deps), 'destination_refused', /credentials/);
  assert.equal(seen.length, 0);
});

test('private, loopback, link-local, metadata and their IPv6 forms are refused', async () => {
  for (const url of [
    'http://127.0.0.1/a.png', 'http://10.1.2.3/a.png', 'http://192.168.1.1/a.png', 'http://172.16.0.1/a.png',
    'http://100.100.100.200/a.png', 'http://169.254.169.254/latest/meta-data/', 'http://0.0.0.0/a.png',
    'http://[::1]/a.png', 'http://[fe80::1]/a.png', 'http://[fd00:ec2::254]/a.png', 'http://[fc00::1]/a.png',
    'http://[::ffff:127.0.0.1]/a.png', 'http://[::ffff:169.254.169.254]/a.png', 'http://[64:ff9b::a9fe:a9fe]/a.png',
    'http://[2002:a9fe:a9fe::1]/a.png', 'http://lan.test/a.png', 'http://six.test/a.png',
  ]) {
    await refused(fetchPublicImage('mail', url, undefined, { lookup }), 'destination_refused');
  }
});

test('a name with one bad answer among good ones is refused, and so is a name that does not resolve', async () => {
  await refused(fetchPublicImage('mail', 'https://mixed.test/a.png', undefined, { lookup }), 'destination_refused', /never reachable/);
  await refused(fetchPublicImage('mail', 'https://nowhere.test/a.png', undefined, { lookup }), 'destination_refused', /does not resolve/);
});

test('redirects are followed by hand and every hop goes through the guard', async () => {
  const image = await fetchPublicImage('mail', at('/to-png'), undefined, deps);
  assert.equal(image.finalUrl, at('/png'));
  await refused(fetchPublicImage('mail', at('/to-metadata'), undefined, deps), 'destination_refused', /never reachable/);
  await refused(fetchPublicImage('mail', at('/to-lan'), undefined, deps), 'destination_refused', /private/);
  await refused(fetchPublicImage('mail', at('/to-v6-mapped'), undefined, deps), 'destination_refused', /loopback/);
  seen = [];
  await refused(fetchPublicImage('mail', at('/loop'), undefined, deps), 'destination_refused', /too many redirects/);
  assert.equal(seen.length, 6, 'the first request and five redirects, then a refusal');
});

test('the size ceiling holds on the declared length and while reading', async () => {
  await refused(fetchPublicImage('mail', at('/declared-big'), { maxBytes: 1000 }, deps), 'too_large');
  await refused(fetchPublicImage('mail', at('/streamed-big'), { maxBytes: 1000 }, deps), 'too_large');
  // The operator's ceiling wins over a larger request.
  policy({ maxBytes: 1000 });
  await refused(fetchPublicImage('mail', at('/streamed-big'), { maxBytes: 10_000_000 }, deps), 'too_large');
  assert.equal((await fetchPublicImage('mail', at('/png'), { maxBytes: 10_000_000 }, deps)).contentType, 'image/png');
});

test('a host that never finishes is cut at the deadline', async () => {
  policy({ timeoutMs: 300 });
  const started = Date.now();
  await refused(fetchPublicImage('mail', at('/slow'), undefined, deps), 'timeout');
  assert.ok(Date.now() - started < 5_000);
});

test('the caller\'s own abort rejects with its reason, not a refusal', async () => {
  const controller = new AbortController();
  const pending = fetchPublicImage('mail', at('/slow'), { signal: controller.signal }, deps);
  setTimeout(() => controller.abort(new Error('closed by the user')), 50);
  await assert.rejects(pending, /closed by the user/);
  const aborted = AbortSignal.abort();
  await assert.rejects(fetchPublicImage('mail', at('/png'), { signal: aborted }, deps), { name: 'AbortError' });
});

test('anything that is not an image is refused, whatever its Content-Type', async () => {
  await refused(fetchPublicImage('mail', at('/html'), undefined, deps), 'not_an_image');
});

test('an SVG comes back only when the call asks for one, typed as SVG', async () => {
  await refused(fetchPublicImage('mail', at('/svg'), undefined, deps), 'not_an_image', /svg: true/);
  const image = await fetchPublicImage('mail', at('/svg'), { svg: true }, deps);
  assert.equal(image.contentType, 'image/svg+xml');
});

test('an error status is `unavailable` and carries the status', async () => {
  const error = await refused(fetchPublicImage('mail', at('/missing'), undefined, deps), 'unavailable');
  assert.equal(error.status, 404);
});

test('a malformed URL or option is `invalid`', async () => {
  await refused(fetchPublicImage('mail', '/relative.png', undefined, deps), 'invalid');
  await refused(fetchPublicImage('mail', 42, undefined, deps), 'invalid');
  await refused(fetchPublicImage('mail', at('/png'), { maxBytes: -1 }, deps), 'invalid');
  await refused(fetchPublicImage('mail', at('/png'), { maxBytes: 1.5 }, deps), 'invalid');
  await refused(fetchPublicImage('mail', at('/png'), { signal: 'stop' }, deps), 'invalid');
  await refused(fetchPublicImage('mail', at('/png'), { svg: 'yes' }, deps), 'invalid');
});

test('each plugin has its own quota per window', async () => {
  policy({ max: 2, windowMs: 60_000 });
  let now = 1_000_000;
  const clock = { ...deps, now: () => now };
  await fetchPublicImage('mail', at('/png'), undefined, clock);
  await fetchPublicImage('mail', at('/png'), undefined, clock);
  await refused(fetchPublicImage('mail', at('/png'), undefined, clock), 'rate_limited', /quota/);
  // Another plugin is not charged for this one.
  await fetchPublicImage('other', at('/png'), undefined, clock);
  now += 60_001;
  await fetchPublicImage('mail', at('/png'), undefined, clock);
  policy({ max: 0 });
  await refused(fetchPublicImage('mail', at('/png'), undefined, clock), 'rate_limited', /zero/);
});

test('a plugin cannot keep more than eight fetches in flight', async () => {
  const controller = new AbortController();
  const running = Array.from({ length: 8 }, () => fetchPublicImage('mail', at('/slow'), { signal: controller.signal }, deps));
  await refused(fetchPublicImage('mail', at('/png'), undefined, deps), 'rate_limited', /in flight/);
  controller.abort(new Error('done'));
  await Promise.allSettled(running);
  assert.equal((await fetchPublicImage('mail', at('/png'), undefined, deps)).contentType, 'image/png');
});

test('the operator turns it off for everyone or for one plugin', async () => {
  policy({ enabled: false });
  await refused(fetchPublicImage('mail', at('/png'), undefined, deps), 'disabled', /enabled/);
  policy({ denied: ['mail'] });
  await refused(fetchPublicImage('mail', at('/png'), undefined, deps), 'disabled', /denied/);
  assert.equal((await fetchPublicImage('other', at('/png'), undefined, deps)).contentType, 'image/png');
  assert.equal(seen.length, 1, 'a refused plugin sends nothing');
});

test('formats are recognised from their signature', () => {
  const bytes = (...parts: (string | number[])[]) => new Uint8Array(Buffer.concat(parts.map((part) => (typeof part === 'string' ? Buffer.from(part, 'latin1') : Buffer.from(part)))));
  assert.equal(sniffImageType(new Uint8Array(PNG)), 'image/png');
  assert.equal(sniffImageType(bytes([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg');
  assert.equal(sniffImageType(bytes('GIF89a', [1, 0, 1, 0])), 'image/gif');
  assert.equal(sniffImageType(bytes('GIF87a')), 'image/gif');
  assert.equal(sniffImageType(bytes('RIFF', [0, 0, 0, 0], 'WEBPVP8 ')), 'image/webp');
  assert.equal(sniffImageType(bytes([0, 0, 0, 0x1c], 'ftypavif', [0, 0, 0, 0], 'mif1miaf')), 'image/avif');
  assert.equal(sniffImageType(bytes([0, 0, 0, 0x1c], 'ftypmif1', [0, 0, 0, 0], 'avifmiaf')), 'image/avif');
  assert.equal(sniffImageType(bytes([0, 0, 0, 0x18], 'ftypheic', [0, 0, 0, 0], 'mif1heic')), undefined);
  assert.equal(sniffImageType(bytes([0, 0, 1, 0, 1, 0], new Array<number>(16).fill(0))), 'image/x-icon');
  assert.equal(sniffImageType(bytes([0, 0, 1, 0, 0, 0], new Array<number>(16).fill(0))), undefined);
  assert.equal(sniffImageType(new TextEncoder().encode('﻿  <svg viewBox="0 0 1 1"/>')), 'image/svg+xml');
  assert.equal(sniffImageType(new TextEncoder().encode(SVG)), 'image/svg+xml');
  assert.equal(sniffImageType(new TextEncoder().encode('<html><svg></svg></html>')), undefined);
  assert.equal(sniffImageType(new TextEncoder().encode('<svgfoo/>')), undefined);
  assert.equal(sniffImageType(new TextEncoder().encode('{"image": "no"}')), undefined);
  assert.equal(sniffImageType(new Uint8Array(0)), undefined);
});
