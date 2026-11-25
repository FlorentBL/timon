'use client';

/**
 * What a `forge.conflict.dialog` occupant reads (`conflict-dialog.tsx`): the
 * resolution being prepared and the host's gestures. Internal for now: the
 * slot is declared and the product's dialog is its fallback, but neither the
 * slot nor this hook is part of the plugin contract until API 20 publishes
 * them (`@timon/ui` exports nothing of it yet).
 */

import { createContext, useContext } from 'react';
import type { ConflictView, FileResolution, ResolutionDiff } from './forge-branch-api';

export type ConflictLoad = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ready' };
export type ConflictBusy = { what: 'file' | 'suggest' | 'propose' | 'discard'; path?: string } | null;

export type ConflictDialogValue = {
  project: string;
  pull: { number: number; title: string };
  load: ConflictLoad;
  /** Null until the daemon prepared the merge. */
  conflict: ConflictView | null;
  /** What the commit changes, once the resolution is proposed. */
  diff: ResolutionDiff | null;
  /** The account the project pushes as; null when none is set. */
  account: string | null;
  busy: ConflictBusy;
  /** The last refusal, in the reader's language. */
  error: string | null;
  /** Texts the agent without tools suggested, by path: shown, applied only by `resolve`. */
  suggestions: Readonly<Record<string, string>>;
  /** Each gesture resolves `true` once the daemon took it, `false` on a refusal. */
  resolve: (path: string, resolution: FileResolution) => Promise<boolean>;
  suggest: (path: string) => Promise<boolean>;
  ignoreSuggestion: (path: string) => void;
  /** Commits the resolution and reads its diff (step 3). */
  propose: () => Promise<boolean>;
  /** Drops the resolution, and the dialog closes. */
  discard: () => Promise<boolean>;
  /** Opens "Publish on GitHub" for the proposed resolution; the dialog closes first. */
  publish: () => void;
  close: () => void;
};

export const ConflictDialogContext = createContext<ConflictDialogValue | null>(null);

/** The resolution a `forge.conflict.dialog` occupant paints, and its gestures. */
export function useConflictDialog(): ConflictDialogValue | null {
  return useContext(ConflictDialogContext);
}
