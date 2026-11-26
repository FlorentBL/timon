/**
 * Garbage collector of the task worktrees and branches.
 *
 * ## Why
 *
 * `disposeWorktree()` has existed since the beginning, but NOTHING in the orchestrator
 * calls it: it relies on the merger agent, supposed to think of it at the end of the task.
 * When it forgets, when the chain breaks before the merge, or when the task is
 * closed by hand, the worktree and its branch remain — forever. Observed
 * on 2026-08-05: 9 leftover worktrees and 11 leftover branches, all on tasks
 * DONE for weeks.
 *
 * That is not fixed by reminding the agent to clean up (it was already written
 * in the skill, it was not enough) but by declaring the invariant and
 * reconciling it: a finished task whose work is integrated no longer has a
 * worktree.
 *
 * ## The absolute guard
 *
 * Nothing goes that is not already merged, and every removal goes through
 * `removeWorktreeGuarded` (`worktree.ts`): the worktree's real HEAD, never the
 * sha a merge recorded, must be in the merge sha, the base or the repository's
 * HEAD; `git status --porcelain` must be empty; the tasks are read again and
 * the folder detached from them in one transaction, only while all of them
 * are DONE; git is never asked to `--force`. A lingering worktree costs a few
 * MB; deleted work does not come back. Anything kept is reported, whatever
 * its age or the status of its task.
 *
 * A second guard, for chains on an integration branch (`feat/<topic>`): their
 * task branches are in that branch, but the branch has not landed yet. Its
 * pull request may come back with a review or a red check that the chain's
 * worktree serves, or be closed; until the integration is 'merged'
 * (`chain-landing.ts`) the worktree and the branch stay.
 *
 * Except the folder, once git proves the work reached the remote's target
 * (`refs/remotes/<remote>/<target>`, as the last fetch left it): a pull request
 * merged on the forge, outside Timon, never turns the integration 'merged',
 * and 31 such worktrees (5.6 GB) filled a disk on 2026-11-25. Only the folder
 * goes, under the same guards, and only when every task of the chain is DONE
 * and one of them recorded a merge sha; the branch stays for the landing.
 */
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { loadConfig } from './agent.js';
import { dbApi, type TaskRow } from './db.js';
import { settingBool, settingInt } from './settings.js';
import { WORKTREES_ROOT, currentBranch, deleteBranchGuarded, removeWorktreeGuarded } from './worktree.js';
import { disposeDoneTaskWorktree, taskHolders } from './worktree-service.js';
import { classifyOrphan, isWithinGrace } from './worktree-gc-guards.js';
import { purgeShell, sweepShells } from './worktree-shell.js';
import { execFileHost } from './host/index.js';
import { hasLanded, integrationOfTask } from './chain-landing.js';

const exec = execFileHost;

/** Main repo a worktree is attached to, read from the worktree
 *  itself: it is the only reliable source for an orphaned folder of which
 *  no task says any more which project it comes from. */
async function sourceRepoOf(worktreePath: string): Promise<string | null> {
  try {
    const r = await exec(
      'git',
      ['-C', worktreePath, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
      { timeout: 5000 },
    );
    const gitDir = r.stdout.trim();
    return gitDir ? dirname(gitDir) : null;
  } catch {
    return null;
  }
}

/** `loadConfig` reads an on-disk JSON: a corrupted file must not make
 *  the whole cleanup pass fail. */
function repoOfAgent(agentName: string): string | null {
  try {
    const cwd = loadConfig(agentName).cwd;
    return cwd && existsSync(cwd) ? cwd : null;
  } catch {
    return null;
  }
}

async function branchExists(repo: string, branch: string): Promise<boolean> {
  try {
    await exec('git', ['-C', repo, 'rev-parse', '--verify', branch], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/** `awaiting`: integrated into a branch that has not landed yet. */
type Outcome = { disposed: number; kept: number; awaiting: number };

/**
 * The remote-tracking ref of the target a chain on an integration branch lands
 * in, when its whole chain is DONE and recorded a merge sha; null otherwise.
 * The sha proves a merger (or a `code-self` coder) integrated the work: a DONE
 * task with no merge behind it has nothing that could have reached the target.
 */
export function remoteTargetOf(task: TaskRow, repo: string): string | null {
  if (!settingBool('TIMON_WORKTREE_GC_REMOTE_TARGET')) return null;
  const integration = integrationOfTask(task, repo);
  if (!integration?.remote || !integration.target) return null;
  const chain = dbApi.listVerificationChain(task.verification_root_id ?? task.id);
  if (chain.length === 0 || chain.some((t) => t.status !== 'DONE')) return null;
  if (!chain.some((t) => Boolean(t.merged_commit_sha))) return null;
  return `refs/remotes/${integration.remote}/${integration.target}`;
}

/** Worktrees of DONE tasks whose work is merged.
 *
 *  The same worktree is shared by the whole code→review→merge chain (the
 *  descendants inherit the parent's worktree through the deps): the removal
 *  detaches it from all of them at once, so each task is read again first and
 *  the ones already detached are skipped. */
async function collectFromTasks(graceMs: number, now: number): Promise<Outcome> {
  const out: Outcome = { disposed: 0, kept: 0, awaiting: 0 };

  for (const listed of dbApi.listTasks()) {
    if (!listed.worktree_path || !listed.branch_name) continue;
    // BLOCKED is NOT terminal: its worktree carries work to resume.
    if (listed.status !== 'DONE') continue;
    // A freshly closed task is still in the hands of the merger and of the doc
    // task that follows it; the ground is not pulled from under its feet.
    if (now - listed.updated_at < graceMs) continue;

    const repo = repoOfAgent(listed.agent_name);
    if (!repo) continue;
    if (!hasLanded(listed, repo)) {
      if (await releaseLandedOnRemote(listed, repo)) out.disposed += 1;
      else out.awaiting += 1;
      continue;
    }

    const task = dbApi.getTask(listed.id);
    if (!task || task.status !== 'DONE' || !task.worktree_path || !task.branch_name) continue;
    // Only count what really existed: the database keeps pointers to
    // worktrees unmounted long ago, counting them would announce hundreds of
    // imaginary deletions.
    const existed = existsSync(task.worktree_path) || (await branchExists(repo, task.branch_name));
    try {
      const result = await disposeDoneTaskWorktree(task, repo);
      if (!result.ok) {
        out.kept += 1;
        continue;
      }
      if (existed && (result.folder === 'removed' || result.branch === 'deleted')) {
        out.disposed += 1;
        console.log(`[worktree-gc] disposed ${task.branch_name} (task ${task.id.slice(0, 8)} DONE, merged)`);
      }
    } catch (err) {
      console.warn(`[worktree-gc] failed on ${task.branch_name}: ${(err as Error).message}`);
    }
  }
  return out;
}

/**
 * Removes the folder of a DONE task whose integration branch has not landed
 * in Timon's eyes but whose worktree HEAD is in the remote's target. The
 * branch stays: the landing, when Timon sees it, deletes it as usual.
 */
async function releaseLandedOnRemote(listed: TaskRow, repo: string): Promise<boolean> {
  const task = dbApi.getTask(listed.id);
  if (!task || task.status !== 'DONE' || !task.worktree_path || !task.branch_name) return false;
  const target = remoteTargetOf(task, repo);
  if (!target || !existsSync(task.worktree_path)) return false;
  try {
    const result = await disposeDoneTaskWorktree(task, repo, { holders: [target], keepBranch: true });
    if (!result.ok || result.folder !== 'removed') return false;
    console.log(`[worktree-gc] released ${task.branch_name} (task ${task.id.slice(0, 8)} DONE, in ${target.replace('refs/remotes/', '')}; branch kept)`);
    return true;
  } catch (err) {
    console.warn(`[worktree-gc] failed on ${task.branch_name}: ${(err as Error).message}`);
    return false;
  }
}

/** Branches of tasks whose worktree was detached (TIM-0113): the folder is
 *  gone and `worktree_path` is NULL, but `branch_name` still names a branch
 *  holding the task's commits. `collectFromTasks` starts from the folder and
 *  never sees them, and `collectOrphans` lists the disk, where nothing is
 *  left: without this pass the branch outlives the merge indefinitely.
 *
 *  Same guard as the attached case (the branch's tip in the merge sha, the
 *  base or the repository's HEAD), plus one more: a branch still named by a
 *  task that is not DONE is never touched, read again right before the
 *  deletion. A fresh branch has no commit of its own, so git calls it
 *  "merged" — that is how a live task lost its worktree on 2026-09-20. */
async function collectDetachedBranches(graceMs: number, now: number): Promise<Outcome> {
  const out: Outcome = { disposed: 0, kept: 0, awaiting: 0 };
  const tasks = dbApi.listTasks();
  const claimed = new Set(
    tasks.filter((t) => t.status !== 'DONE' && t.branch_name).map((t) => t.branch_name),
  );

  for (const task of tasks) {
    if (task.worktree_path || !task.branch_name) continue;
    if (task.status !== 'DONE') continue;
    if (now - task.updated_at < graceMs) continue;
    if (claimed.has(task.branch_name)) continue;

    const repo = repoOfAgent(task.agent_name);
    if (!repo) continue;
    if (!hasLanded(task, repo)) {
      out.awaiting += 1;
      continue;
    }

    const branch = task.branch_name;
    const stillClaimed = (): boolean => {
      const fresh = dbApi.getTask(task.id);
      if (!fresh || fresh.status !== 'DONE' || fresh.worktree_path || fresh.branch_name !== branch) return false;
      return !dbApi.listTasks().some((t) => t.branch_name === branch && (t.status !== 'DONE' || t.worktree_path));
    };
    const result = await deleteBranchGuarded(repo, branch, taskHolders(task), stillClaimed);
    if (result.branch === 'kept') {
      // Typically not merged, or checked out elsewhere: the next pass reads it again.
      out.kept += 1;
      continue;
    }
    if (result.branch === 'deleted') {
      out.disposed += 1;
      console.log(`[worktree-gc] deleted detached branch ${branch} (task ${task.id.slice(0, 8)} DONE, merged)`);
    }
    dbApi.forgetTaskBranch(task.id, branch);
  }
  return out;
}

/** Folders of `~/.timon/worktrees/` no task talks about any more — task
 *  deleted from the database, or worktree recreated under another path. The DB cannot
 *  see them: the disk has to be listed. */
async function collectOrphans(known: Set<string>, graceMs: number, now: number): Promise<Outcome> {
  const out: Outcome = { disposed: 0, kept: 0, awaiting: 0 };
  if (!existsSync(WORKTREES_ROOT)) return out;

  for (const entry of readdirSync(WORKTREES_ROOT)) {
    const path = join(WORKTREES_ROOT, entry);
    // The folder carries its task's id: a task in the database is enough to
    // claim it, even if its worktree_path column is not written yet.
    const verdict = classifyOrphan({
      isKnownPath: known.has(path),
      taskExists: Boolean(dbApi.getTask(entry)),
      withinGrace: isWithinGrace(path, graceMs, now),
    });
    if (verdict === 'skip') continue;
    if (verdict === 'grace') {
      out.kept += 1;
      continue;
    }

    const repo = await sourceRepoOf(path);
    if (!repo) {
      // No link left with git: the content can no longer be committed nor
      // recovered by git, only an ignored leftover may remain.
      purgeShell(WORKTREES_ROOT, path, graceMs, now);
      continue;
    }

    // Its own branch only (a task's or a merger's), read from the folder.
    const checkedOut = await currentBranch(path);
    const branch = checkedOut === `timon/task/${entry}` || checkedOut === `timon/merge/${entry}` ? checkedOut : null;
    const unclaimed = (): boolean => !dbApi.getTask(entry) && !dbApi.listTasks().some((t) => t.worktree_path === path);
    try {
      const result = await removeWorktreeGuarded({
        path,
        sourceRepo: repo,
        holders: ['HEAD'],
        branch,
        claim: () => (unclaimed() ? () => undefined : null),
        stillClaimed: unclaimed,
      });
      if (!result.ok) {
        out.kept += 1;
        continue;
      }
      out.disposed += 1;
      console.log(`[worktree-gc] disposed orphan ${entry.slice(0, 8)} (no task in the database)`);
    } catch (err) {
      console.warn(`[worktree-gc] failed on orphan ${entry.slice(0, 8)}: ${(err as Error).message}`);
    }
  }
  return out;
}

/**
 * Reconciliation rule: "a DONE task whose work is integrated no longer has
 * a worktree or a branch".
 *
 * Idempotent and silent when there is nothing to do, as
 * `reconcile.ts` requires.
 */
export async function reconcileStaleWorktrees(): Promise<void> {
  if (!settingBool('TIMON_WORKTREE_GC_ENABLED')) return;

  const graceMs = Math.max(0, settingInt('TIMON_WORKTREE_GC_GRACE_MIN')) * 60_000;
  const now = Date.now();

  const known = new Set(
    dbApi.listTasks().map((t) => t.worktree_path).filter((p): p is string => Boolean(p)),
  );

  const fromTasks = await collectFromTasks(graceMs, now);
  const detached = await collectDetachedBranches(graceMs, now);
  const orphans = await collectOrphans(known, graceMs, now);

  // The two passes above start from the database, and a shell is precisely
  // what the database forgot: `clearTaskWorktree` drops the path once the
  // worktree is disposed, and `collectOrphans` skips any folder named after an
  // existing task. So the disk is swept directly, sparing only what a
  // non-DONE task still claims.
  const live = new Set<string>();
  for (const t of dbApi.listTasks()) {
    if (t.status === 'DONE') continue;
    live.add(t.id);
    if (t.worktree_path) live.add(t.worktree_path);
  }
  const shells = sweepShells(WORKTREES_ROOT, graceMs, now, (name, path) => live.has(name) || live.has(path));
  if (shells.purged > 0) {
    console.log(`[worktree-gc] ${shells.purged} worktree shell(s) purged (no .git left, only ignored files)`);
  }

  const disposed = fromTasks.disposed + detached.disposed + orphans.disposed;
  const kept = fromTasks.kept + detached.kept + orphans.kept;
  const awaiting = fromTasks.awaiting + detached.awaiting;
  if (disposed === 0 && kept === 0 && awaiting === 0) return;

  // The kept branches are told once per pass, aggregated: it is a piece of
  // information ("unintegrated work is lying around"), not an alert to repeat
  // line by line every two minutes.
  console.log(
    `[worktree-gc] ${disposed} worktree(s) disposed` +
    (kept > 0 ? `, ${kept} kept — not merged, not clean or still in use, deletion refused` : '') +
    (awaiting > 0 ? `, ${awaiting} kept — integration branch not landed yet` : ''),
  );

  // `worktree prune` removes the entries whose folder disappeared under git.
  // Without it, `git worktree list` keeps ghosts that block a
  // recreation at the same path.
  const repos = new Set<string>();
  for (const t of dbApi.listTasks()) {
    const cwd = repoOfAgent(t.agent_name);
    if (cwd) repos.add(cwd);
  }
  for (const repo of repos) {
    try { await exec('git', ['-C', repo, 'worktree', 'prune'], { timeout: 10_000 }); }
    catch { /* repo unavailable: the next pass will retry */ }
  }
}
