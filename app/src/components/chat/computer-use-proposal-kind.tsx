'use client';

/**
 * An agent asks to let another agent (or itself) control the computer
 * (`computer_use_propose`). The shared proposal card shows what it changes — the
 * state now and the state after — and the daemon writes the agent's config
 * inside the claim (`applyOnServer`): the browser writes nothing. Only this click
 * widens an agent's access, never the agent.
 */

import { useEffect, useState, type ReactElement } from 'react';
import { t } from '@/lib/i18n';
import {
  appsAfter, COMPUTER_USE_PROPOSAL_KIND, enabledAfter, openAppName, parseComputerUseProposal, type ComputerUseProposal,
} from '@/lib/computer-use-proposals';
import { fetchComputerWindows, type AllowedApp } from '@/lib/computer-use';
import type { ApplyResult, ProposalKindRenderer } from './layout-proposal-kinds';

export { COMPUTER_USE_PROPOSAL_KIND };

const modeLabel = (mode: AllowedApp['mode']): string => t(mode === 'background' ? 'computerProposal.modeBackground' : 'computerProposal.modeForeground');
/** Each application with the mode it is driven in: the mode is what the person is deciding on. */
const withModes = (apps: readonly AllowedApp[]): string => apps.map((entry) => `${entry.app} (${modeLabel(entry.mode)})`).join(', ');
const list = (apps: readonly AllowedApp[]): string => (apps.length ? withModes(apps) : t('computerProposal.noApps'));

/** "Allow <agent> to control <apps> with computer use", in the form that fits what is asked. */
export function computerUseTitle(payload: unknown): string | null {
  const p = parseComputerUseProposal(payload);
  if (!p) return null;
  if (p.addApps.length) return t('computerProposal.titleApps', { target: p.agent, apps: withModes(p.addApps) });
  if (p.enable === true) return t('computerProposal.titleEnable', { target: p.agent });
  return t('computerProposal.titleChange', { target: p.agent });
}

function State({ label, enabled, apps, removed = [] }: { label: string; enabled: boolean; apps: readonly AllowedApp[]; removed?: readonly string[] }): ReactElement {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[11.5px] font-medium text-muted-foreground">{label}</span>
      <span>{enabled ? t('computerProposal.on') : t('computerProposal.off')}</span>
      <span className="text-muted-foreground [overflow-wrap:anywhere]">
        {t('computerProposal.apps', { apps: list(apps) })}
        {removed.length > 0 && ` · ${t('computerProposal.removed', { apps: removed.join(', ') })}`}
      </span>
    </div>
  );
}

function ComputerUsePreview({ payload }: { payload: unknown; titleOf: (id: string) => string }): ReactElement {
  const proposal = parseComputerUseProposal(payload);
  const [windows, setWindows] = useState<{ app: string }[] | null>(null);
  const asks = proposal?.addApps.length ?? 0;
  // Read on the person's side, once: the open windows say how the system names an application.
  useEffect(() => {
    if (!asks) return;
    let live = true;
    void fetchComputerWindows().then((found) => { if (live) setWindows(found); });
    return () => { live = false; };
  }, [asks]);
  if (!proposal) return <p className="text-[12.5px] text-muted-foreground">{t('layoutProposal.unknownKind')}</p>;
  const hints = windows
    ? proposal.addApps.flatMap(({ app: typed }) => { const name = openAppName(typed, windows); return name ? [t('computerProposal.openAs', { typed, name })] : []; })
    : [];
  const expired = proposal.expiresAt > 0 && Date.now() > proposal.expiresAt;
  return (
    <div className="flex flex-col gap-2 text-[13px]">
      <div className="grid gap-3 sm:grid-cols-2">
        <State label={t('computerProposal.now')} enabled={proposal.before.enabled} apps={proposal.before.apps} />
        <State label={t('computerProposal.after')} enabled={enabledAfter(proposal)} apps={appsAfter(proposal)} removed={proposal.removeApps} />
      </div>
      {hints.map((hint) => <p key={hint} className="text-[12px] text-muted-foreground [overflow-wrap:anywhere]">{hint}</p>)}
      <p className="text-[11.5px] text-muted-foreground">{t('computerProposal.reminder')}</p>
      {expired && <p className="text-[11.5px] text-muted-foreground">{t('computerProposal.expired')}</p>}
    </div>
  );
}

/** The daemon wrote the config while claiming the proposal: nothing left to write. */
async function applyComputerUse(): Promise<ApplyResult> {
  return { ok: true, missing: [] };
}

export type { ComputerUseProposal };

export const COMPUTER_USE_PROPOSAL_RENDERER: ProposalKindRenderer = {
  Preview: ComputerUsePreview,
  apply: applyComputerUse,
  applyLabel: 'computerProposal.allow',
  titleOf: computerUseTitle,
  labels: {
    badge: 'computerProposal.badge',
    applied: 'computerProposal.applied',
    stateApplied: 'computerProposal.stateApplied',
    dismiss: 'computerProposal.refuse',
    stale: 'computerProposal.stale',
  },
};
