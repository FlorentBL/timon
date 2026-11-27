/**
 * Computer use, screen side: what the daemon answers on `status`, and the
 * calls a person may make (status, stop, resume, setup).
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

export type ComputerCheck = 'ok' | 'missing' | 'unsupported';
export const COMPUTER_CHECK_KEYS = ['desktop', 'accessibility', 'screen', 'inputTool', 'session'] as const;
export type ComputerCheckKey = (typeof COMPUTER_CHECK_KEYS)[number];

/** What the setup card shows: one entry per prerequisite the desktop reported. */
export interface ComputerSetup {
  /** The desktop app answered. False in a browser, or when the app is closed. */
  reachable: boolean;
  platform: string;
  available: boolean;
  checks: Partial<Record<ComputerCheckKey, ComputerCheck>>;
  /** macOS: Screen Recording was just granted and only a restart makes it work. */
  needsRestart: boolean;
}

export const COMPUTER_UNREACHABLE: ComputerSetup = { reachable: false, platform: '', available: false, checks: { desktop: 'missing' }, needsRestart: false };

/** Reads a `status` answer for the setup card; anything unexpected reads as "desktop not reachable". */
export function parseComputerSetup(raw: unknown): ComputerSetup {
  if (!raw || typeof raw !== 'object') return COMPUTER_UNREACHABLE;
  const body = raw as Record<string, unknown>;
  const inner = body.result && typeof body.result === 'object' ? (body.result as Record<string, unknown>) : body;
  const rawChecks = inner.checks && typeof inner.checks === 'object' ? (inner.checks as Record<string, unknown>) : null;
  if (!rawChecks) return COMPUTER_UNREACHABLE;
  const checks: ComputerSetup['checks'] = {};
  for (const key of COMPUTER_CHECK_KEYS) {
    const value = rawChecks[key];
    if (value === 'ok' || value === 'missing' || value === 'unsupported') checks[key] = value;
  }
  return {
    reachable: true,
    platform: typeof inner.platform === 'string' ? inner.platform : '',
    available: inner.available === true,
    checks,
    needsRestart: inner.needsRestart === true,
  };
}

export async function fetchComputerSetup(): Promise<ComputerSetup> {
  try {
    const r = await fetch('/api/ui/computer/status', { cache: 'no-store' });
    return r.ok ? parseComputerSetup(await r.json()) : COMPUTER_UNREACHABLE;
  } catch {
    return COMPUTER_UNREACHABLE;
  }
}

/** "Allow": the desktop shows the system prompts, or opens the Settings pane. */
export async function requestComputerPermissions(): Promise<boolean> {
  try {
    return (await fetch('/api/ui/computer/request_permissions', { method: 'POST' })).ok;
  } catch {
    return false;
  }
}

/** "Restart Timon", after Screen Recording was granted. */
export async function restartComputerApp(): Promise<boolean> {
  try {
    return (await fetch('/api/ui/computer/restart_app', { method: 'POST' })).ok;
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
  // The person's setup of the machine: system prompts and the restart they may need.
  POST: new Set(['status', 'stop', 'resume', 'request_permissions', 'restart_app']),
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
