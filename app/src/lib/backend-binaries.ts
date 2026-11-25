/**
 * The paths pinned for the backend CLIs (TODO #413), set from the Program
 * section of a provider page. The daemon validates every path and decides who
 * may pin (a superadmin signed in to the app); this module types its answers
 * and turns its codes into sentences.
 */
import { t } from '@/lib/i18n';

export type BackendBinary = {
  /** Binary name, the key of `host.binaries`. */
  cmd: string;
  /** Backend ids served by this binary. */
  backends: string[];
  /** What a mission would run now, `null` when nothing usable was found. */
  path: string | null;
  /** True when `path` comes from a pin. */
  pinned: boolean;
  /** The pinned value as configured, even when it no longer resolves. */
  pin: string | null;
};

const BASE = '/api/ui/backends/binaries';

export class BinaryPinError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = 'BinaryPinError';
  }
}

const KNOWN_CODES = [
  'unknown_binary', 'path_not_absolute', 'path_missing', 'path_not_file', 'path_not_executable',
  'wrong_program', 'no_config', 'config_unreadable', 'invalid_body',
];

/**
 * Daemon codes → sentences of the locale; never the path that was typed. `name`: the program the pin is
 * for, which `wrong_program` names (#1101: `ollama` pinned where the Codex CLI was expected).
 */
export function binaryErrorMessage(status: number, code: string, name = ''): string {
  if (status === 401 || status === 403) return t('binariesSettings.errors.forbidden');
  if (KNOWN_CODES.includes(code)) return t(`binariesSettings.errors.${code}`, { name });
  return t('binariesSettings.errors.generic', { status });
}

/**
 * What the pin field shows as an example: the program's own name, where it usually lives on the OS of
 * the daemon that runs it. That OS is read from a path the daemon already reported (a drive letter or a
 * backslash), else from the browser, which is the daemon's machine in the desktop app.
 */
export function pinPathExample(name: string, knownPaths: readonly (string | null)[], userAgent = ''): string {
  const shown = knownPaths.filter((path): path is string => typeof path === 'string' && path !== '');
  const windows = shown.length > 0
    ? shown.some((path) => /^[A-Za-z]:[\\/]|\\/.test(path))
    : /Windows/i.test(userAgent);
  return windows ? `C:\\…\\${name}.exe` : `/usr/local/bin/${name}`;
}

async function call<T>(method: string, path: string, body?: unknown, name = ''): Promise<T> {
  const response = await fetch(`${BASE}${path}`, {
    method,
    cache: 'no-store',
    ...(body !== undefined ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
  });
  const json: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const code = typeof (json as { error?: unknown } | null)?.error === 'string' ? (json as { error: string }).error : '';
    throw new BinaryPinError(response.status, code, binaryErrorMessage(response.status, code, name));
  }
  return json as T;
}

export const fetchBinaries = async (): Promise<BackendBinary[]> =>
  (await call<{ binaries: BackendBinary[] }>('GET', '')).binaries;
export const recheckBinaries = (): Promise<{ binaries: BackendBinary[]; configError: string | null }> =>
  call('POST', '/recheck');
export const pinBinary = async (cmd: string, path: string): Promise<BackendBinary[]> =>
  (await call<{ binaries: BackendBinary[] }>('PUT', `/${encodeURIComponent(cmd)}`, { path }, cmd)).binaries;
export const unpinBinary = async (cmd: string): Promise<BackendBinary[]> =>
  (await call<{ binaries: BackendBinary[] }>('DELETE', `/${encodeURIComponent(cmd)}`)).binaries;
