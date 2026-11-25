'use client';

/**
 * The host of "Resolve the conflict" (`forge.conflict.dialog`) of a
 * contributor's pull request (`docs/FORGE-FLOW-PLAN.md` §3.3, §6): the daemon
 * merges the pull request here without a working tree (`forge-conflicts.ts`)
 * and keeps what conflicts. This component makes every call, prepare,
 * resolve, suggest, propose, discard, and holds what the daemon answered; the
 * occupant reads `useConflictDialog()` and only paints. Nothing is pushed
 * before "Publish on GitHub". The product's dialog is painted directly while
 * only its registered fallback holds the slot.
 */

import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';
import { toast } from 'sonner';
import { SlotSingle, useSlotEntries } from '@/lib/plugin-host/render';
import { CONFLICT_DIALOG_SLOT } from '@/lib/plugin-host/slots';
import { t } from '@/lib/i18n';
import {
  discardConflict, getConflict, prepareConflict, proposeResolution, resolveFile, suggestResolution,
  type ConflictView, type FileResolution, type ResolutionDiff,
} from './forge-branch-api';
import { projectAccount } from './forge-proposals-api';
import { ConflictDialogContext, type ConflictBusy, type ConflictDialogValue, type ConflictLoad } from './conflict-dialog-context';
import { ProductConflictDialog } from './product-conflict-dialog';

export type ConflictDialogProps = {
  project: string;
  pull: { number: number; title: string };
  onClose: () => void;
  /** The resolution is proposed: open its publication (the dialog closes first). */
  onPublish: (proposalId: string) => void;
};

type Answer<T> = { ok: true; value: T } | { ok: false; message: string };

function without(map: Readonly<Record<string, string>>, path: string): Record<string, string> {
  const next = { ...map };
  delete next[path];
  return next;
}

export function ConflictDialog({ project, pull, onClose, onPublish }: ConflictDialogProps): ReactElement {
  const [load, setLoad] = useState<ConflictLoad>({ kind: 'loading' });
  const [conflict, setConflict] = useState<ConflictView | null>(null);
  const [diff, setDiff] = useState<ResolutionDiff | null>(null);
  const [account, setAccount] = useState<string | null>(null);
  const [busy, setBusy] = useState<ConflictBusy>(null);
  const [error, setError] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<Record<string, string>>({});

  useEffect(() => {
    let alive = true;
    void (async () => {
      const [prepared, acc] = await Promise.all([prepareConflict(project, pull.number), projectAccount(project)]);
      if (!alive) return;
      setAccount(acc);
      if (!prepared.ok) { setLoad({ kind: 'error', message: prepared.message }); return; }
      setConflict(prepared.value);
      if (prepared.value.state === 'proposed') {
        const read = await getConflict(project, prepared.value.id);
        if (!alive) return;
        if (read.ok) { setConflict(read.value.conflict); setDiff(read.value.diff); }
      }
      setLoad({ kind: 'ready' });
    })();
    return () => { alive = false; };
  }, [project, pull.number]);

  const run = useCallback(async <T,>(what: ConflictBusy, step: () => Promise<Answer<T>>): Promise<T | null> => {
    setBusy(what);
    setError(null);
    const out = await step();
    setBusy(null);
    if (!out.ok) { setError(out.message); return null; }
    return out.value;
  }, []);

  const value = useMemo<ConflictDialogValue>(() => ({
    project,
    pull,
    load,
    conflict,
    diff,
    account,
    busy,
    error,
    suggestions,
    resolve: async (path: string, resolution: FileResolution) => {
      if (!conflict) return false;
      const view = await run({ what: 'file', path }, () => resolveFile(project, conflict.id, path, resolution));
      if (!view) return false;
      setConflict(view);
      setSuggestions((m) => without(m, path));
      return true;
    },
    suggest: async (path: string) => {
      if (!conflict) return false;
      const text = await run({ what: 'suggest', path }, () => suggestResolution(project, conflict.id, path));
      if (text === null) return false;
      setSuggestions((m) => ({ ...m, [path]: text }));
      return true;
    },
    ignoreSuggestion: (path: string) => setSuggestions((m) => without(m, path)),
    propose: async () => {
      if (!conflict) return false;
      const out = await run({ what: 'propose' }, () => proposeResolution(project, conflict.id));
      if (!out) return false;
      setConflict(out.conflict);
      setDiff(out.diff);
      return true;
    },
    discard: async () => {
      if (!conflict) { onClose(); return true; }
      const state = await run({ what: 'discard' }, () => discardConflict(project, conflict.id));
      if (state === null) return false;
      toast.success(t('forgeConflict.discarded'));
      onClose();
      return true;
    },
    publish: () => { if (conflict?.proposal_id) onPublish(conflict.proposal_id); },
    close: onClose,
  }), [project, pull, load, conflict, diff, account, busy, error, suggestions, run, onClose, onPublish]);

  const occupant = useSlotEntries(CONFLICT_DIALOG_SLOT)[0];
  return (
    <ConflictDialogContext.Provider value={value}>
      {occupant && !occupant.fallback ? <SlotSingle name={CONFLICT_DIALOG_SLOT} /> : <ProductConflictDialog />}
    </ConflictDialogContext.Provider>
  );
}
