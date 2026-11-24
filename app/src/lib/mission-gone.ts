import { parseApiError } from './api-error';

/** Wait before the one retry of a follow-up refused on a mission that still exists. */
export const SEND_RETRY_DELAY_MS = 1500;

/**
 * Whether a refused follow-up (`/send`) means the conversation is gone, the one
 * case where the chat may start a new mission on its session. Any other refusal,
 * a 404 `mission_not_running` included, comes from a mission that still exists:
 * a new one would run a twin of it on the same session (TIM-0167). Reads a clone,
 * so the caller can still read the body.
 */
export async function missionGone(res: Response): Promise<boolean> {
  if (res.status !== 404) return false;
  const body: unknown = await res.clone().json().catch(() => null);
  return parseApiError(body)?.code === 'mission_not_found';
}
