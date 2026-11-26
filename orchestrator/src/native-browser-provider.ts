import { readFileSync, statSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { TIMON_HOME } from './paths.js';
import { detectChromeBinary, type ChromeDetection } from './host/chrome-binary.js';
import { apiError, type ApiErrorBody } from './api-error.js';

/**
 * A refusal the browser routes answer with. It carries the coded body the
 * webview translates; a bare string is text with no code of its own (the
 * desktop's answer, a refusal written for an agent) and travels as the
 * `detail` of `browser_refused`.
 */
export class NativeBrowserError extends Error {
  readonly body: ApiErrorBody;
  constructor(cause: string | ApiErrorBody, readonly status = 400) {
    const body = typeof cause === 'string' ? apiError('browser_refused', cause, { detail: cause }) : cause;
    super(body.error);
    this.body = body;
  }
}

/** The body a browser route answers an unexpected failure with: a coded refusal, or the error's text as detail. */
export function browserErrorBody(error: unknown): ApiErrorBody {
  if (error instanceof NativeBrowserError) return error.body;
  const message = (error as Error).message;
  return apiError('browser_refused', message, { detail: message });
}

export type NativeProvider = { version: 1; origin: string; token: string; pid: number };

/** This credential is local IPC, never returned through a browser-facing API. */
export function readNativeProvider(home = TIMON_HOME): NativeProvider | null {
  try {
    const path = providerFile(home);
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > MAX_PROVIDER_BYTES) return null;
    return parseNativeProvider(readFileSync(path, 'utf8'));
  } catch { return null; }
}

/** `readNativeProvider` without holding the event loop: what a daemon route reads. */
export async function readNativeProviderAsync(home = TIMON_HOME): Promise<NativeProvider | null> {
  try {
    const path = providerFile(home);
    const info = await stat(path);
    if (!info.isFile() || info.size > MAX_PROVIDER_BYTES) return null;
    return parseNativeProvider(await readFile(path, 'utf8'));
  } catch { return null; }
}

const MAX_PROVIDER_BYTES = 4096;

function providerFile(home: string): string {
  return join(home, 'browser-native', 'provider.json');
}

function parseNativeProvider(text: string): NativeProvider | null {
  try {
    const value = JSON.parse(text) as NativeProvider;
    const url = new URL(value.origin);
    if (value.version !== 1 || url.protocol !== 'http:' || url.hostname !== '127.0.0.1'
      || !url.port || url.username || url.password || url.pathname !== '/' || url.search || url.hash
      || typeof value.token !== 'string' || value.token.length < 32 || value.token.length > 256
      || !Number.isInteger(value.pid) || value.pid <= 0) return null;
    return { ...value, origin: url.origin };
  } catch { return null; }
}

/**
 * The refusals the desktop names with a code (`BrowserCommandError.code`, desktop
 * `native-browser-protocol.ts`). Any other code is not trusted to name a translation.
 */
function providerRefusal(code: unknown): ApiErrorBody | null {
  if (code === 'browser_signin_needs_screen') {
    return apiError('browser_signin_needs_screen', 'Signing in with Chrome opens a Chrome window, and this browser runs on a machine with no screen. Sign in to the site directly in the built-in browser.');
  }
  return null;
}

export async function callNativeBrowser(
  profileId: string,
  command: Record<string, unknown>,
  options: { home?: string; timeoutMs?: number } = {},
): Promise<unknown> {
  const provider = readNativeProvider(options.home);
  if (!provider) throw new NativeBrowserError(apiError('browser_desktop_unavailable', 'Open Timon desktop on the host machine to use this browser.'), 503);
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(profileId)) throw new NativeBrowserError(apiError('browser_profile_invalid', 'Invalid browser profile.'));
  try {
    const response = await fetch(`${provider.origin}/command`, {
      method: 'POST', headers: { authorization: `Bearer ${provider.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ...command, profileId }), signal: AbortSignal.timeout(options.timeoutMs ?? 20_000),
      redirect: 'error',
    });
    const result = await response.json() as Record<string, unknown>;
    if (!response.ok) {
      // The desktop answers in English prose: it stays the technical detail, unless it names a refusal the webview translates.
      const detail = typeof result.error === 'string' ? result.error : `HTTP ${response.status}`;
      throw new NativeBrowserError(providerRefusal(result.code) ?? apiError('browser_command_failed', `Browser command failed: ${detail}`, { detail }), response.status);
    }
    return result;
  } catch (error) {
    if (error instanceof NativeBrowserError) throw error;
    throw new NativeBrowserError(apiError('browser_desktop_unavailable', 'The desktop browser is unavailable. Reopen Timon on its host machine.'), 503);
  }
}

/**
 * What the sign-in flow can use on this machine. The browser's name is shown to
 * the user; its path is not, since this answer reaches a WebUI that can be exposed.
 */
export type ChromeCapability =
  | { available: true; name: string }
  | { available: false; reason: 'none' | 'confined'; message: string };

export function chromeMissingMessage(reason: 'none' | 'confined'): string {
  return chromeMissingError(reason).error;
}

/** The coded refusal of a sign-in with no usable Chrome: the webview shows it in the reader's language. */
export function chromeMissingError(reason: 'none' | 'confined'): ApiErrorBody {
  return reason === 'confined'
    ? apiError('browser_chrome_confined', 'The only Chromium found here is a snap or flatpak package, which cannot keep a Timon profile. Install Google Chrome from its .deb or .rpm package, or set TIMON_CHROME_PATH to another Chrome, Edge or Chromium.')
    : apiError('browser_chrome_missing', 'No Google Chrome, Microsoft Edge or Chromium was found on this computer. Install Google Chrome to sign in to Google here, or sign in to the site directly in the built-in browser.');
}

export function chromeCapability(detect: () => ChromeDetection = detectChromeBinary): ChromeCapability {
  const detection = detect();
  return detection.found
    ? { available: true, name: detection.binary.name }
    : { available: false, reason: detection.reason, message: chromeMissingMessage(detection.reason) };
}

export type NativeBrowserCapabilities = {
  available: boolean;
  /** The refusal in English; `refusal` is the same, coded for the webview to translate. */
  reason?: string; refusal?: ApiErrorBody;
  chrome: ChromeCapability;
  media?: { webrtc: boolean; encoded: boolean; iceServers: unknown[] };
};

export async function nativeBrowserCapabilities(detect?: () => ChromeDetection): Promise<NativeBrowserCapabilities> {
  const chrome = chromeCapability(detect);
  try {
    await callNativeBrowser('_probe', { action: 'status' }, { timeoutMs: 1500 });
    return { available: true, chrome, media: { webrtc: true, encoded: true, iceServers: [] } };
  } catch (error) {
    const refusal = browserErrorBody(error);
    return { available: false, reason: refusal.error, refusal, chrome };
  }
}
