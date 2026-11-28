/**
 * What an agent asks for with `computer_use_propose`, read and worked out the
 * way the daemon does when the person allows it
 * (orchestrator/src/plugins-bundled/computer-use/proposals.ts): the app and the
 * daemon are separate packages, no import possible.
 */

import { normalizeAllowedApps, type AllowedApp } from './computer-use';

export const COMPUTER_USE_PROPOSAL_KIND = 'computer-use';

export type ComputerUseProposal = {
  agent: string;
  /** Each with the mode it will get (a card drawn before the modes existed holds bare names: the foreground). */
  addApps: AllowedApp[];
  removeApps: string[];
  enable?: boolean;
  before: { enabled: boolean; apps: AllowedApp[]; defaultMode: AllowedApp['mode'] };
  expiresAt: number;
};

const strings = (value: unknown): string[] | null => (
  Array.isArray(value) && value.every((v) => typeof v === 'string') ? value as string[] : null
);

export function parseComputerUseProposal(payload: unknown): ComputerUseProposal | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const p = payload as Record<string, unknown>;
  const before = p.before as Record<string, unknown> | undefined;
  const removeApps = strings(p.removeApps);
  const entries = (value: unknown): boolean => Array.isArray(value) && value.every((v) => typeof v === 'string' || (typeof v === 'object' && v !== null && typeof (v as { app?: unknown }).app === 'string'));
  if (typeof p.agent !== 'string' || !entries(p.addApps) || !removeApps || !before || typeof before.enabled !== 'boolean' || !entries(before.apps)) return null;
  const defaultMode = before.defaultMode === 'background' ? 'background' : 'foreground';
  return {
    agent: p.agent, addApps: normalizeAllowedApps(p.addApps, defaultMode), removeApps,
    before: { enabled: before.enabled, apps: normalizeAllowedApps(before.apps, defaultMode), defaultMode },
    ...(typeof p.enable === 'boolean' ? { enable: p.enable } : {}),
    expiresAt: typeof p.expiresAt === 'number' ? p.expiresAt : 0,
  };
}

const same = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * The allowed applications once the proposal is applied: additions last, no duplicate, removals by name;
 * adding one already listed sets its mode (the first spelling stays).
 */
export function appsAfter(proposal: ComputerUseProposal): AllowedApp[] {
  const kept = proposal.before.apps.filter((entry) => !proposal.removeApps.some((gone) => same(gone, entry.app)));
  for (const wanted of proposal.addApps) {
    const at = kept.findIndex((have) => same(have.app, wanted.app));
    if (at >= 0) kept[at] = { app: kept[at]!.app, mode: wanted.mode };
    else kept.push({ app: wanted.app.trim(), mode: wanted.mode });
  }
  return kept;
}

export function enabledAfter(proposal: ComputerUseProposal): boolean {
  return proposal.enable ?? proposal.before.enabled;
}

/**
 * How an open window names an application the agent called loosely ("discord"
 * for "Discord"): the window's own name, when exactly one application matches
 * and it is not spelled the way the agent wrote it. Null otherwise — the name
 * is then kept as written, which the desktop compares without regard to case.
 */
export function openAppName(typed: string, windows: readonly { app: string }[]): string | null {
  const wanted = typed.trim().toLowerCase().replace(/\.exe$/, '');
  if (!wanted) return null;
  const names = [...new Set(windows.map((w) => w.app.trim()).filter(Boolean))];
  const exact = names.filter((n) => n.toLowerCase().replace(/\.exe$/, '') === wanted);
  const found = exact.length ? exact : names.filter((n) => n.toLowerCase().includes(wanted));
  return found.length === 1 && found[0] !== typed.trim() ? found[0]! : null;
}
