import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { TIMON_HOME } from './paths.js';
import { apiError, type ApiErrorBody } from './api-error.js';

/**
 * A refusal the computer-use routes answer with. A bare string is text with no
 * code of its own (the desktop's answer) and travels as the `detail` of
 * `computer_command_failed`.
 */
export class NativeComputerError extends Error {
  readonly body: ApiErrorBody;
  constructor(cause: string | ApiErrorBody, readonly status = 400) {
    const body = typeof cause === 'string' ? apiError('computer_command_failed', cause, { detail: cause }) : cause;
    super(body.error);
    this.body = body;
  }
}

/** The body a computer route answers an unexpected failure with. */
export function computerErrorBody(error: unknown): ApiErrorBody {
  if (error instanceof NativeComputerError) return error.body;
  const message = (error as Error).message;
  return apiError('computer_command_failed', message, { detail: message });
}

export type ComputerProvider = { version: 1; origin: string; token: string; pid: number };
export type ComputerActor = 'agent' | 'human';

/** This credential is local IPC, never returned through a browser-facing API. */
export function readComputerProvider(home = TIMON_HOME): ComputerProvider | null {
  try {
    const path = join(home, 'computer-native', 'provider.json');
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > 4096) return null;
    const value = JSON.parse(readFileSync(path, 'utf8')) as ComputerProvider;
    const url = new URL(value.origin);
    if (value.version !== 1 || url.protocol !== 'http:' || url.hostname !== '127.0.0.1'
      || !url.port || url.username || url.password || url.pathname !== '/' || url.search || url.hash
      || typeof value.token !== 'string' || value.token.length < 32 || value.token.length > 256
      || !Number.isInteger(value.pid) || value.pid <= 0) return null;
    return { ...value, origin: url.origin };
  } catch { return null; }
}

/** The desktop answers with a code (`computer_stopped`) or with prose; both end as a coded refusal. */
function desktopRefusal(error: unknown, status: number, secrets: readonly string[]): NativeComputerError {
  const record = error && typeof error === 'object' ? error as { code?: unknown; message?: unknown } : null;
  const code = typeof error === 'string' ? error : typeof record?.code === 'string' ? record.code : '';
  if (code === 'computer_stopped') {
    return new NativeComputerError(apiError('computer_stopped', 'Computer use was stopped by the user. They must resume it first.'), 409);
  }
  let detail = typeof error === 'string' ? error : typeof record?.message === 'string' ? record.message : `HTTP ${status}`;
  // What the agent typed never travels back in an error text, which ends in logs.
  for (const secret of secrets) if (secret) detail = detail.split(secret).join('[redacted]');
  return new NativeComputerError(apiError('computer_command_failed', `Computer command failed: ${detail}`, { detail }), 502);
}

/**
 * Sends one command to the desktop's computer-use server. `actor` is the
 * daemon's, derived from the authentication, never the caller's.
 */
export async function callNativeComputer(
  command: string,
  args: Record<string, unknown>,
  actor: ComputerActor,
  options: { home?: string; timeoutMs?: number } = {},
): Promise<unknown> {
  const provider = readComputerProvider(options.home);
  if (!provider) throw new NativeComputerError(apiError('computer_unavailable', 'Open Timon desktop on the host machine to use computer control.'), 503);
  const typed = typeof args.text === 'string' ? [args.text] : [];
  let response: Response;
  try {
    response = await fetch(`${provider.origin}/command`, {
      method: 'POST', headers: { authorization: `Bearer ${provider.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ command, args, actor }), signal: AbortSignal.timeout(options.timeoutMs ?? 20_000),
      redirect: 'error',
    });
  } catch {
    throw new NativeComputerError(apiError('computer_unavailable', 'The desktop computer control is unavailable. Reopen Timon on its host machine.'), 503);
  }
  let body: { ok?: unknown; result?: unknown; error?: unknown };
  try { body = await response.json() as typeof body; } catch { body = {}; }
  if (!response.ok || body.ok === false) throw desktopRefusal(body.error, response.status, typed);
  return body.result;
}
