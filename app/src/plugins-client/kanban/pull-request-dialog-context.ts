'use client';

/**
 * What a `kanban.pull.dialog` occupant reads: the pull request, its page and
 * its gestures (`pull-request-dialog.tsx`). Not exported to third-party
 * plugins yet (`slots.ts`): the plugin contract would need a new wave.
 */

import { createContext, useContext } from 'react';
import type { CheckLog, PullRequestPage, Read } from './pull-request-page-api';
import type { PullActionId, PullActions, PullRequestItem } from './pull-requests-model';

/** GitHub's page of the pull request: being read, refused (`message` in the reader's language), or read. */
export type PullRequestPageLoad =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; page: PullRequestPage };

export type PullRequestDialogValue = {
  project: string;
  /** `owner/name` of the project's repository, when known. */
  repo: string | null;
  /** The row the window was opened from: its title shows before the page is read, and its links and review come from the list. */
  pull: PullRequestItem;
  load: PullRequestPageLoad;
  /** A fresh read asked by `refresh` is under way; `load` keeps the last page meanwhile. */
  refreshing: boolean;
  /** Reads the page again from GitHub, past the host's short cache. */
  refresh: () => Promise<void>;
  /** Its gestures, placed as the row's menu places them: the filled one, those beside it, the rest in "…". */
  actions: PullActions;
  /** Runs a gesture, a person's click only: Timon opens what it needs (a brief, the publish window, a conflict). */
  run: (id: PullActionId) => void;
  /** The end of a failed check's log, for a job of the repository's own CI. */
  readCheckLog: (checkUrl: string) => Promise<Read<CheckLog>>;
  /** The pull request's whole diff, as text, cut past the daemon's bound. */
  readDiff: () => Promise<Read<{ diff: string; truncated: boolean }>>;
  close: () => void;
  /** Close the window, then open the job behind the pull request / one of the ideas it carries. */
  openJob: (id: string) => void;
  openTodo: (id: number) => void;
};

export const PullRequestDialogContext = createContext<PullRequestDialogValue | null>(null);

/** The pull request a `kanban.pull.dialog` occupant paints, and its gestures; `null` outside the slot. */
export function usePullRequestDialog(): PullRequestDialogValue | null {
  return useContext(PullRequestDialogContext);
}
