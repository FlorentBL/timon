/**
 * Computer use, screen side: what the daemon answers on `status`, and the
 * three calls a person may make (status, stop, resume).
 */

export interface ComputerStatus {
  /** An agent is controlling the mouse and keyboard right now. */
  active: boolean;
  /** The human stop is in force: agent commands are refused until a resume. */
  stopped: boolean;
}

const IDLE: ComputerStatus = { active: false, stopped: false };

/** Reads a `status` answer defensively: anything unexpected is "idle". */
export function parseComputerStatus(raw: unknown): ComputerStatus {
  if (!raw || typeof raw !== 'object') return IDLE;
  const body = raw as Record<string, unknown>;
  // The daemon may wrap the desktop's answer in `result`.
  const inner = body.result && typeof body.result === 'object' ? (body.result as Record<string, unknown>) : body;
  return { active: inner.active === true, stopped: inner.stopped === true };
}

/** One status poll. Desktop absent, feature off, signed out: idle, never an error. */
export async function fetchComputerStatus(): Promise<ComputerStatus> {
  try {
    const r = await fetch('/api/ui/computer/status', { cache: 'no-store' });
    if (!r.ok) return IDLE;
    return parseComputerStatus(await r.json());
  } catch {
    return IDLE;
  }
}

/** The human stop / resume. Resolves true when the daemon accepted it. */
export async function sendComputerControl(command: 'stop' | 'resume'): Promise<boolean> {
  try {
    const r = await fetch(`/api/ui/computer/${command}`, { method: 'POST' });
    return r.ok;
  } catch {
    return false;
  }
}
