'use client';

import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';
import { currentAccount, onAccountChange } from '@/lib/account-change';
import { sseOn } from '@/lib/sse-stream';
import { isPending, listProposals, type ForgeProposal } from './forge-proposals-api';

/**
 * The proposals waiting for a person, per project, read once for the whole
 * page: the Jobs and PR widgets, their tabs and every TO DO row linked to an
 * issue ask for the same list, and a row each would ask the daemon as many
 * times. The daemon announces every change of a proposal with its project
 * (`forge_proposals_changed`), so only that project is read again. A project
 * the reader may not manage answers a refusal: it simply has none here.
 *
 * A project nobody on the page asks for any more is forgotten, so the next
 * one to ask reads it fresh.
 */
type Entry = { pending: ForgeProposal[]; readers: number; ask: number };

const entries = new Map<string, Entry>();
const listeners = new Set<() => void>();
let version = 0;
let stopSignal: (() => void) | null = null;

function changed(): void {
  version += 1;
  for (const listener of listeners) listener();
}

function read(slug: string): void {
  const entry = entries.get(slug);
  if (!entry) return;
  const ask = ++entry.ask;
  void listProposals(slug).then((out) => {
    const current = entries.get(slug);
    // A later read, or a project forgotten meanwhile, wins over this answer.
    if (current !== entry || ask !== entry.ask) return;
    entry.pending = out.ok ? out.value.filter(isPending) : [];
    changed();
  });
}

/** The project a `forge_proposals_changed` frame names, or null. */
export function changedProject(event: MessageEvent): string | null {
  const data: unknown = event.data;
  if (typeof data !== 'string') return null;
  try {
    const parsed: unknown = JSON.parse(data);
    const project = parsed && typeof parsed === 'object' ? (parsed as { project?: unknown }).project : null;
    return typeof project === 'string' && project.length > 0 ? project : null;
  } catch {
    return null;
  }
}

function hold(slugs: readonly string[]): () => void {
  for (const slug of slugs) {
    const entry = entries.get(slug);
    if (entry) { entry.readers += 1; continue; }
    entries.set(slug, { pending: [], readers: 1, ask: 0 });
    read(slug);
  }
  stopSignal ??= sseOn('forge_proposals_changed', (event) => {
    const project = changedProject(event);
    // A frame without a project (an older daemon) reads every held project.
    if (project === null) { for (const slug of entries.keys()) read(slug); } else read(project);
  });
  return () => {
    for (const slug of slugs) {
      const entry = entries.get(slug);
      if (entry && --entry.readers <= 0) entries.delete(slug);
    }
    if (entries.size === 0 && stopSignal) { stopSignal(); stopSignal = null; }
  };
}

// Another account's proposals are not this one's: what is held is emptied and
// read again under the new account, and an answer still on its way for the
// previous one lands nowhere (`read` moves `ask`). Naming the account for the
// first time is no change.
let followedAccount: string | null = currentAccount();
onAccountChange((owner) => {
  const switched = followedAccount !== null && owner !== followedAccount;
  followedAccount = owner;
  if (!switched || entries.size === 0) return;
  for (const [slug, entry] of entries) {
    entry.pending = [];
    // Signed out, there is nothing to read: only the answer in flight is dropped.
    if (owner === null) entry.ask += 1;
    else read(slug);
  }
  changed();
});

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};
const snapshot = () => version;

export function useForgeProposals(projects: readonly string[]): { pending: ForgeProposal[]; reload: () => void } {
  const key = [...new Set(projects.filter(Boolean))].sort().join('\n');
  const at = useSyncExternalStore(subscribe, snapshot, snapshot);
  useEffect(() => (key ? hold(key.split('\n')) : undefined), [key]);
  const pending = useMemo(
    () => (key ? key.split('\n').flatMap((slug) => entries.get(slug)?.pending ?? []) : []),
    // `at` moves with every answer the store keeps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key, at],
  );
  const reload = useCallback(() => { if (key) for (const slug of key.split('\n')) read(slug); }, [key]);
  return { pending, reload };
}
