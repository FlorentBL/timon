/**
 * The git worktree of a task, created and disposed through one path for the
 * routes (`plugins-bundled/kanban-code`) and the plugin facade
 * (`plugins/worktrees-facade.ts`). The bodies are the routes' own, with
 * `res.status(..).json(..)` turned into a thrown `WorktreeServiceError`.
 */
import { existsSync } from 'node:fs';
import { loadConfig } from './agent.js';
import { dbApi, type TaskRow } from './db.js';
import {
  createWorktree, isGitRepo, releaseWorktreeFolder, removeWorktreeGuarded,
  type GuardedRemovalResult, type WorktreeInfo,
} from './worktree.js';

/** `invalid` (400: no cwd, not a repo, bad base), `busy` (409: the task is
 *  running), `failed` (500: git refused). */
export type WorktreeErrorCode = 'invalid' | 'busy' | 'failed';

export class WorktreeServiceError extends Error {
  constructor(readonly code: WorktreeErrorCode, message: string) {
    super(message);
    this.name = 'WorktreeServiceError';
  }
}

/** A base is handed to `git worktree add` as a positional argument: a leading `-` would be read as an option. */
const BASE_REF = /^[A-Za-z0-9._/][A-Za-z0-9._/-]{0,199}$/;

export function worktreeOfTask(task: TaskRow): {
  task_id: string;
  worktree_path: string | null;
  branch_name: string | null;
  base_branch: string | null;
  merged_commit_sha: string | null;
} {
  return {
    task_id: task.id, worktree_path: task.worktree_path, branch_name: task.branch_name,
    base_branch: task.base_branch, merged_commit_sha: task.merged_commit_sha,
  };
}

export async function createTaskWorktree(task: TaskRow, base?: string): Promise<WorktreeInfo> {
  const cfg = loadConfig(task.agent_name);
  if (!cfg.cwd) throw new WorktreeServiceError('invalid', 'agent has no cwd');
  if (!(await isGitRepo(cfg.cwd))) throw new WorktreeServiceError('invalid', `agent cwd is not a git repo: ${cfg.cwd}`);
  if (base !== undefined && !BASE_REF.test(base)) throw new WorktreeServiceError('invalid', `invalid base ref: "${base}"`);
  try {
    const info = await createWorktree(task.id, cfg.cwd, base);
    dbApi.setTaskWorktree(task.id, info.path, info.branch, info.base);
    return info;
  } catch (err) {
    throw new WorktreeServiceError('failed', (err as Error).message);
  }
}

/**
 * Where a task's work must already be before its worktree or branch may go:
 * the merge sha it recorded, its base, or the repository's current branch
 * (base `dev`, everything ends up on `main`).
 */
export function taskHolders(task: TaskRow): string[] {
  return [task.merged_commit_sha, task.base_branch, 'HEAD'].filter((ref): ref is string => Boolean(ref));
}

/**
 * Removes a DONE task's worktree and branch under the guards of
 * `removeWorktreeGuarded`. The task is read again and the folder detached from
 * every task naming it in one transaction, only while all of them are DONE; a
 * refused removal gives it back. Once the branch is gone (or was already),
 * the tasks forget it. Shared by the GC and `timon worktree dispose`.
 */
export async function disposeDoneTaskWorktree(
  task: TaskRow,
  repo: string,
  opts: {
    /** Refs the worktree's HEAD must be in, instead of the task's own holders. */
    holders?: readonly string[];
    /** Remove the folder only: the branch and its record stay. */
    keepBranch?: boolean;
  } = {},
): Promise<GuardedRemovalResult> {
  const path = task.worktree_path;
  const branch = task.branch_name;
  if (!path || !branch) return { ok: false, reason: 'the task has no worktree', retry: false };
  let detached: string[] = [];
  const result = await removeWorktreeGuarded({
    path,
    sourceRepo: repo,
    holders: opts.holders ?? taskHolders(task),
    branch: opts.keepBranch ? null : branch,
    claim: () => {
      const fresh = dbApi.getTask(task.id);
      if (!fresh || fresh.status !== 'DONE' || fresh.worktree_path !== path) return null;
      const ids = dbApi.detachDoneTaskWorktree(task.id, path);
      if (!ids) return null;
      detached = ids;
      return () => dbApi.restoreTaskWorktree(ids, path);
    },
    stillClaimed: () => detached.every((id) => dbApi.getTask(id)?.status === 'DONE'),
  });
  if (result.ok && (result.branch === 'deleted' || result.branch === 'absent')) {
    for (const id of detached) dbApi.forgetTaskBranch(id, branch);
  }
  return result;
}

/**
 * Idempotent: a task with no worktree answers `disposed: false`. Only a DONE
 * task's, clean and merged: anything else is refused (`busy`), and detaching
 * the worktree is the gesture that frees a folder while keeping its branch.
 * Git is never asked to force a removal (a `force` from an older caller is
 * dropped before it gets here).
 */
export async function disposeTaskWorktree(task: TaskRow): Promise<{ disposed: boolean }> {
  if (!task.worktree_path || !task.branch_name) return { disposed: false };
  // Folder already gone (removed by hand with git): only the stale reference is
  // left. It needs neither the agent's cwd nor git, and the branch itself is
  // left in the repository in case it still holds unmerged commits (TIM-0113).
  if (!existsSync(task.worktree_path)) {
    dbApi.clearTaskWorktree(task.id);
    return { disposed: true };
  }
  if (task.status !== 'DONE') {
    throw new WorktreeServiceError('busy', `The task is ${task.status}, not DONE: its worktree is kept. Detach it instead to free the folder and keep its branch.`);
  }
  const cfg = loadConfig(task.agent_name);
  if (!cfg.cwd) throw new WorktreeServiceError('invalid', 'agent has no cwd');
  const result = await disposeDoneTaskWorktree(task, cfg.cwd);
  if (!result.ok) throw new WorktreeServiceError('busy', `The worktree is kept: ${result.reason}.`);
  if (result.branch === 'kept') console.warn(`[worktree] branch ${task.branch_name} kept: ${result.branchReason ?? 'not merged'}`);
  return { disposed: true };
}

/**
 * Detaches a task from its worktree (TIM-0113): the folder goes, the branch and
 * its commits stay, and the next dispatch reattaches to the branch. Unlike
 * {@link disposeTaskWorktree}, which deletes the branch once it is merged,
 * this is safe on unmerged work — and git refuses a folder with uncommitted
 * changes. Never on a running task: its agent is working in that folder.
 */
export async function detachTaskWorktree(task: TaskRow): Promise<{ detached: boolean }> {
  if (!task.worktree_path) return { detached: false };
  if (task.status === 'IN_PROGRESS') throw new WorktreeServiceError('busy', 'The task is running in this worktree. Stop it first.');
  if (existsSync(task.worktree_path)) {
    try {
      await releaseWorktreeFolder(task.worktree_path);
    } catch (err) {
      throw new WorktreeServiceError('failed', (err as Error).message);
    }
  }
  dbApi.detachTaskWorktree(task.id);
  return { detached: true };
}
