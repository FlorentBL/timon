/**
 * `ctx.fetchPublicImage` (API 20, permission `http:public-images`): an image
 * from any public host, without an entry in the operator's allowlist.
 *
 * The daemon makes the request, not the plugin: a GET with a fixed
 * `User-Agent` and an `Accept` for images, nothing else the plugin could
 * choose (no header, cookie or body), towards public addresses only, every
 * redirect judged again. What comes back is what the bytes are, never what
 * the server claimed.
 */

/** The formats recognised from the bytes. `image/svg+xml` only when the call asked for it. */
export type PluginPublicImageType =
  | 'image/png'
  | 'image/jpeg'
  | 'image/gif'
  | 'image/webp'
  | 'image/avif'
  | 'image/x-icon'
  | 'image/svg+xml';

export type PluginPublicImageOptions = {
  /** Largest body accepted, in bytes. Capped by the operator's `pluginPolicy.publicImages.maxBytes`. */
  maxBytes?: number;
  /** Cancels the fetch; the call then rejects with the signal's reason. */
  signal?: AbortSignal;
  /**
   * Accept an SVG document. Off by default: an SVG can carry scripts and
   * links, so a plugin that asks for one must sanitise it, or show it only
   * where scripts never run (an `<img>`), and never serve it from its own
   * routes as `image/svg+xml`.
   */
  svg?: boolean;
};

export type PluginPublicImage = Readonly<{
  /** Detected from the bytes; the server's `Content-Type` is ignored. */
  contentType: PluginPublicImageType;
  body: Uint8Array;
  /** The URL that answered, after redirects. */
  finalUrl: string;
}>;

/**
 * `invalid` (the URL or an option is malformed), `destination_refused` (a
 * scheme other than http(s), credentials in the URL, a host that does not
 * resolve, a private, loopback, link-local or metadata address, at the first
 * request or after a redirect, or too many redirects), `not_an_image` (the
 * bytes are no recognised format, or an SVG the call did not ask for),
 * `too_large` (over `maxBytes`), `timeout` (over the operator's
 * `pluginPolicy.publicImages.timeoutMs`), `rate_limited` (over this plugin's
 * quota), `disabled` (the operator turned the capability off, for every
 * plugin or this one), `unavailable` (the host answered with an error status,
 * in `status`, or the connection failed).
 */
export type PluginPublicImageErrorCode =
  | 'invalid'
  | 'destination_refused'
  | 'not_an_image'
  | 'too_large'
  | 'timeout'
  | 'rate_limited'
  | 'disabled'
  | 'unavailable';

/**
 * What `ctx.fetchPublicImage` rejects with. The class lives in the daemon, so
 * a plugin tells it by `name`, then reads `code`.
 */
export interface PluginPublicImageError extends Error {
  readonly name: 'PluginPublicImageError';
  readonly code: PluginPublicImageErrorCode;
  /** HTTP status of the answer, for `unavailable` when the host answered. */
  readonly status?: number;
}
