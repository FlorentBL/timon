/**
 * What a concluded job leaves behind (`docs/KANBAN-PR-PIPELINE.md` §2.7).
 *
 * Once a job's integration branch landed (its `integrations` row 'merged',
 * its landing replayed), nothing it was built with serves any more: the
 * worktrees of its tasks, the worktree its pilot coded in
 * (`series-worktrees/<series>`, which the worktree GC never lists), the
 * branch itself, and its copy on the remote. Each one is removed here, once.
 * A cleanup of this kind destroyed a live task's worktree and a coder's
 * uncommitted work on 2026-09-20: every guard below keeps in doubt.
 *
 * - **Off unless turned on** (`TIMON_INTEGRATION_CLEANUP_ENABLED`).
 * - **Only the job's own things.** A task worktree goes only when its task
 *   belongs to the job: same project, same series, same base branch, its
 *   integration this row. Another series on the same base is never touched.
 * - **Nothing a task still holds.** While any task on the branch is not DONE
 *   the row waits; so does it while the pilot's mission runs. Each task is
 *   read again right before its worktree goes, and the worktree is detached
 *   from the tasks in the database first, only while all of them are DONE: the
 *   dispatcher, which reuses a folder through that link, never starts a task
 *   in a folder being removed.
 * - **Nothing that did not land, proven before the deletion.** A worktree goes
 *   only when it has nothing uncommitted and its real HEAD is in the target;
 *   a branch only when its tip is. A pull request merged by squash or rebase
 *   leaves everything in place: deleted work does not come back, a leftover
 *   costs nothing. Git removes a worktree without `--force`; when it refuses,
 *   the worktree keeps its link and its branch.
 * - **Never a branch checked out**, never `main`, the target or (remote) the
 *   repository's default or a protected branch; a branch created after the
 *   job concluded is not the job's, and one whose creation git cannot date is
 *   kept.
 * - **The remote copy only when asked** (`delete_remote_branch`), on the
 *   repository and URL the pull request was opened on (recorded then), after
 *   the account and push URL checks of the push, and leased on the commit that
 *   landed.
 * - **Once.** A pass reserves the row in the database before any effect, so
 *   two pollers or a reload during a pass never delete twice; a reservation a
 *   dead pass left is taken over after `INTEGRATION_CLEANUP_LEASE_MS`.
 *
 * A pull request closed without a merge only gives back its pilot's
 * worktree, once its commits are in the branch: the branch stays, the work
 * did not land.
 *
 * Each row is dealt with once (`cleaned_at`). A row waits, and is tried again
 * on the next pass, while something may still change (a task open, a pilot
 * running, the network); what a guard keeps for good is logged once and left.
 */
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { dbApi, type IntegrationRow, type TaskRow } from './db.js';
import { integrationOfTask } from './chain-landing.js';
import {
  deleteRemoteBranch, githubForge, githubRepoFromUrl, gitTransport,
  type Forge, type ForgeBranchStanding, type ForgeRunners, type GitNetworkOutcome, type GitTransport,
} from './host/forge.js';
import { getHost } from './host/index.js';
import type { ExecResult } from './host/types.js';
import { checkAccount, checkRemoteUrl, pullRequestSetting, sameUrl } from './pr-open.js';
import { readProjectIntegration } from './project-integration.js';
import { SERIES_WORKTREES_ROOT } from './series-integration.js';
import { settingBool, settingInt } from './settings.js';
import { prepareWorktreeDependencies, releaseWorktreeFolder, WORKTREES_ROOT } from './worktree.js';

/** How long a pass holds its reservation before another may take it over. */
export const INTEGRATION_CLEANUP_LEASE_MS = 30 * 60_000;

export type CleanupDeps = {
  /** Stand-ins for gh and git's network side: tests never reach a forge. */
  forge?: (configDir: string | null) => Pick<Forge, 'login'> & ForgeBranchStanding;
  transport?: (repo: string) => GitTransport;
  deleteRemote?: (repo: string, url: string, branch: string, sha: string) => Promise<GitNetworkOutcome>;
  runners?: ForgeRunners;
  /** Where the pilots' worktrees live (tests). */
  seriesWorktreesRoot?: string;
  /** Overrides the worktree GC's grace (tests). */
  graceMs?: number;
  now?: number;
  /** Called right before each deletion is decided (tests: what changes during a pass). */
  beforeDeletion?: (what: string) => Promise<void> | void;
};

/**
 * - `cleaned`: everything this row left was removed, or kept for good by a
 *   guard; the row is not looked at again.
 * - `waiting`: something may still change; the next pass tries again.
 */
export type CleanupResult = 'cleaned' | 'waiting';

type Step = 'done' | 'kept' | 'waiting';

/** A pass over one row: its reservation, and the hook of the tests. */
type Pass = { row: IntegrationRow; token: string; deps: CleanupDeps };

/** Read again right before an effect: the pass still holds the row. */
async function stillOurs(pass: Pass, what: string): Promise<boolean> {
  await pass.deps.beforeDeletion?.(what);
  return dbApi.ownsIntegrationCleanup(pass.row.id, pass.token);
}

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
  if (r.timedOut) return 'unknown';
  return r.code === 0 ? 'yes' : r.code === 1 ? 'no' : 'unknown';
}

async function commonDir(path: string): Promise<string | null> {
  const r = await gitRun(path, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  const dir = r.stdout.trim();
  return r.code === 0 && dir ? resolve(dir) : null;
}

/** True when git reports nothing uncommitted (untracked files included); null when it cannot say. */
async function clean(path: string): Promise<boolean | null> {
  const r = await gitRun(path, ['status', '--porcelain', '--untracked-files=all', '--ignore-submodules=none']);
  if (r.code !== 0 || r.timedOut) return null;
  return r.stdout.trim() === '';
}

/** The ref the landed work is in: the remote's target, or the local one. */
function landedRef(row: IntegrationRow): string {
  return row.remote ? `refs/remotes/${row.remote}/${row.target}` : `refs/heads/${row.target}`;
}

function landedName(row: IntegrationRow): string {
  return `${row.remote ? `${row.remote}/` : ''}${row.target}`;
}

/** When the job concluded: a branch created after it is not the job's. */
function concludedAt(row: IntegrationRow): number {
  return row.state === 'merged' ? (row.landed_at ?? row.updated_at) : row.updated_at;
}

/** Is `branch` checked out in a working directory of `repo` (the user's own included)? */
async function checkedOut(repo: string, branch: string): Promise<boolean | null> {
  const r = await gitRun(repo, ['worktree', 'list', '--porcelain']);
  if (r.code !== 0 || r.timedOut) return null;
  return r.stdout.split('\n').some((line) => line.trim() === `branch refs/heads/${branch}`);
}

/** When git first recorded `branch` (its oldest reflog entry), in ms; null when it cannot say. */
async function branchCreatedAt(repo: string, branch: string): Promise<number | null> {
  const r = await gitRun(repo, ['reflog', 'show', '--date=unix', '--format=%gd', `refs/heads/${branch}`, '--']);
  if (r.code !== 0 || r.timedOut) return null;
  const stamps = [...r.stdout.matchAll(/@\{(\d+)\}/g)].map((m) => Number(m[1]));
  return stamps.length > 0 ? Math.min(...stamps) * 1000 : null;
}

/** Branch names never deleted here, whatever a row says. */
function sacred(row: IntegrationRow, branch: string): boolean {
  return branch === 'main' || branch === 'master' || branch === row.target;
}

/**
 * Deletes the local `branch` of `repo` while it still ends on `tip`, which the
 * caller proved landed. `git branch -D` refuses a branch checked out in any
 * worktree (the user's own checkout included) at the moment of the deletion;
 * it names the commit it deleted, and a branch that moved since `tip` was read
 * is put back on that commit at once.
 */
async function deleteBranch(repo: string, branch: string, tip: string): Promise<Step> {
  // `core.abbrev=no`: git names the deleted commit in full, in any language.
  const r = await gitRun(repo, ['-c', 'core.abbrev=no', 'branch', '-D', '--', branch]);
  if (r.code !== 0) {
    console.log(`[integration-cleanup] ${branch} kept: git refused to delete it (${(r.stderr || r.stdout).trim().split('\n')[0]})`);
    return (await refSha(repo, `refs/heads/${branch}`)) ? 'waiting' : 'done';
  }
  const was = /\b([0-9a-f]{64}|[0-9a-f]{40})\b/.exec(r.stdout)?.[1] ?? null;
  if (was === tip) return 'done';
  // Moved between the read and the deletion, or unreadable: put it back.
  const back = was ?? tip;
  const restored = await gitRun(repo, ['update-ref', `refs/heads/${branch}`, back, '']);
  console.warn(`[integration-cleanup] ${branch} put back on ${back.slice(0, 12)}: it moved while it was deleted${restored.code === 0 ? '' : ' (restoring it failed: run `git branch ' + branch + ' ' + back + '`)'}`);
  return 'kept';
}

/** The checks a branch passes before `deleteBranch`. */
async function branchDeletable(repo: string, row: IntegrationRow, branch: string, tip: string): Promise<Step | 'go'> {
  if (sacred(row, branch)) {
    console.log(`[integration-cleanup] ${branch} kept: never deleted`);
    return 'kept';
  }
  const where = await checkedOut(repo, branch);
  // Someone works on it (the user's own checkout): it waits for them to leave.
  if (where !== false) return 'waiting';
  const landed = await ancestry(repo, tip, landedRef(row));
  if (landed === 'unknown') return 'waiting';
  if (landed === 'no') {
    console.log(`[integration-cleanup] ${branch} kept: its tip is not in ${landedName(row)}`);
    return 'kept';
  }
  const created = await branchCreatedAt(repo, branch);
  if (created === null || created > concludedAt(row)) {
    console.log(`[integration-cleanup] ${branch} kept: ${created === null ? 'git cannot tell when it was created' : 'it was created after the job concluded'}`);
    return 'kept';
  }
  return 'go';
}

// ─── The job's tasks ────────────────────────────────────────────────────────

/** Every task that names the job's branch as its base, in its project: any of them open holds the row. */
function tasksOnBranch(row: IntegrationRow): TaskRow[] {
  return dbApi.listTasksByBaseBranch(row.branch)
    .filter((t) => !row.project || !t.project || t.project === row.project);
}

/** A task of this very job: same project, same series, same base, this integration. */
function ofTheJob(row: IntegrationRow, task: TaskRow): boolean {
  return !!row.series_id
    && task.series_id === row.series_id
    && task.project === row.project
    && task.base_branch === row.branch
    && integrationOfTask(task, row.repo)?.id === row.id;
}

/**
 * One task's worktree, then its branch. The worktree GC would dispose of them
 * too, but only once its grace passed and while the branch still exists to
 * prove a task's work is in it: they go before the branch does.
 */
async function disposeTaskWorktree(pass: Pass, task: TaskRow, repoDir: string): Promise<Step> {
  const { row } = pass;
  const path = task.worktree_path!;
  const branch = task.branch_name!;
  if (existsSync(path)) {
    if ((await commonDir(path)) !== repoDir) {
      console.log(`[integration-cleanup] worktree of task ${task.id.slice(0, 8)} kept: not a worktree of ${row.repo}`);
      return 'kept';
    }
    const tidy = await clean(path);
    if (tidy !== true) {
      console.log(`[integration-cleanup] worktree of task ${task.id.slice(0, 8)} kept: ${tidy === null ? 'git cannot read its state' : 'it holds changes never committed'}`);
      return 'kept';
    }
    // Its real HEAD, never the sha recorded at the merge: a commit made since is work.
    const head = await refSha(path, 'HEAD');
    if (!head) return 'kept';
    const landed = await ancestry(row.repo, head, landedRef(row));
    if (landed !== 'yes') {
      if (landed === 'no') console.log(`[integration-cleanup] worktree of task ${task.id.slice(0, 8)} kept: its HEAD is not in ${landedName(row)}`);
      return landed === 'no' ? 'kept' : 'waiting';
    }
    if (!(await stillOurs(pass, `worktree:${task.id}`))) return 'waiting';
    // Read again, and detached from every task naming it, in one transaction.
    const fresh = dbApi.getTask(task.id);
    if (!fresh || fresh.status !== 'DONE' || fresh.worktree_path !== path || !ofTheJob(row, fresh)) return 'waiting';
    const detached = dbApi.detachDoneTaskWorktree(task.id, path);
    if (!detached) return 'waiting';
    try {
      await releaseWorktreeFolder(path, WORKTREES_ROOT);
    } catch (err) {
      // No `--force`: git refused, so the worktree, its link and its branch all stay.
      dbApi.restoreTaskWorktree(detached, path);
      await prepareWorktreeDependencies(row.repo, path).catch(() => undefined);
      console.log(`[integration-cleanup] worktree of task ${task.id.slice(0, 8)} kept: ${(err as Error).message.split('\n')[0]}`);
      return 'kept';
    }
    if (existsSync(join(path, '.git'))) {
      dbApi.restoreTaskWorktree(detached, path);
      return 'kept';
    }
  } else if (!(await stillOurs(pass, `worktree:${task.id}`)) || !dbApi.detachDoneTaskWorktree(task.id, path)) {
    return 'waiting';
  }

  const tip = await refSha(row.repo, `refs/heads/${branch}`);
  if (!tip) {
    dbApi.forgetTaskBranch(task.id, branch);
    return 'done';
  }
  const ready = await branchDeletable(row.repo, row, branch, tip);
  if (ready !== 'go') return ready;
  if (!(await stillOurs(pass, `task-branch:${task.id}`))) return 'waiting';
  const again = dbApi.getTask(task.id);
  if (!again || again.status !== 'DONE' || again.worktree_path !== null) return 'waiting';
  const step = await deleteBranch(row.repo, branch, tip);
  if (step === 'done') dbApi.forgetTaskBranch(task.id, branch);
  return step;
}

async function disposeTaskWorktrees(pass: Pass): Promise<Step> {
  const { row } = pass;
  const repoDir = await commonDir(row.repo);
  if (!repoDir) return 'waiting';
  const steps: Step[] = [];
  const seen = new Set<string>();
  for (const task of tasksOnBranch(row)) {
    if (!task.worktree_path || !task.branch_name || seen.has(task.worktree_path)) continue;
    // A task of another series, or of no series, posed on the same base: not ours.
    if (!ofTheJob(row, task)) continue;
    seen.add(task.worktree_path);
    const step = await disposeTaskWorktree(pass, task, repoDir);
    steps.push(step);
    if (step === 'waiting') break;
  }
  return steps.includes('waiting') ? 'waiting' : steps.includes('kept') ? 'kept' : 'done';
}

// ─── The pilot's worktree ───────────────────────────────────────────────────

function pilotRunning(seriesId: string): boolean {
  const missions = new Set([seriesId, dbApi.seriesPilotMission(seriesId)].filter((m): m is string => !!m));
  return [...missions].some((id) => dbApi.getMission(id)?.status === 'running');
}

/**
 * The worktree `timon pr branch` gave the pilot of a sequential job. Removed
 * when nothing in it is uncommitted and its HEAD is in the target (in the
 * branch, which stays, for a pull request closed without a merge), and git
 * agrees. One folder per series: only this repository's.
 */
async function releasePilotWorktree(pass: Pass, root: string): Promise<Step> {
  const { row } = pass;
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
  const tidy = await clean(path);
  if (tidy !== true) {
    console.log(`[integration-cleanup] pilot worktree of series ${row.series_id.slice(0, 8)} kept: ${tidy === null ? 'git cannot read its state' : 'it holds changes never committed'}`);
    return 'kept';
  }
  const head = await refSha(path, 'HEAD');
  if (!head) return 'kept';
  const holder = row.state === 'merged' ? landedRef(row) : `refs/heads/${row.branch}`;
  const contained = (await refSha(row.repo, holder)) ? await ancestry(row.repo, head, holder) : 'no';
  if (contained === 'unknown') return 'waiting';
  if (contained === 'no') {
    console.log(`[integration-cleanup] pilot worktree of series ${row.series_id.slice(0, 8)} kept: it holds commits ${row.state === 'merged' ? landedName(row) : row.branch} does not`);
    return 'kept';
  }
  if (!(await stillOurs(pass, 'pilot'))) return 'waiting';
  if (pilotRunning(row.series_id)) return 'waiting';
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

async function deleteLocalBranch(pass: Pass): Promise<Step> {
  const { row } = pass;
  const tip = await refSha(row.repo, `refs/heads/${row.branch}`);
  if (!tip) return 'done';
  const ready = await branchDeletable(row.repo, row, row.branch, tip);
  if (ready !== 'go') return ready;
  if (!(await stillOurs(pass, 'branch'))) return 'waiting';
  if (tasksOnBranch(row).some((t) => t.status !== 'DONE')) return 'waiting';
  const step = await deleteBranch(row.repo, row.branch, tip);
  if (step === 'done') console.log(`[integration-cleanup] ${row.branch} deleted: landed in ${landedName(row)}`);
  return step;
}

/** `owner/name` of a pull request's page. */
function repositoryOfPullUrl(url: string | null): string | null {
  const m = /^https:\/\/[^/\s]+\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/\d+\/?$/.exec(url ?? '');
  return m ? `${m[1]}/${m[2]}` : null;
}

const sameRepository = (a: string | null | undefined, b: string | null | undefined): boolean =>
  !!a && !!b && a.toLowerCase() === b.toLowerCase();

async function deleteRemoteCopy(pass: Pass): Promise<Step> {
  const { row, deps } = pass;
  if (!row.remote || row.mode !== 'pr' || !row.head_sha || !row.project) return 'done';
  let read;
  try { read = readProjectIntegration(row.project); } catch { return 'done'; }
  if (read.invalid || !read.integration.delete_remote_branch) return 'done';
  const keep = (why: string): Step => {
    console.log(`[integration-cleanup] remote ${row.branch} kept: ${why}`);
    return 'kept';
  };
  if (sacred(row, row.branch)) return keep('never deleted');
  // Where the pull request was opened, recorded then: the only destination.
  const repository = row.pr_repository ?? null;
  const pushUrl = row.pr_push_url ?? null;
  if (!repository || !pushUrl) return keep('the repository its pull request was opened on is not recorded');
  if (!sameRepository(githubRepoFromUrl(pushUrl), repository) || !sameRepository(repositoryOfPullUrl(row.pr_url), repository)) {
    return keep(`its pull request does not name ${repository}`);
  }
  const resolved = pullRequestSetting(row, row.project);
  if ('refusal' in resolved) return keep(resolved.refusal);
  if (!sameRepository(resolved.repository, repository) || !sameUrl(resolved.remoteUrl, pushUrl)) {
    return keep(`the project now pushes elsewhere than ${repository}, where its pull request was opened`);
  }
  // The pushed head must be in the target: what the pull request carried landed.
  const landed = await ancestry(row.repo, row.head_sha, landedRef(row));
  if (landed !== 'yes') return landed === 'no' ? keep(`its head is not in ${landedName(row)}`) : 'waiting';
  const forge = (deps.forge ?? ((dir) => githubForge(dir, deps.runners)))(resolved.setting.gh_config_dir);
  const account = await checkAccount(forge, resolved.account);
  if (!account.ok) {
    console.warn(`[integration-cleanup] remote ${row.branch} not deleted yet: ${account.detail}`);
    return 'waiting';
  }
  // `origin` repointed (a mirror, a fork): the remote branch is not deleted at all.
  const url = await checkRemoteUrl(row.repo, row.remote, pushUrl);
  if (!url.ok) return keep(url.detail);
  const transport = (deps.transport ?? ((repo) => gitTransport(repo, deps.runners)))(row.repo);
  const there = await transport.remoteBranchSha(pushUrl, row.branch);
  if (!there.ok) {
    console.warn(`[integration-cleanup] remote ${row.branch} not deleted yet: ${there.reason}`);
    return 'waiting';
  }
  // The forge deleted it already (its own setting), or someone pushed since.
  if (there.sha === null) return 'done';
  if (there.sha !== row.head_sha) return keep('it moved since its pull request was merged');
  // An earlier pass may have deleted it, and someone pushed it again at the
  // same commit: nothing tells the two apart.
  if (row.cleanup_remote_attempted_at) return keep('an earlier deletion was interrupted, and it is there again');
  const standing = await forge.branchStanding(repository, row.branch);
  if (!standing.ok) {
    console.warn(`[integration-cleanup] remote ${row.branch} not deleted yet: ${standing.reason}`);
    return 'waiting';
  }
  if (standing.standing.defaultBranch === row.branch) return keep(`it is the default branch of ${repository}`);
  if (standing.standing.protected) return keep(`it is protected on ${repository}`);

  if (!(await stillOurs(pass, 'remote'))) return 'waiting';
  if (!dbApi.setIntegrationRemoteAttempt(row.id, pass.token, Date.now())) return 'waiting';
  const deleted = await (deps.deleteRemote ?? ((repo, u, b, s) => deleteRemoteBranch(repo, u, b, s, deps.runners)))(
    row.repo, pushUrl, row.branch, row.head_sha,
  );
  if (deleted.ok) {
    console.log(`[integration-cleanup] remote ${row.branch} deleted`);
    return 'done';
  }
  // Refused or failed: nothing was deleted, the mark goes. A timeout leaves
  // it: the deletion may have happened.
  if (deleted.code !== 'timed_out') dbApi.setIntegrationRemoteAttempt(row.id, pass.token, null);
  if (deleted.code === 'rejected') return keep(deleted.reason);
  console.warn(`[integration-cleanup] remote ${row.branch} not deleted yet: ${deleted.reason}`);
  return 'waiting';
}

// ─── One row, one pass ──────────────────────────────────────────────────────

async function cleanReserved(pass: Pass): Promise<CleanupResult> {
  const { row, deps } = pass;
  if (row.state !== 'merged' && row.state !== 'closed') return 'waiting';
  if (row.state === 'merged' && row.landed_at === null) return 'waiting';
  if (!existsSync(row.repo)) return 'waiting';
  if (tasksOnBranch(row).some((t) => t.status !== 'DONE')) return 'waiting';
  if (row.series_id && pilotRunning(row.series_id)) return 'waiting';

  const steps: Step[] = [];
  if (row.state === 'merged') steps.push(await disposeTaskWorktrees(pass));
  steps.push(await releasePilotWorktree(pass, deps.seriesWorktreesRoot ?? SERIES_WORKTREES_ROOT));
  if (row.state === 'merged') {
    // The worktrees first: a task's work is proven in the target, not after it.
    if (!steps.includes('waiting')) steps.push(await deleteLocalBranch(pass));
    steps.push(await deleteRemoteCopy(pass));
  }
  return steps.includes('waiting') ? 'waiting' : 'cleaned';
}

/** Removes what the concluded integration `row` left behind, under a reservation. */
export async function cleanIntegration(row: IntegrationRow, deps: CleanupDeps = {}): Promise<CleanupResult> {
  const token = randomUUID();
  const now = Date.now();
  if (!dbApi.claimIntegrationCleanup(row.id, token, now, now - INTEGRATION_CLEANUP_LEASE_MS)) return 'waiting';
  // The row as it is now that it is ours, not as the caller listed it.
  const fresh = dbApi.getIntegrationById(row.id);
  let result: CleanupResult = 'waiting';
  try {
    if (fresh && fresh.cleaned_at == null) result = await cleanReserved({ row: fresh, token, deps });
  } finally {
    // Marking it cleaned ends the reservation too; otherwise it is handed back.
    const marked = result === 'cleaned' && dbApi.markIntegrationCleaned(row.id, token);
    if (!marked) {
      result = 'waiting';
      dbApi.releaseIntegrationCleanup(row.id, token);
    }
  }
  return result;
}

/**
 * One pass over the concluded integrations not cleaned yet. Off unless
 * `TIMON_INTEGRATION_CLEANUP_ENABLED` is on (it deletes worktrees and
 * branches by itself: opt-in), off with the worktree GC
 * (`TIMON_WORKTREE_GC_ENABLED`), and after the same grace: a job that just
 * landed is left to its last gestures.
 */
export async function cleanConcludedIntegrations(deps: CleanupDeps = {}): Promise<Map<string, CleanupResult>> {
  const results = new Map<string, CleanupResult>();
  if (!settingBool('TIMON_INTEGRATION_CLEANUP_ENABLED')) return results;
  if (!settingBool('TIMON_WORKTREE_GC_ENABLED')) return results;
  const graceMs = deps.graceMs ?? Math.max(0, settingInt('TIMON_WORKTREE_GC_GRACE_MIN')) * 60_000;
  const now = deps.now ?? Date.now();
  for (const row of dbApi.listIntegrationsToClean()) {
    if (now - concludedAt(row) < graceMs) {
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
