'use client';

/**
 * The host of a pull request's detail window (`kanban.pull.dialog`), opened by
 * a click on its row in the Pull requests widget. It reads GitHub's page
 * through the daemon, keeps it fresh on demand, and hands the occupant the
 * page, the row and its gestures through `usePullRequestDialog()`; the
 * occupant draws the window, so a plugin that takes the slot repaints it.
 *
 * The reads and the gestures stay the host's: the occupant holds no access to
 * GitHub or to the daemon, and every gesture goes through the widget that
 * opened the window, as from the row's menu.
 *
 * The product's window is painted directly while only its registered fallback
 * holds the slot: the fallback is a chunk loaded on demand, and the window
 * must not wait for it.
 */

import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';
import { SlotSingle, useSlotEntries } from '@/lib/plugin-host/render';
import { PULL_REQUEST_DIALOG_SLOT } from '@/lib/plugin-host/slots';
import { ProductPullRequestDialog } from './product-pull-request-dialog';
import { PullRequestDialogContext, type PullRequestDialogValue, type PullRequestPageLoad } from './pull-request-dialog-context';
import { getCheckLog, getPullRequestDiff, getPullRequestPage } from './pull-request-page-api';
import type { PullActionId, PullActions, PullRequestItem } from './pull-requests-model';

export function PullRequestDialog({ project, repo, pull, actions, onAction, onOpenJob, onOpenTodo, onClose }: {
  project: string;
  repo: string | null;
  /** The row the window was opened from: its title shows at once, its chips and links come from the list. */
  pull: PullRequestItem;
  /** Its gestures, as `pullRequestActions` places them; the row's menu lists the same. */
  actions: PullActions;
  onAction: (id: PullActionId) => void;
  /** Timon's links (job, ideas): the screen closes the window before the one they open. */
  onOpenJob: (id: string) => void;
  onOpenTodo: (id: number) => void;
  onClose: () => void;
}): ReactElement {
  const [load, setLoad] = useState<PullRequestPageLoad>({ kind: 'loading' });
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    let alive = true;
    setLoad({ kind: 'loading' });
    void getPullRequestPage(project, pull.number, pull.updatedAt ? { updated: pull.updatedAt } : {}).then((out) => {
      if (!alive) return;
      setLoad(out.ok ? { kind: 'ready', page: out.value } : { kind: 'error', message: out.message });
    });
    return () => { alive = false; };
  }, [project, pull.number, pull.updatedAt]);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    const out = await getPullRequestPage(project, pull.number, { fresh: true });
    setRefreshing(false);
    setLoad(out.ok ? { kind: 'ready', page: out.value } : { kind: 'error', message: out.message });
  }, [project, pull.number]);

  const value = useMemo<PullRequestDialogValue>(() => ({
    project,
    repo,
    pull,
    load,
    refreshing,
    refresh,
    actions,
    run: onAction,
    readCheckLog: (checkUrl) => getCheckLog(project, pull.number, checkUrl),
    readDiff: () => getPullRequestDiff(project, pull.number),
    close: onClose,
    openJob: onOpenJob,
    openTodo: onOpenTodo,
  }), [project, repo, pull, load, refreshing, refresh, actions, onAction, onClose, onOpenJob, onOpenTodo]);

  const occupant = useSlotEntries(PULL_REQUEST_DIALOG_SLOT)[0];
  return (
    <PullRequestDialogContext.Provider value={value}>
      {occupant && !occupant.fallback ? <SlotSingle name={PULL_REQUEST_DIALOG_SLOT} /> : <ProductPullRequestDialog />}
    </PullRequestDialogContext.Provider>
  );
}
