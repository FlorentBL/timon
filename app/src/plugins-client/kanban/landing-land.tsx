'use client';

/**
 * Landing a job the planner kept on its branch (`POST …/landings/:id/land`):
 * its name, its icon, why it cannot start yet, and the gesture the Jobs
 * widget's row and the job's dialog share. The daemon decides what moves; this
 * side asks first, through the product's confirmation (`confirm.dialog`, which
 * a plugin may repaint), with the number of commits that would land.
 *
 * A project that merges locally merges the branch into its local target; one
 * that lands through pull requests opens the pull request instead, under a
 * title the confirmation shows: the closed pull request's, else one made from
 * the branch. The job's dialog holds the same gesture with the title to edit.
 * A job whose pull request was closed without a merge gets a new one.
 */

import type { ReactElement } from 'react';
import { GitMerge, GitPullRequestArrow, LoaderCircle } from 'lucide-react';
import { toast } from 'sonner';
import { confirmAction } from '@/components/confirm-dialog/confirm-dialog-context';
import { t } from '@/lib/i18n';
import { landJob, landsInPlace, type Landing, type LandOutcome, type LandRequest } from './landing-api';

/** "Merge into main", "Open the PR", or "Open a new PR" after a closed one. */
export function landLabel(landing: Landing): string {
  if (landsInPlace(landing)) return t('landings.land.merge', { target: landing.target });
  return t(landing.state === 'closed' ? 'landings.land.reopenPr' : 'landings.land.openPr');
}

export function LandIcon({ landing, busy = false, className = 'size-3.5' }: {
  landing: Landing;
  busy?: boolean;
  className?: string;
}): ReactElement {
  if (busy) return <LoaderCircle className={`${className} animate-spin`} aria-hidden />;
  const Icon = landsInPlace(landing) ? GitMerge : GitPullRequestArrow;
  return <Icon className={className} aria-hidden />;
}

/**
 * Why the gesture cannot start now, or null: the right is missing (`denied`,
 * from `useAccess('projects:manage')`), or a task of the job still runs (the
 * daemon would refuse it). Shown as the greyed button's tooltip.
 */
export function landBlocked(landing: Landing, denied: string | null): string | null {
  if (denied) return denied;
  const running = landing.under_way ?? 0;
  return running > 0 ? t('landings.land.underWay', { count: running }) : null;
}

/** A first title for the job's pull request, from its branch: `feat/add-x` → "Add x". */
export function titleFromBranch(branch: string): string {
  const slug = branch.slice(branch.indexOf('/') + 1).replace(/[-_]+/g, ' ').trim();
  return slug ? slug.charAt(0).toUpperCase() + slug.slice(1) : branch;
}

/** The title a pull request opens under when nobody wrote one: the closed
 *  pull request's, else one made from the branch. */
export function prTitle(landing: Landing): string {
  return landing.pr_title?.trim() || titleFromBranch(landing.branch);
}

/** What the person reads when the daemon refused: the conflict's files, else its own message. */
export function landRefusal(landing: Landing, out: Extract<LandOutcome, { ok: false }>): string {
  if (out.code === 'landing_conflict' && out.files.length > 0) {
    return t('landings.land.conflict', { target: landing.target, files: out.files.join(', ') });
  }
  return out.message;
}

/**
 * Asks "Merge feat/x into main?" (or "Open the pull request…?", with its
 * title), with the number of commits when it is known, then lands the job.
 * A pull request without a title in `request` takes `prTitle`; `editHint`
 * says where else the title can be written first. Answers the job as the
 * daemon now sees it, or null when the person said no or the daemon refused
 * (a toast says why).
 */
export async function askLand(
  landing: Landing, commits: number | null, request: LandRequest = {}, opts: { editHint?: boolean } = {},
): Promise<Landing | null> {
  const local = landsInPlace(landing);
  const vars = { branch: landing.branch, target: landing.target };
  const sent: LandRequest = local || request.title?.trim() ? request : { ...request, title: prTitle(landing) };
  const lines: string[] = [];
  if (!local && sent.title) lines.push(t('landings.land.prTitle', { title: sent.title }));
  if (commits !== null) lines.push(t('landings.land.commits', { count: commits, target: landing.target }));
  if (!local && opts.editHint) lines.push(t('landings.land.editTitle', { preview: t('landings.preview') }));
  const confirmTitle = local ? 'landings.land.confirmMerge' : landing.state === 'closed' ? 'landings.land.confirmReopen' : 'landings.land.confirmPr';
  const yes = await confirmAction({
    title: t(confirmTitle, vars),
    ...(lines.length > 0 ? { description: lines.join('\n') } : {}),
    confirmLabel: landLabel(landing),
  });
  if (!yes) return null;
  const out = await landJob(landing.id, sent);
  if (!out.ok) {
    toast.error(t(local ? 'landings.land.notMerged' : 'landings.land.notOpened'), { description: landRefusal(landing, out) });
    return null;
  }
  if (out.outcome === 'merged') toast.success(t('landings.land.merged', vars));
  else toast.success(t('landings.land.prOpened'), out.pr_url ? { description: out.pr_url } : undefined);
  return out.landing;
}
