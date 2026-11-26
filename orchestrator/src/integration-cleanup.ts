/**
 * What a concluded job leaves behind (`docs/KANBAN-PR-PIPELINE.md` §2.7), the
 * narrow version (TODO #1210).
 *
 * Once a job's integration branch landed (its `integrations` row 'merged', its
 * landing replayed), two things it was built with serve no more and nothing
 * else removes: the local branch, and the worktree a sequential pilot coded in
 * (`series-worktrees/<series>`, which the worktree GC never lists). They are
 * removed here, once. Nothing else is:
 *
 * - the worktrees of the job's tasks are the worktree GC's, under the guards
 *   of `removeWorktreeGuarded` (TODO #1204);
 * - the branch's copy on the remote is never deleted here: a proposal waits for
 *   a person to approve it (`landing-branch-delete.ts`).
 *
 * A cleanup of this kind destroyed a live task's worktree and a coder's
 * uncommitted work on 2026-09-20; three security reviews of the wider version
 * each found a race between a proof and its deletion. Every guard below keeps
 * in doubt, and each race they found is closed by construction:
 *
 * 1. **Nothing is deleted before everything is proven.** Both removals are
 *    planned first, without any effect; a plan that waits ends the pass with
 *    everything in place. The pilot's worktree goes last: no guard runs after
 *    it, so a pass never answers `waiting` with the pilot already gone.
 * 2. **The tasks are read after git, under a lock a reopening takes too.** The
 *    effects run under `withLandingBranchLock(branch)`, which
 *    `PUT /api/tasks/:id` takes to reopen a task based on the branch. The
 *    database (tasks DONE, pilot stopped, the reservation) is read last,
 *    synchronously, after every git command of the proof. The pilot's HEAD is
 *    held by git's own lock (`HEAD.lock` in its git directory) from before it
 *    is read until the folder is gone: no commit nor checkout can move it
 *    during the proof.
 * 3. **The branch is locked before its history is read.** It is deleted in a
 *    `git update-ref --stdin` transaction prepared on the tip that landed: git
 *    holds the ref's lock while its reflog (when it was created) and the
 *    checkouts are read, so a branch deleted and made again at the same commit
 *    meanwhile cannot happen; one made before is dated from then, and kept.
 *
 * Off unless turned on (`TIMON_INTEGRATION_CLEANUP_ENABLED`, env or config
 * only), off with the worktree GC, and after its grace. A pass reserves the
 * row in the database first, so two passes never both delete.
 *
 * A pull request closed without a merge only gives back its pilot's worktree,
 * once its HEAD is in the branch: the branch stays, the work did not land.
 */
import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, openSync, realpathSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { dbApi, type IntegrationRow, type TaskRow } from './db.js';
import { getHost } from './host/index.js';
import type { ExecResult } from './host/types.js';
import { landedRef, proposeRemoteBranchDeletion, sacredBranch, type RemoteDeletionDeps } from './landing-branch-delete.js';
import { withLandingBranchLock } from './landing-lock.js';
import { SERIES_WORKTREES_ROOT } from './series-integration.js';
import { settingBool, settingInt } from './settings.js';
import { prepareWorktreeDependencies, unlinkBeforeRemoval } from './worktree.js';
import { purgeShell } from './worktree-shell.js';

/** How long a pass holds its reservation before another may take it over. */
export const INTEGRATION_CLEANUP_LEASE_MS = 30 * 60_000;

/** Where a test may act during a pass, to play what happens meanwhile. */
export type CleanupPoint =
  /** The branch's tip proven landed, before its ref is locked. */
  | 'branch:proven'
  /** The ref locked, before its reflog and its checkouts are read. */
  | 'branch:locked'
  /** Its reads done, before the database is read and the deletion committed. */
  | 'branch:commit'
  /** The pilot's HEAD read, before git proves it landed. */
  | 'pilot:proving'
  /** Its proof done, before the database is read and the folder removed. */
  | 'pilot:remove';

export type CleanupDeps = {
  /** Where the pilots' worktrees live (tests). */
  seriesWorktreesRoot?: string;
  /** Overrides the worktree GC's grace (tests). */
  graceMs?: number;
  now?: number;
  /** Called at each point of a pass (tests). */
  at?: (point: CleanupPoint) => Promise<void> | void;
  /** What the proposal of the remote deletion reaches (tests). */
  proposals?: RemoteDeletionDeps;
};

/**
 * - `cleaned`: everything this row left was removed, or kept for good by a
 *   guard; the row is not looked at again.
 * - `waiting`: something may still change; the next pass tries again.
 */
export type CleanupResult = 'cleaned' | 'waiting';

type Step = 'done' | 'kept' | 'waiting';

/** A pass over one row: its reservation, and the hooks of the tests. */
type Pass = { row: IntegrationRow; token: string; deps: CleanupDeps };

const at = async (pass: Pass, point: CleanupPoint): Promise<void> => { await pass.deps.at?.(point); };

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

function real(path: string): string {
  try { return realpathSync(path); } catch { return resolve(path); }
}

async function gitPath(cwd: string, flag: '--git-common-dir' | '--absolute-git-dir'): Promise<string | null> {
  const args = flag === '--git-common-dir' ? ['rev-parse', '--path-format=absolute', flag] : ['rev-parse', flag];
  const r = await gitRun(cwd, args);
  const dir = r.stdout.trim();
  return r.code === 0 && dir ? real(dir) : null;
}

/** True when git reports nothing uncommitted (untracked files included); null when it cannot say. */
async function clean(path: string): Promise<boolean | null> {
  const r = await gitRun(path, ['status', '--porcelain', '--untracked-files=all', '--ignore-submodules=none']);
  if (r.code !== 0 || r.timedOut) return null;
  return r.stdout.trim() === '';
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

/** When git first recorded `branch` (its oldest reflog entry), in whole seconds; null when it cannot say. */
async function branchCreatedAt(repo: string, branch: string): Promise<number | null> {
  const r = await gitRun(repo, ['reflog', 'show', '--date=unix', '--format=%gd', `refs/heads/${branch}`, '--']);
  if (r.code !== 0 || r.timedOut) return null;
  const stamps = [...r.stdout.matchAll(/@\{(\d+)\}/g)].map((m) => Number(m[1]));
  return stamps.length > 0 ? Math.min(...stamps) : null;
}

/**
 * The reflog counts whole seconds, the conclusion milliseconds: a branch git
 * dates from the very second the job concluded may have been made after it,
 * and is not taken for the job's.
 */
function createdBeforeConclusion(createdSec: number, row: IntegrationRow): boolean {
  return createdSec < Math.floor(concludedAt(row) / 1000);
}

/** A ref name the transaction's line format carries as is: no space, no control character. */
const PLAIN_BRANCH = /^(?!-)[^\s\x00-\x1f\x7f~^:?*[\\]+$/;

// ─── What the database says, read last ──────────────────────────────────────

/** Every task that names the job's branch as its base, in its project: any of them open holds the row. */
function tasksOnBranch(row: IntegrationRow): TaskRow[] {
  return dbApi.listTasksByBaseBranch(row.branch)
    .filter((t) => !row.project || !t.project || t.project === row.project);
}

function pilotRunning(seriesId: string): boolean {
  const missions = new Set([seriesId, dbApi.seriesPilotMission(seriesId)].filter((m): m is string => !!m));
  return [...missions].some((id) => dbApi.getMission(id)?.status === 'running');
}

/**
 * Synchronous, so nothing runs between it and the effect that follows but
 * that effect's own git command: a task reopened through the API waits for the
 * landing lock, any other change is read here.
 */
function nothingHolds(pass: Pass): boolean {
  const { row } = pass;
  if (!dbApi.ownsIntegrationCleanup(row.id, pass.token)) return false;
  if (tasksOnBranch(row).some((t) => t.status !== 'DONE')) return false;
  if (row.series_id && pilotRunning(row.series_id)) return false;
  return true;
}

// ─── The branch ─────────────────────────────────────────────────────────────

type BranchPlan = { step: 'go'; tip: string } | { step: Step };

/** Read only: is the job's branch there, landed, and git able to tell the rest? */
async function planBranch(pass: Pass): Promise<BranchPlan> {
  const { row } = pass;
  if (row.state !== 'merged') return { step: 'done' };
  const tip = await refSha(row.repo, `refs/heads/${row.branch}`);
  if (!tip) return { step: 'done' };
  if (sacredBranch(row, row.branch) || !PLAIN_BRANCH.test(row.branch)) {
    console.log(`[integration-cleanup] ${row.branch} kept: never deleted here`);
    return { step: 'kept' };
  }
  const landed = await ancestry(row.repo, tip, landedRef(row));
  if (landed === 'unknown') return { step: 'waiting' };
  if (landed === 'no') {
    console.log(`[integration-cleanup] ${row.branch} kept: its tip is not in ${landedName(row)}`);
    return { step: 'kept' };
  }
  // Someone works on it (the user's own checkout): it waits for them to leave.
  if ((await checkedOut(row.repo, row.branch)) !== false) return { step: 'waiting' };
  return { step: 'go', tip };
}

/** A `git update-ref --stdin` transaction whose ref is locked until it commits or aborts. */
type RefDeletion = { commit(): Promise<boolean>; abort(): void };

const TRANSACTION_MS = 30_000;

/**
 * Locks `ref` for its deletion while it still ends on `tip`: `prepare` takes
 * git's lock on it, so nobody can move, delete or make it again until
 * `commit` (or the end of the session, which aborts). Null when git refused
 * (the branch moved, or someone else holds its lock).
 */
async function prepareRefDeletion(repo: string, ref: string, tip: string): Promise<RefDeletion | null> {
  let child: ChildProcess;
  try {
    child = getHost().spawn('git', ['-C', repo, 'update-ref', '--stdin'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  } catch {
    return null;
  }
  const lines: string[] = [];
  let pending = '';
  let exited = false;
  let wake: (() => void) | null = null;
  const nudge = (): void => { const w = wake; wake = null; w?.(); };
  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    pending += chunk;
    let nl = pending.indexOf('\n');
    while (nl >= 0) {
      lines.push(pending.slice(0, nl).trim());
      pending = pending.slice(nl + 1);
      nl = pending.indexOf('\n');
    }
    nudge();
  });
  child.stderr?.resume();
  child.stdin?.on('error', () => undefined);
  child.on('error', () => { exited = true; nudge(); });
  child.on('close', () => { exited = true; nudge(); });
  const deadline = Date.now() + TRANSACTION_MS;
  const until = async (line: string): Promise<boolean> => {
    for (;;) {
      if (lines.includes(line)) return true;
      const left = deadline - Date.now();
      if (exited || left <= 0) return false;
      await new Promise<void>((done) => {
        const timer = setTimeout(done, left);
        wake = () => { clearTimeout(timer); done(); };
      });
    }
  };
  const stop = (): void => {
    // The end of input aborts an open transaction and releases the lock.
    child.stdin?.end();
    if (!exited) setTimeout(() => { if (!exited) child.kill(); }, 5_000).unref();
  };
  child.stdin?.write(`start\ndelete ${ref} ${tip}\nprepare\n`);
  if (!(await until('prepare: ok'))) {
    stop();
    return null;
  }
  return {
    async commit() {
      child.stdin?.write('commit\n');
      const ok = await until('commit: ok');
      stop();
      return ok;
    },
    abort: stop,
  };
}

/**
 * Deletes the job's branch while it still ends on `tip`, the commit proven
 * landed. Its reflog and its checkouts are read with the ref locked; the
 * database is read last. A branch checked out between the reads and the
 * commit (git does not lock a branch to check it out) is put back at once.
 */
async function deleteBranch(pass: Pass, tip: string): Promise<Step> {
  const { row } = pass;
  const ref = `refs/heads/${row.branch}`;
  await at(pass, 'branch:proven');
  const tx = await prepareRefDeletion(row.repo, ref, tip);
  if (!tx) {
    const now = await refSha(row.repo, ref);
    if (!now) return 'done';
    // Moved since its proof, or locked by someone else: the next pass reads it again.
    return 'waiting';
  }
  let committed = false;
  try {
    await at(pass, 'branch:locked');
    const created = await branchCreatedAt(row.repo, row.branch);
    if (created === null || !createdBeforeConclusion(created, row)) {
      console.log(`[integration-cleanup] ${row.branch} kept: ${created === null ? 'git cannot tell when it was created' : 'git dates it from the job\'s conclusion or later'}`);
      return 'kept';
    }
    if ((await checkedOut(row.repo, row.branch)) !== false) return 'waiting';
    await at(pass, 'branch:commit');
    if (!nothingHolds(pass)) return 'waiting';
    committed = await tx.commit();
  } finally {
    if (!committed) tx.abort();
  }
  if (!committed) return 'waiting';
  if ((await checkedOut(row.repo, row.branch)) !== false) {
    const back = await gitRun(row.repo, ['update-ref', ref, tip, '']);
    console.warn(`[integration-cleanup] ${row.branch} put back on ${tip.slice(0, 12)}: it was checked out while it was deleted${back.code === 0 ? '' : ` (restoring it failed: run \`git branch ${row.branch} ${tip}\`)`}`);
    return 'waiting';
  }
  console.log(`[integration-cleanup] ${row.branch} deleted: landed in ${landedName(row)}`);
  return 'done';
}

// ─── The pilot's worktree ───────────────────────────────────────────────────

type PilotPlan = { step: 'go'; path: string; holder: string; repoDir: string } | { step: Step };

/** Where the pilot's work must be for its folder to go: the target once merged, the branch otherwise. */
function pilotHolder(row: IntegrationRow): string {
  return row.state === 'merged' ? landedRef(row) : `refs/heads/${row.branch}`;
}

/** Read only: is the pilot's worktree there, clean, and its HEAD where it must be? */
async function planPilot(pass: Pass, root: string): Promise<PilotPlan> {
  const { row } = pass;
  if (!row.series_id) return { step: 'done' };
  const path = join(root, row.series_id);
  if (!existsSync(path)) return { step: 'done' };
  const name = `pilot worktree of series ${row.series_id.slice(0, 8)}`;
  const [own, repoDir] = await Promise.all([gitPath(path, '--git-common-dir'), gitPath(row.repo, '--git-common-dir')]);
  if (!own) {
    // A folder git no longer knows: not a worktree any more, nothing to prove.
    console.log(`[integration-cleanup] ${name} kept: git does not know it`);
    return { step: 'kept' };
  }
  if (own !== repoDir) return { step: 'done' };
  const tidy = await clean(path);
  if (tidy !== true) {
    if (tidy === false) console.log(`[integration-cleanup] ${name} kept: it holds changes never committed`);
    return { step: tidy === null ? 'waiting' : 'kept' };
  }
  const head = await refSha(path, 'HEAD');
  if (!head) return { step: 'kept' };
  const holder = pilotHolder(row);
  const contained = (await refSha(row.repo, holder)) ? await ancestry(row.repo, head, holder) : 'no';
  if (contained === 'unknown') return { step: 'waiting' };
  if (contained === 'no') {
    console.log(`[integration-cleanup] ${name} kept: it holds commits ${row.state === 'merged' ? landedName(row) : row.branch} does not`);
    return { step: 'kept' };
  }
  return { step: 'go', path, holder, repoDir: own };
}

/**
 * Removes the pilot's worktree, last. Git's lock on its HEAD is taken first
 * and held until git removed the folder: no commit, checkout or reset in it
 * can move HEAD between its proof and the removal. `git worktree remove`
 * without `--force` refuses a folder that changed meanwhile.
 */
async function removePilot(pass: Pass, plan: Extract<PilotPlan, { step: 'go' }>, root: string): Promise<Step> {
  const { row } = pass;
  const { path, holder, repoDir } = plan;
  const name = `pilot worktree of series ${row.series_id!.slice(0, 8)}`;
  const gitDir = await gitPath(path, '--absolute-git-dir');
  // Its own git directory, under the repository's `worktrees/`: never the main one.
  if (!gitDir || dirname(gitDir) !== join(repoDir, 'worktrees')) return 'kept';
  const headLock = join(gitDir, 'HEAD.lock');
  try {
    closeSync(openSync(headLock, 'wx'));
  } catch {
    // Git is moving its HEAD right now: the next pass reads it again.
    return 'waiting';
  }
  let unlinked = false;
  let removed = false;
  try {
    const head = await refSha(path, 'HEAD');
    if (!head) return 'kept';
    await at(pass, 'pilot:proving');
    const contained = await ancestry(row.repo, head, holder);
    if (contained !== 'yes') return contained === 'no' ? 'kept' : 'waiting';
    // Read again: a backend that ignores `HEAD.lock` (reftable) still stops here.
    if ((await refSha(path, 'HEAD')) !== head) return 'waiting';
    if ((await clean(path)) !== true) return 'waiting';
    await unlinkBeforeRemoval(path);
    unlinked = true;
    await at(pass, 'pilot:remove');
    if (!nothingHolds(pass)) return 'waiting';
    // From the common dir, never from inside the folder: Windows locks a process's current directory.
    const r = await gitRun(repoDir, ['worktree', 'remove', path]);
    if (r.code !== 0 || existsSync(join(path, '.git'))) {
      console.log(`[integration-cleanup] ${name} kept: ${(r.stderr || 'git left it in place').split('\n')[0]}`);
      return 'kept';
    }
    removed = true;
  } finally {
    // Git deleted the lock with the folder's git directory; otherwise it is ours to give back.
    rmSync(headLock, { force: true });
    if (!removed && unlinked && existsSync(path)) await prepareWorktreeDependencies(row.repo, path).catch(() => undefined);
  }
  purgeShell(root, path, 0, Date.now());
  console.log(`[integration-cleanup] ${name} removed`);
  return 'done';
}

// ─── One row, one pass ──────────────────────────────────────────────────────

/**
 * The head the job integrated, in the target: the pull request's head as it
 * was merged, or (a local landing) the branch's tip. A squash or a rebase
 * leaves it out, and nothing is deleted.
 */
async function integrationLanded(row: IntegrationRow): Promise<'yes' | 'no' | 'unknown'> {
  const head = row.head_sha ?? (await refSha(row.repo, `refs/heads/${row.branch}`));
  if (!head || !SHA.test(head)) return 'no';
  return ancestry(row.repo, head, landedRef(row));
}

async function cleanReserved(pass: Pass): Promise<CleanupResult> {
  const { row, deps } = pass;
  if (row.state !== 'merged' && row.state !== 'closed') return 'waiting';
  if (row.state === 'merged' && row.landed_at == null) return 'waiting';
  if (!existsSync(row.repo)) return 'waiting';
  if (!nothingHolds(pass)) return 'waiting';

  if (row.state === 'merged') {
    const proof = await integrationLanded(row);
    if (proof === 'unknown') return 'waiting';
    if (proof === 'no') {
      console.log(`[integration-cleanup] ${row.branch}: everything kept, the head it integrated is not in ${landedName(row)} (merged by squash or rebase?)`);
      return 'cleaned';
    }
  }
  const root = deps.seriesWorktreesRoot ?? SERIES_WORKTREES_ROOT;
  // Every proof before the first effect: a plan that waits leaves everything.
  const branch = await planBranch(pass);
  const pilot = await planPilot(pass, root);
  if (branch.step === 'waiting' || pilot.step === 'waiting') return 'waiting';

  const outcome = await withLandingBranchLock(row.branch, async (): Promise<Step> => {
    const steps: Step[] = [];
    if (branch.step === 'go') {
      const step = await deleteBranch(pass, branch.tip);
      // The pilot's worktree is not touched after a branch step that waits.
      if (step === 'waiting') return 'waiting';
      steps.push(step);
    }
    if (pilot.step === 'go') steps.push(await removePilot(pass, pilot, root));
    return steps.includes('waiting') ? 'waiting' : 'done';
  });
  if (outcome === 'waiting') return 'waiting';

  if (row.state === 'merged') {
    try {
      const proposed = await proposeRemoteBranchDeletion(row, deps.proposals);
      if (proposed && !proposed.ok) console.log(`[integration-cleanup] remote ${row.branch}: no deletion proposed (${proposed.reason})`);
    } catch (err) {
      // A proposal is a courtesy: the local cleanup it follows stands.
      console.warn(`[integration-cleanup] remote ${row.branch}: no deletion proposed (${(err as Error).message})`);
    }
  }
  return 'cleaned';
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
 * `TIMON_INTEGRATION_CLEANUP_ENABLED` is on (env or config only: it deletes a
 * branch and a worktree by itself), off with the worktree GC
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
