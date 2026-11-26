/**
 * `ctx.fetchPublicImage` (permission `http:public-images`): an image from any
 * public host, without the operator opening that host in `pluginPolicy.http`.
 *
 * A mail client shows images and avatars from as many domains as it has
 * senders; an allowlist cannot be written for that, and opening `ctx.fetch` to
 * everything would hand the plugin a general-purpose client. This relay is
 * narrow instead, and every limit is the reason it can go without a list:
 *
 *  - the daemon builds the request: GET, a fixed `User-Agent`, an `Accept` for
 *    images. Nothing else the plugin passes travels (header, cookie, body), so
 *    the URL is the only thing it chooses;
 *  - public addresses only, judged on the resolved answers and pinned for the
 *    connection, every redirect judged again (`net-guard.ts`, the guard user
 *    connections already go through);
 *  - a size ceiling counted while reading, not trusted from `Content-Length`,
 *    and a deadline over the whole fetch, redirects and DNS included;
 *  - the bytes must be an image, recognised from their signature; the type
 *    handed back is that one, never the server's claim;
 *  - a quota and a concurrency cap per plugin, and the operator's switch
 *    (`pluginPolicy.publicImages`), globally or for one plugin.
 */
import { BRAND } from '../brand.js';
import { config } from '../config/load.js';
import type { Assert, Equals } from '../type-equality.js';
import type {
  PluginPublicImage, PluginPublicImageError as ContractPluginPublicImageError, PluginPublicImageErrorCode,
  PluginPublicImageType,
} from './contract/public-images.js';
import { assertUrlShape, DestinationRefusedError, guardedFetch, type AddressLookup, type DestinationPolicy } from './net-guard.js';

export type { PluginPublicImage, PluginPublicImageErrorCode, PluginPublicImageOptions, PluginPublicImageType } from './contract/public-images.js';

export class PluginPublicImageError extends Error {
  override readonly name: 'PluginPublicImageError';
  readonly status?: number;
  constructor(readonly code: PluginPublicImageErrorCode, message: string, status?: number) {
    super(message);
    this.name = 'PluginPublicImageError';
    if (status !== undefined) this.status = status;
  }
}
/** The SDK publishes this class's shape (`contract/public-images.ts`); it cannot drift from it. */
type _PublicImageErrorMatchesContract = Assert<Equals<PluginPublicImageError, ContractPluginPublicImageError>>;

/**
 * Public addresses only. Plain `http:` is admitted: plenty of mail images are
 * still served that way, and what comes back is checked to be an image.
 */
export const PUBLIC_ONLY: DestinationPolicy = Object.freeze({ allowPrivateNetwork: false, allowPlainHttp: true });
const MAX_REDIRECTS = 5;
/** Fetches of one plugin in flight at once: a page of avatars, not a crawl. */
const MAX_IN_FLIGHT = 8;
const USER_AGENT = `${BRAND.displayName.replace(/\s+/g, '')}-ImageFetch/1.0`;
const ACCEPT = 'image/avif,image/webp,image/png,image/jpeg,image/gif,image/x-icon,image/svg+xml;q=0.8,image/*;q=0.5';

/** Test seams: a fixed DNS, a wider destination policy towards a local server, a clock. */
export type PublicImageDeps = {
  lookup?: AddressLookup;
  destination?: (url: URL) => DestinationPolicy;
  now?: () => number;
};

/** Start times per plugin, kept for the current window only. */
const STARTS = new Map<string, number[]>();
const IN_FLIGHT = new Map<string, number>();

/** Test seam: forget the quotas. */
export function resetPublicImageState(): void {
  STARTS.clear();
  IN_FLIGHT.clear();
}

const fail = (code: PluginPublicImageErrorCode, message: string, status?: number) => new PluginPublicImageError(code, message, status);

const ascii = (bytes: Uint8Array, start: number, length: number) =>
  String.fromCharCode(...bytes.subarray(start, start + length));

/** ISO-BMFF `ftyp` box naming AVIF as its major or a compatible brand. */
function isAvif(bytes: Uint8Array): boolean {
  if (bytes.length < 16 || ascii(bytes, 4, 4) !== 'ftyp') return false;
  const size = ((bytes[0]! << 24) | (bytes[1]! << 16) | (bytes[2]! << 8) | bytes[3]!) >>> 0;
  const end = Math.min(size >= 16 ? size : 16, bytes.length);
  const brands = [ascii(bytes, 8, 4)];
  for (let offset = 16; offset + 4 <= end; offset += 4) brands.push(ascii(bytes, offset, 4));
  return brands.some((brand) => brand === 'avif' || brand === 'avis');
}

/**
 * Whether the text opens on an `<svg>` root: an optional byte order mark,
 * XML declaration, comments, processing instructions and doctype may come
 * first, nothing else.
 */
function isSvg(bytes: Uint8Array): boolean {
  let text = new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, 4096)).replace(/^﻿/, '');
  for (let step = 0; step < 64; step++) {
    text = text.trimStart();
    if (text.startsWith('<?')) { const end = text.indexOf('?>'); if (end < 0) return false; text = text.slice(end + 2); continue; }
    if (text.startsWith('<!--')) { const end = text.indexOf('-->'); if (end < 0) return false; text = text.slice(end + 3); continue; }
    if (/^<!doctype/i.test(text)) {
      // An internal subset (`[ … ]`) may hold `>`: skip past its closing bracket first.
      const bracket = text.indexOf('[');
      const close = text.indexOf('>');
      const from = bracket >= 0 && bracket < close ? text.indexOf(']', bracket) : 0;
      if (from < 0) return false;
      const end = text.indexOf('>', from);
      if (end < 0) return false;
      text = text.slice(end + 1);
      continue;
    }
    return /^<svg[\s>/]/.test(text);
  }
  return false;
}

/** The image format the bytes are, from their signature; `undefined` for anything else. */
export function sniffImageType(bytes: Uint8Array): PluginPublicImageType | undefined {
  const at = (offset: number, ...values: number[]) => values.every((value, i) => bytes[offset + i] === value);
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png';
  if (at(0, 0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (bytes.length >= 6 && (ascii(bytes, 0, 6) === 'GIF87a' || ascii(bytes, 0, 6) === 'GIF89a')) return 'image/gif';
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') return 'image/webp';
  if (isAvif(bytes)) return 'image/avif';
  // ICONDIR: reserved 0, type 1, at least one 16-byte entry after the 6-byte header.
  if (at(0, 0x00, 0x00, 0x01, 0x00) && bytes.length >= 22 && (bytes[4]! | (bytes[5]! << 8)) > 0) return 'image/x-icon';
  if (isSvg(bytes)) return 'image/svg+xml';
  return undefined;
}

type ParsedOptions = { maxBytes?: number; signal?: AbortSignal; svg: boolean };

function parseOptions(options: unknown): ParsedOptions {
  if (options === undefined || options === null) return { svg: false };
  if (typeof options !== 'object') throw fail('invalid', 'options must be an object');
  const { maxBytes, signal, svg } = options as Record<string, unknown>;
  if (maxBytes !== undefined && (typeof maxBytes !== 'number' || !Number.isSafeInteger(maxBytes) || maxBytes <= 0)) {
    throw fail('invalid', '`maxBytes` must be a positive integer');
  }
  if (signal !== undefined && !(signal instanceof AbortSignal)) throw fail('invalid', '`signal` must be an AbortSignal');
  if (svg !== undefined && typeof svg !== 'boolean') throw fail('invalid', '`svg` must be a boolean');
  return { maxBytes, signal, svg: svg === true };
}

function parseUrl(input: unknown): URL {
  let url: URL;
  try {
    if (input instanceof URL) url = new URL(input.href);
    else if (typeof input === 'string') url = new URL(input);
    else throw new TypeError('not a URL');
  } catch {
    throw fail('invalid', 'the image URL is not a valid absolute URL');
  }
  try { assertUrlShape(url); }
  catch (error) { throw fail('destination_refused', error instanceof Error ? error.message : 'destination refused'); }
  return url;
}

/** Takes a slot in the plugin's window and its in-flight count, or refuses. Returns the release. */
function admit(pluginId: string, max: number, windowMs: number, now: number): () => void {
  const window = STARTS.get(pluginId)?.filter((t) => now - t < windowMs) ?? [];
  if (window.length >= max) {
    STARTS.set(pluginId, window);
    throw fail('rate_limited', max === 0
      ? 'public image fetches are set to zero per window (pluginPolicy.publicImages.max)'
      : `quota reached (${max} image fetches per ${Math.round(windowMs / 1000)} s)`);
  }
  const running = IN_FLIGHT.get(pluginId) ?? 0;
  if (running >= MAX_IN_FLIGHT) throw fail('rate_limited', `${MAX_IN_FLIGHT} image fetches already in flight for this plugin`);
  window.push(now);
  STARTS.set(pluginId, window);
  IN_FLIGHT.set(pluginId, running + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const left = (IN_FLIGHT.get(pluginId) ?? 1) - 1;
    if (left > 0) IN_FLIGHT.set(pluginId, left);
    else IN_FLIGHT.delete(pluginId);
  };
}

/** `promise`, or a rejection as soon as `signal` aborts: a DNS lookup does not listen to signals. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => { signal.removeEventListener('abort', onAbort); resolve(value); },
      (error: unknown) => { signal.removeEventListener('abort', onAbort); reject(error); },
    );
  });
}

/** Reads at most `limit` bytes of the body; one more and the stream is cancelled. */
async function readCapped(body: ReadableStream<Uint8Array>, limit: number, signal: AbortSignal): Promise<Uint8Array> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await untilAborted(reader.read(), signal);
      if (done) break;
      total += value.byteLength;
      if (total > limit) throw fail('too_large', `the image is larger than ${limit} bytes`);
      chunks.push(value);
    }
  } catch (error) {
    void reader.cancel().catch(() => { /* the socket is already gone */ });
    throw error;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.byteLength; }
  return out;
}

/**
 * One image for `pluginId`. Rejects with a `PluginPublicImageError`, or with
 * the caller's own abort reason when its signal fired.
 */
export async function fetchPublicImage(pluginId: string, input: unknown, options?: unknown, deps: PublicImageDeps = {}): Promise<PluginPublicImage> {
  const policy = config().pluginPolicy.publicImages;
  if (!policy.enabled) throw fail('disabled', 'public image fetches are turned off (pluginPolicy.publicImages.enabled)');
  if (policy.denied.includes(pluginId)) throw fail('disabled', 'this plugin is listed in pluginPolicy.publicImages.denied');
  const url = parseUrl(input);
  const opts = parseOptions(options);
  opts.signal?.throwIfAborted();
  const limit = Math.min(opts.maxBytes ?? policy.maxBytes, policy.maxBytes);
  const release = admit(pluginId, policy.max, policy.windowMs, (deps.now ?? Date.now)());
  const deadline = AbortSignal.timeout(policy.timeoutMs);
  const signal = opts.signal ? AbortSignal.any([deadline, opts.signal]) : deadline;
  // Why the fetch stopped: the caller's own abort keeps its reason, the deadline is ours.
  const translate = (error: unknown): unknown => {
    if (error instanceof PluginPublicImageError) return error;
    if (opts.signal?.aborted) return opts.signal.reason;
    if (deadline.aborted) return fail('timeout', `no complete image within ${policy.timeoutMs} ms`);
    if (error instanceof DestinationRefusedError) return fail('destination_refused', error.message);
    return fail('unavailable', 'the image host could not be reached');
  };
  try {
    const response = await untilAborted(guardedFetch(url, {
      method: 'GET',
      // The whole request, by construction: nothing of the caller's is merged in.
      headers: { accept: ACCEPT, 'user-agent': USER_AGENT, 'accept-encoding': 'identity' },
      redirect: 'follow',
      signal,
    }, {
      destination: deps.destination ?? (() => PUBLIC_ONLY),
      lookup: deps.lookup,
      maxRedirects: MAX_REDIRECTS,
    }), signal);
    if (response.status < 200 || response.status > 299) {
      void response.body?.cancel().catch(() => { /* nothing to read */ });
      throw fail('unavailable', `the image host answered ${response.status}`, response.status);
    }
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > limit) {
      void response.body?.cancel().catch(() => { /* nothing to read */ });
      throw fail('too_large', `the image is larger than ${limit} bytes`);
    }
    const body = response.body ? await readCapped(response.body, limit, signal) : new Uint8Array(0);
    const contentType = sniffImageType(body);
    if (!contentType) throw fail('not_an_image', 'the body is not a PNG, JPEG, GIF, WebP, AVIF or ICO image');
    if (contentType === 'image/svg+xml' && !opts.svg) throw fail('not_an_image', 'the body is an SVG document; pass `svg: true` to accept one');
    return Object.freeze({ contentType, body, finalUrl: response.url || url.href });
  } catch (error) {
    throw translate(error);
  } finally {
    release();
  }
}
