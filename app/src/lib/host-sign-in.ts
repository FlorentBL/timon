/**
 * The host's own sign-in of a backend (`/api/backends/host-sign-in/:backend`,
 * TODO #426): signed in from the browser into Timon's folder, a long-lived
 * token minted in the app, or the CLI's own session from a terminal. The
 * daemon decides what is possible; this module types its answers and calls it.
 * A flow is bound to the browser session that started it.
 */
import { apiErrorMessage } from '@/lib/api-error';
import type { AccountLogin } from '@/lib/backend-accounts';
import { t } from '@/lib/i18n';

export type HostSignInView = {
  backend: string;
  /** Timon keeps the sign-in in its own folder; else the CLI's own (the terminal's session). */
  kept: boolean;
  identity: string | null;
  /** Can be signed in from the browser. */
  browser: boolean;
  /** A long-lived token can be minted in the app; `stored`: one is kept. */
  token: { stored: boolean } | null;
  /**
   * Only that token runs the host's launches: Timon is a macOS service outside
   * the user's session, where no sign-in can be read. Absent from an older daemon.
   */
  tokenOnly?: boolean;
  signedIn: boolean | null;
};

/** `login`: sign in from the browser. `token`: mint a long-lived token. */
export type HostFlowKind = 'login' | 'token';

const BASE = '/api/ui/backends/host-sign-in';

function path(backend: string, rest = ''): string {
  return `${BASE}/${encodeURIComponent(backend)}${rest}`;
}

async function readError(res: Response): Promise<string> {
  if (res.status === 401 || res.status === 403) return t('backendsSettings.errors.forbidden');
  const body = (await res.json().catch(() => ({}))) as { error?: string; reason?: string };
  return body.reason ?? apiErrorMessage(body, t('backendAccounts.errorGeneric'));
}

async function send<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    cache: 'no-store',
    ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
  if (!res.ok) throw new Error(await readError(res));
  return (await res.json()) as T;
}

/** Back to the CLI's own sign-in: Timon's folder goes. */
export async function forgetHostSignIn(backend: string): Promise<HostSignInView | null> {
  return (await send<{ hostSignIn: HostSignInView | null }>('DELETE', path(backend))).hostSignIn;
}

export async function startHostFlow(backend: string, kind: HostFlowKind): Promise<AccountLogin> {
  return (await send<{ login: AccountLogin }>('POST', path(backend, `/${kind}`), {})).login;
}

/** The session's flow, null when it has none (any more). */
export async function readHostFlow(backend: string, kind: HostFlowKind): Promise<AccountLogin | null> {
  const res = await fetch(path(backend, `/${kind}`), { cache: 'no-store' });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(await readError(res));
  return ((await res.json()) as { login: AccountLogin }).login;
}

export async function sendHostFlowCode(backend: string, kind: HostFlowKind, code: string): Promise<AccountLogin> {
  return (await send<{ login: AccountLogin }>('POST', path(backend, `/${kind}/code`), { code })).login;
}

export async function cancelHostFlow(backend: string, kind: HostFlowKind): Promise<void> {
  const res = await fetch(path(backend, `/${kind}`), { method: 'DELETE', cache: 'no-store' });
  if (!res.ok && res.status !== 404) throw new Error(await readError(res));
}
