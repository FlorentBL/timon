/**
 * What a concluded job leaves behind (`docs/KANBAN-PR-PIPELINE.md` §2.7).
 *
 * Once a job's integration branch landed (its `integrations` row 'merged',
 * its landing replayed), nothing it was built with serves any more: the
 * worktrees of its tasks, the worktree its pilot coded in
 * (`series-worktrees/<series>`, which the worktree GC never lists), the
 * branch itself, and its copy on the remote. Each one is removed here, once,
 * behind the same guards as the worktree GC:
 *
 * - **Nothing a task still holds.** While any task of the job is not DONE
 *   (a doc task created at the landing, a repair), the row waits; so does it
 *   while the pilot's mission runs. A fresh branch has no commit of its own
 *   and git calls it merged: that is how a live task lost its worktree on
 *   2026-09-20.
 * - **Nothing that did not land.** The branch, and its remote copy, go only
 *   when git finds their tip in the target (`<remote>/<target>`, or the local
 *   target of a job that merges locally). A pull request merged by squash
 *   leaves the branch in place: deleted work does not come back, a leftover
 *   branch costs nothing. A worktree goes only when its commits are in the
 *   branch or the target and git agrees to remove it (no `--force`: changes
 *   never committed are kept).
 * - **The remote copy only when asked** (`delete_remote_branch`), through the
 *   same checks as the push of the pull request (the account `gh` signs in
 *   as, the push URL), and leased on the commit that landed: a branch someone
 *   pushed to since is refused, never deleted.
 *
 * A pull request closed without a merge only gives back its pilot's
 * worktree, once its commits are in the branch: the branch stays, the work
 * did not land.
 *
 * Each row is dealt with once (`cleaned_at`). A row waits, and is tried again
 * on the next pass, while something may still change (a task open, a pilot
 * running, the network); what a guard keeps for good is logged once and left.
 */
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { dbApi, type IntegrationRow, type TaskRow } from './db.js';
import { integrationOfTask } from './chain-landing.js';
import {
  deleteRemoteBranch, githubForge, gitTransport,
  type Forge, type ForgeRunners, type GitNetworkOutcome, type GitTransport,
} from './host/forge.js';
import { getHost } from './host/index.js';
import type { ExecResult } from './host/types.js';
import { checkAccount, checkRemoteUrl, pullRequestSetting } from './pr-open.js';
import { readProjectIntegration } from './project-integration.js';
import { SERIES_WORKTREES_ROOT } from './series-integration.js';
import { settingBool, settingInt } from './settings.js';
import { disposeWorktree, prepareWorktreeDependencies, releaseWorktreeFolder } from './worktree.js';

export type CleanupDeps = {
  /** Stand-ins for gh and git's network side: tests never reach a forge. */
  forge?: (configDir: string | null) => Pick<Forge, 'login'>;
  transport?: (repo: string) => GitTransport;
  deleteRemote?: (repo: string, url: string, branch: string, sha: string) => Promise<GitNetworkOutcome>;
  runners?: ForgeRunners;
  /** Where the pilots' worktrees live (tests). */
  seriesWorktreesRoot?: string;
  /** Overrides the worktree GC's grace (tests). */
  graceMs?: number;
  now?: number;
};

/**
 * - `cleaned`: everything this row left was removed, or kept for good by a
 *   guard; the row is not looked at again.
 * - `waiting`: something may still change; the next pass tries again.
 */
export type CleanupResult = 'cleaned' | 'waiting';

type Step = 'done' | 'kept' | 'waiting';

// ─── Local git reads ────────────────────────────────────────────────────────

async function gitRun(repo: string, args: string[]): Promise<ExecResult> {
  try {
    return await getHost().execAsync('git', ['-C', repo, ...args], { timeout: 30_000, windowsHide: true });
  } catch (err) {
    return { code: 1, stdout: '', stderr: (err as Error).message };
  }
}

const SHA = /^[0-9a-f]{40,64}$/;

async function refSha(repo: string, ref: string): Promise<string | null> {
  const r = await gitRun(repo, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  const sha = r.stdout.trim();
  return r.code === 0 && SHA.test(sha) ? sha : null;
}

async function ancestry(repo: string, ancestor: string, descendant: string): Promise<'yes' | 'no' | 'unknown'> {
  const r = await gitRun(repo, ['merge-base', '--is-ancestor', ancestor, descendant]);
  return r.code === 0 ? 'yes' : r.code === 1 ? 'no' : 'unknown';
}

async function commonDir(path: string): Promise<string | null> {
  const r = await gitRun(path, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  const dir = r.stdout.trim();
  return r.code === 0 && dir ? resolve(dir) : null;
}

/** The ref the landed work is in: the remote's target, or the local one. */
function landedRef(row: IntegrationRow): string {
  return row.remote ? `refs/remotes/${row.remote}/${row.target}` : `refs/heads/${row.target}`;
}

/** Is `branch` checked out in a working directory of `repo` (the user's own included)? */
async function checkedOut(repo: string, branch: string): Promise<boolean | null> {
  const r = await gitRun(repo, ['worktree', 'list', '--porcelain']);
  if (r.code !== 0) return null;
  return r.stdout.split('\n').some((line) => line.trim() === `branch refs/heads/${branch}`);
}

// ─── The job's tasks ────────────────────────────────────────────────────────

/** Every task that names the job's branch as its base, in its project. */
function tasksOnBranch(row: IntegrationRow): TaskRow[] {
  return dbApi.listTasksByBaseBranch(row.branch)
    .filter((t) => !row.project || !t.project || t.project === row.project);
}

/**
 * The worktrees of the job's tasks. The worktree GC would dispose of them
 * too, but only once its grace passed and while the branch still exists to
 * prove a task's work is in it: they go before the branch does.
 */
async function disposeTaskWorktrees(row: IntegrationRow, tasks: TaskRow[]): Promise<Step> {
  let step: Step = 'done';
  const seen = new Set<string>();
  for (const task of tasks) {
    if (integrationOfTask(task)?.id !== row.id) continue;
    if (!task.worktree_path || !task.branch_name) continue;
    if (seen.has(task.worktree_path)) {
      dbApi.clearTaskWorktree(task.id);
      continue;
    }
    seen.add(task.worktree_path);
    const integrated = task.merged_commit_sha
      ? true
      : !(await refSha(row.repo, `refs/heads/${task.branch_name}`))
        || (await ancestry(row.repo, `refs/heads/${task.branch_name}`, `refs/heads/${row.branch}`)) === 'yes';
    if (!integrated) {
      console.log(`[integration-cleanup] ${task.branch_name} kept: its commits are not in ${row.branch}`);
      step = 'kept';
      continue;
    }
    try {
      await disposeWorktree({
        taskId: task.id, path: task.worktree_path, branch: task.branch_name,
        base: row.branch, sourceRepo: row.repo,
      }, true);
      dbApi.clearTaskWorktree(task.id);
    } catch (err) {
      console.warn(`[integration-cleanup] worktree of task ${task.id.slice(0, 8)} not removed: ${(err as Error).message}`);
      return 'waiting';
    }
  }
  return step;
}

// ─── The pilot's worktree ───────────────────────────────────────────────────

function pilotRunning(seriesId: string): boolean {
  const missions = new Set([seriesId, dbApi.seriesPilotMission(seriesId)].filter((m): m is string => !!m));
  return [...missions].some((id) => dbApi.getMission(id)?.status === 'running');
}

/**
 * The worktree `timon pr branch` gave the pilot of a sequential job. Removed
 * when its commits are in the branch or the target, and git agrees (nothing
 * left uncommitted). One folder per series: only this repository's.
 */
async function releasePilotWorktree(row: IntegrationRow, root: string): Promise<Step> {
  if (!row.series_id) return 'done';
  const path = join(root, row.series_id);
  if (!existsSync(path)) return 'done';
  const [own, repo] = await Promise.all([commonDir(path), commonDir(row.repo)]);
  if (!own) {
    // A folder git no longer knows: not a worktree any more, nothing to prove.
    console.log(`[integration-cleanup] pilot folder of series ${row.series_id.slice(0, 8)} kept: git does not know it`);
    return 'kept';
  }
  if (own !== repo) return 'done';
  const head = await refSha(path, 'HEAD');
  if (!head) return 'waiting';
  const holders = [`refs/heads/${row.branch}`, landedRef(row)];
  let contained = false;
  for (const ref of holders) {
    if (!(await refSha(row.repo, ref))) continue;
    if ((await ancestry(row.repo, head, ref)) === 'yes') { contained = true; break; }
  }
  if (!contained) {
    console.log(`[integration-cleanup] pilot worktree of series ${row.series_id.slice(0, 8)} kept: it holds commits ${row.branch} does not`);
    return 'kept';
  }
  try {
    await releaseWorktreeFolder(path, root);
  } catch (err) {
    // Uncommitted changes: git refuses, and the folder gets its links back.
    await prepareWorktreeDependencies(row.repo, path).catch(() => undefined);
    console.log(`[integration-cleanup] pilot worktree of series ${row.series_id.slice(0, 8)} kept: ${(err as Error).message.split('\n')[0]}`);
    return 'kept';
  }
  console.log(`[integration-cleanup] pilot worktree of series ${row.series_id.slice(0, 8)} removed`);
  return 'done';
}

// ─── The branch ─────────────────────────────────────────────────────────────

async function deleteLocalBranch(row: IntegrationRow): Promise<Step> {
  const tip = await refSha(row.repo, `refs/heads/${row.branch}`);
  if (!tip) return 'done';
  const where = await checkedOut(row.repo, row.branch);
  // Someone works on it (the user's own checkout): it waits for them to leave.
  if (where !== false) return 'waiting';
  const landed = await ancestry(row.repo, tip, landedRef(row));
  if (landed === 'unknown') return 'waiting';
  if (landed === 'no') {
    console.log(`[integration-cleanup] ${row.branch} kept: its tip is not in ${row.remote ? `${row.remote}/` : ''}${row.target}`);
    return 'kept';
  }
  // Leased on the tip just read: a commit made since keeps the branch.
  const r = await gitRun(row.repo, ['update-ref', '-d', `refs/heads/${row.branch}`, tip]);
  if (r.code !== 0) return 'waiting';
  console.log(`[integration-cleanup] ${row.branch} deleted: landed in ${row.remote ? `${row.remote}/` : ''}${row.target}`);
  return 'done';
}

async function deleteRemoteCopy(row: IntegrationRow, deps: CleanupDeps): Promise<Step> {
  if (!row.remote || row.mode !== 'pr' || !row.head_sha || !row.project) return 'done';
  let read;
  try { read = readProjectIntegration(row.project); } catch { return 'done'; }
  if (read.invalid || !read.integration.delete_remote_branch) return 'done';
  const resolved = pullRequestSetting(row, row.project);
  if ('refusal' in resolved) {
    console.log(`[integration-cleanup] remote ${row.branch} kept: ${resolved.refusal}`);
    return 'kept';
  }
  // The pushed head must be in the target: what the pull request carried landed.
  if ((await ancestry(row.repo, row.head_sha, landedRef(row))) !== 'yes') {
    console.log(`[integration-cleanup] remote ${row.branch} kept: its head is not in ${row.remote}/${row.target}`);
    return 'kept';
  }
  const forge = (deps.forge ?? ((dir) => githubForge(dir, deps.runners)))(resolved.setting.gh_config_dir);
  const account = await checkAccount(forge, resolved.account);
  if (!account.ok) {
    console.warn(`[integration-cleanup] remote ${row.branch} not deleted yet: ${account.detail}`);
    return 'waiting';
  }
  const url = await checkRemoteUrl(row.repo, row.remote, resolved.remoteUrl);
  if (!url.ok) {
    console.log(`[integration-cleanup] remote ${row.branch} kept: ${url.detail}`);
    return 'kept';
  }
  const transport = (deps.transport ?? ((repo) => gitTransport(repo, deps.runners)))(row.repo);
  const there = await transport.remoteBranchSha(resolved.remoteUrl, row.branch);
  if (!there.ok) {
    console.warn(`[integration-cleanup] remote ${row.branch} not deleted yet: ${there.reason}`);
    return 'waiting';
  }
  // The forge deleted it already (its own setting), or someone pushed since.
  if (there.sha === null) return 'done';
  if (there.sha !== row.head_sha) {
    console.log(`[integration-cleanup] remote ${row.branch} kept: it moved since its pull request was merged`);
    return 'kept';
  }
  const deleted = await (deps.deleteRemote ?? ((repo, u, b, s) => deleteRemoteBranch(repo, u, b, s, deps.runners)))(
    row.repo, resolved.remoteUrl, row.branch, row.head_sha,
  );
  if (deleted.ok) {
    console.log(`[integration-cleanup] remote ${row.branch} deleted`);
    return 'done';
  }
  if (deleted.code === 'rejected') {
    console.log(`[integration-cleanup] remote ${row.branch} kept: ${deleted.reason}`);
    return 'kept';
  }
  console.warn(`[integration-cleanup] remote ${row.branch} not deleted yet: ${deleted.reason}`);
  return 'waiting';
}

// ─── One row, one pass ──────────────────────────────────────────────────────

/** Removes what the concluded integration `row` left behind. */
export async function cleanIntegration(row: IntegrationRow, deps: CleanupDeps = {}): Promise<CleanupResult> {
  if (row.state !== 'merged' && row.state !== 'closed') return 'waiting';
  if (row.state === 'merged' && row.landed_at === null) return 'waiting';
  if (!existsSync(row.repo)) return 'waiting';
  const tasks = tasksOnBranch(row);
  if (tasks.some((t) => t.status !== 'DONE')) return 'waiting';
  if (row.series_id && pilotRunning(row.series_id)) return 'waiting';

  const steps: Step[] = [];
  if (row.state === 'merged') steps.push(await disposeTaskWorktrees(row, tasks));
  steps.push(await releasePilotWorktree(row, deps.seriesWorktreesRoot ?? SERIES_WORKTREES_ROOT));
  if (row.state === 'merged') {
    // The worktrees first: a task's work is proven in the branch, not after it.
    if (!steps.includes('waiting')) steps.push(await deleteLocalBranch(row));
    steps.push(await deleteRemoteCopy(row, deps));
  }
  if (steps.includes('waiting')) return 'waiting';
  dbApi.markIntegrationCleaned(row.id);
  return 'cleaned';
}

/**
 * One pass over the concluded integrations not cleaned yet. Off with the
 * worktree GC (`TIMON_WORKTREE_GC_ENABLED`), and after the same grace: a job
 * that just landed is left to its last gestures.
 */
export async function cleanConcludedIntegrations(deps: CleanupDeps = {}): Promise<Map<string, CleanupResult>> {
  const results = new Map<string, CleanupResult>();
  if (!settingBool('TIMON_WORKTREE_GC_ENABLED')) return results;
  const graceMs = deps.graceMs ?? Math.max(0, settingInt('TIMON_WORKTREE_GC_GRACE_MIN')) * 60_000;
  const now = deps.now ?? Date.now();
  for (const row of dbApi.listIntegrationsToClean()) {
    const since = row.state === 'merged' ? (row.landed_at ?? row.updated_at) : row.updated_at;
    if (now - since < graceMs) {
      results.set(row.id, 'waiting');
      continue;
    }
    try {
      results.set(row.id, await cleanIntegration(row, deps));
    } catch (err) {
      console.error(`[integration-cleanup] ${row.branch}: ${(err as Error).message}`);
      results.set(row.id, 'waiting');
    }
  }
  return results;
}
