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

/**
 * What the UI proxy may forward to the daemon, by method. Every other command
 * (click, type…) is the agent's and must never be reachable from a browser
 * request: it answers null, and the route refuses with a 404 and forwards nothing.
 */
const UI_ALLOWED: Record<'GET' | 'POST', ReadonlySet<string>> = {
  GET: new Set(['status']),
  POST: new Set(['status', 'stop', 'resume']),
};

export function uiComputerPath(method: 'GET' | 'POST', command: string): string | null {
  return UI_ALLOWED[method].has(command) ? `/api/computer/${command}` : null;
}

/**
 * The upstream call for a UI request. The daemon exposes only
 * `POST /api/computer/:command` (no GET route), so the screen's status poll
 * (GET) is relayed upstream as a POST: relaying it as a GET would 404 and the
 * banner would never appear.
 */
export function uiComputerUpstream(method: 'GET' | 'POST', command: string): { method: 'POST'; path: string } | null {
  const path = uiComputerPath(method, command);
  return path ? { method: 'POST', path } : null;
}
