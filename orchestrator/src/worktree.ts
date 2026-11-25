/**
 * Worktree manager — management of the git worktrees created by TIMON for the
 * `type=code` tasks (and their review/merge descendants, which inherit the
 * same worktree through the deps).
 *
 * Convention:
 *   - Root: ~/.timon/worktrees/
 *   - One worktree per task: ~/.timon/worktrees/<task-id>/
 *   - Branch: timon/task/<task-id>
 *   - Source branch: HEAD of the agent's repo at creation time
 *     (unless explicitly overridden through the 3rd arg of createWorktree).
 *
 * Lifecycle:
 *   1. The dispatcher detects task.type='code' without worktree_path → createWorktree
 *   2. The builder commits in the branch
 *   3. The reviewer reads it (always in the same worktree, shared through deps)
 *   4. The merger merges the branch into the base + gets the sha → setTaskMergedSha
 *   5. The merger calls disposeWorktree → the local branch is deleted,
 *      the worktree dir is unmounted. The DB events and the sha remain the audit.
 */
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { TIMON_HOME } from './paths.js';
import { execFileHost, linkDirectory } from './host/index.js';
import { execTree } from './host/kill-tree.js';
import { settingNum } from './settings.js';
import { purgeShell, unlinkWorktreeLinks } from './worktree-shell.js';

const exec = execFileHost;

// Derived from TIMON_HOME and not from a hard-coded homedir(): an instance launched with a
// test TIMON_HOME otherwise scanned the REAL worktrees, which its garbage collector
// saw as all orphaned (empty database) and deleted — worktree and branch.
export const WORKTREES_ROOT = join(TIMON_HOME, 'worktrees');

export type WorktreeInfo = {
  taskId: string;
  path: string;
  branch: string;
  base: string;
  sourceRepo: string;
};

/** Share installed dependencies for tracked packages, without installing or replacing anything. */
export async function prepareWorktreeDependencies(repoCwd: string, worktreePath: string): Promise<void> {
  try {
    const root = realpathSync(worktreePath);
    const { stdout } = await exec('git', [
      '-C', worktreePath, 'ls-files', '-z', '--', 'package.json', '**/package.json',
    ], { timeout: 10_000 });
    for (const manifest of new Set(stdout.split('\0').filter(Boolean))) {
      const packageDir = dirname(manifest);
      const source = join(repoCwd, packageDir, 'node_modules');
      const parent = join(worktreePath, packageDir);
      const destination = join(parent, 'node_modules');
      try {
        if (!existsSync(source) || !statSync(source).isDirectory() || !existsSync(parent)) continue;
        // A tracked package path must not redirect writes outside this worktree.
        const inside = relative(root, realpathSync(parent));
        if (isAbsolute(inside) || inside === '..' || inside.startsWith(`..${sep}`)) continue;
        // lstat also preserves dangling links and package-specific installations.
        if (lstatSync(destination, { throwIfNoEntry: false })) continue;
        // Only ignored paths can be shared without dirtying the worktree.
        try {
          await exec('git', ['-C', worktreePath, 'check-ignore', '-q', '--', join(packageDir, 'node_modules')], { timeout: 10_000 });
        } catch {
          console.warn(`[worktree] dependencies not shared for ${packageDir}: node_modules is not git-ignored`);
          continue;
        }
        linkDirectory(source, destination);
      } catch (error) {
        console.warn(`[worktree] Could not link dependencies for ${manifest}: ${(error as Error).message}`);
      }
    }
    await linkDeclaredFolders(repoCwd, worktreePath, root);
  } catch (error) {
    console.warn(`[worktree] Could not prepare dependencies: ${(error as Error).message}`);
  }
}

/** Tracked file at a repository's root listing the ignored folders a task worktree shares with the main clone. */
export const WORKTREE_LINKS_FILE = '.worktreelinks';

/**
 * Relative folder paths read from a `.worktreelinks` file: one per line, `#`
 * starts a comment. Absolute paths and paths that climb out of the repository
 * are dropped, since a link there would let a task write outside its project.
 */
export function parseWorktreeLinks(text: string): string[] {
  const paths: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim().replace(/[\\/]+$/, '');
    if (!line || isAbsolute(line) || /^[A-Za-z]:/.test(line)) continue;
    const parts = line.split(/[\\/]+/);
    if (parts.some((part) => part === '..' || part === '.' || part === '')) continue;
    paths.push(join(...parts));
  }
  return [...new Set(paths)];
}

function isInside(root: string, path: string): boolean {
  const inside = relative(root, realpathSync(path));
  return !(isAbsolute(inside) || inside === '..' || inside.startsWith(`..${sep}`));
}

/**
 * Creates the missing parent folders of a declared link (`.claude` for
 * `.claude/skills`: an untracked folder is absent from a fresh worktree), but
 * only inside the worktree and only when git ignores them, since a `git add -A`
 * would otherwise commit the link. Returns false when it refuses.
 */
async function createIgnoredParents(worktreePath: string, root: string, rel: string): Promise<boolean> {
  const parts = dirname(rel).split(sep);
  let depth = parts.length;
  while (depth > 0 && !existsSync(join(worktreePath, ...parts.slice(0, depth)))) depth -= 1;
  // The nearest existing ancestor may be a link: what gets created must stay in this worktree.
  if (!isInside(root, join(worktreePath, ...parts.slice(0, depth)))) {
    console.warn(`[worktree] ${rel} not linked: its parent folder resolves outside the worktree`);
    return false;
  }
  // Git never looks inside an ignored folder, so checking the topmost missing one covers its
  // descendants; the trailing slash makes git match it as the folder it will be.
  const topmost = `${parts.slice(0, depth + 1).join('/')}/`;
  try {
    await exec('git', ['-C', worktreePath, 'check-ignore', '-q', '--', topmost], { timeout: 10_000 });
  } catch {
    console.warn(`[worktree] ${rel} not linked: its parent folder ${topmost} is missing from the worktree and git does not ignore it`);
    return false;
  }
  mkdirSync(join(worktreePath, dirname(rel)), { recursive: true });
  return true;
}

/**
 * Links the folders a repository declares in `.worktreelinks` (an ignored
 * notes repository, the project's agent skills…) from the main clone into a
 * task worktree, under the same guards as the dependencies: the folder exists
 * in the main clone, git ignores it, the worktree has nothing at that path
 * yet, and the link stays inside the worktree. Missing parent folders are
 * created when git ignores them. Removing the worktree unlinks it without
 * touching the folder it points to.
 */
async function linkDeclaredFolders(repoCwd: string, worktreePath: string, root: string): Promise<void> {
  let text: string;
  try { text = readFileSync(join(worktreePath, WORKTREE_LINKS_FILE), 'utf8'); } catch { return; }
  for (const rel of parseWorktreeLinks(text)) {
    const source = join(repoCwd, rel);
    const destination = join(worktreePath, rel);
    try {
      if (!existsSync(source) || !statSync(source).isDirectory()) continue;
      const parent = dirname(destination);
      if (!existsSync(parent) && !(await createIgnoredParents(worktreePath, root, rel))) continue;
      if (!isInside(root, parent)) continue;
      if (lstatSync(destination, { throwIfNoEntry: false })) continue;
      try {
        // Checked as git will see the link: a file. A directory-only rule (`/docs/`) does not
        // cover a symlink, which would then show as untracked and be committed by a `git add -A`.
        await exec('git', ['-C', worktreePath, 'check-ignore', '-q', '--', rel], { timeout: 10_000 });
      } catch {
        console.warn(`[worktree] ${rel} not linked: ${WORKTREE_LINKS_FILE} lists it but git does not ignore it as a file (write \`/${rel.split(sep).join('/')}\`, without a trailing slash)`);
        continue;
      }
      linkDirectory(source, destination);
    } catch (error) {
      console.warn(`[worktree] Could not link ${rel}: ${(error as Error).message}`);
    }
  }
}

/** True if `cwd` is inside a git working tree. */
export async function isGitRepo(cwd: string): Promise<boolean> {
  if (!existsSync(cwd)) return false;
  try {
    const r = await exec('git', ['-C', cwd, 'rev-parse', '--is-inside-work-tree'], { timeout: 2000 });
    return r.stdout.trim() === 'true';
  } catch {
    return false;
  }
}

/** Current branch (HEAD) of a repo. Null if detached or on error. */
export async function currentBranch(cwd: string): Promise<string | null> {
  try {
    const r = await exec('git', ['-C', cwd, 'branch', '--show-current'], { timeout: 2000 });
    const out = r.stdout.trim();
    return out || null;
  } catch {
    return null;
  }
}

/** Does the ref (a branch, or any revision) resolve in this repo? */
export async function branchExists(cwd: string, branch: string): Promise<boolean> {
  try {
    await exec('git', ['-C', cwd, 'rev-parse', '--verify', branch], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/** Sha of the current HEAD. Null if not a repo. */
export async function headSha(cwd: string): Promise<string | null> {
  try {
    const r = await exec('git', ['-C', cwd, 'rev-parse', 'HEAD'], { timeout: 2000 });
    return r.stdout.trim() || null;
  } catch {
    return null;
  }
}

/** The tail of each worktree folder's queue of gestures, by resolved path. */
const worktreeLocks = new Map<string, Promise<void>>();

/**
 * Runs `fn` alone on the worktree folder `path`, within this process: the
 * folder of a task is computed from its id, so a task reopened and dispatched
 * while the cleanup after a landing removes its worktree would otherwise get
 * the folder being deleted, or have its fresh one deleted
 * (`integration-cleanup.ts`). Every gesture that makes, reuses or removes a
 * task's folder for the dispatcher or the cleanup takes it. Not reentrant.
 * One daemon per home runs every dispatcher and every cleanup, so no mark in
 * the database is needed.
 */
export async function withWorktreeLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const key = resolve(path);
  const before = worktreeLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((done) => { release = done; });
  const tail = before.then(() => mine);
  worktreeLocks.set(key, tail);
  await before;
  try {
    return await fn();
  } finally {
    release();
    if (worktreeLocks.get(key) === tail) worktreeLocks.delete(key);
  }
}

/**
 * Creates a worktree for a task. Idempotent: if a worktree for this
 * `taskId` already exists on disk, returns its info without recreating it.
 *
 * `repoCwd` must point to the main repo (typically the agent's cfg.cwd).
 * `git worktree add` runs there; the worktree lands
 * in WORKTREES_ROOT/<taskId>. Under {@link withWorktreeLock}.
 */
export async function createWorktree(
  taskId: string,
  repoCwd: string,
  base?: string,
  branchName?: string,
): Promise<WorktreeInfo> {
  return withWorktreeLock(join(WORKTREES_ROOT, taskId), () => createWorktreeLocked(taskId, repoCwd, base, branchName));
}

async function createWorktreeLocked(
  taskId: string,
  repoCwd: string,
  base?: string,
  branchName?: string,
): Promise<WorktreeInfo> {
  if (!(await isGitRepo(repoCwd))) {
    throw new Error(`createWorktree: ${repoCwd} is not a git repo`);
  }
  const path = join(WORKTREES_ROOT, taskId);
  // `branchName` serves the merger, which receives its OWN worktree (`timon/merge/…`)
  // instead of operating in the main repo — see `refreshWorktreeBase`
  // and the incident of 2026-08-20.
  const branch = branchName ?? `timon/task/${taskId}`;
  const stallMs = worktreeAddStallMs();
  // If the dir already exists AND is a valid worktree, we assume we
  // are in a re-spawn: idempotent return. Only once its checkout is known to be
  // complete: `.git` exists from the first second of `git worktree add`, and a
  // task started on a checkout cut short would see half of its files missing (TIM-0164).
  if (existsSync(path) && (await isGitRepo(path))) {
    const state = await checkoutState(path, stallMs);
    if (state === 'complete') {
      const existingBase = base ?? (await currentBranch(repoCwd)) ?? 'HEAD';
      await prepareWorktreeDependencies(repoCwd, path);
      return { taskId, path, branch, base: existingBase, sourceRepo: repoCwd };
    }
    if (state === 'writing') {
      throw worktreeError(`the worktree ${path} is still being written: git holds its index.lock. Wait for git to finish, or delete that lock if no git runs any more, then move the task back to Pending.`);
    }
    if (state === 'unreadable') {
      throw worktreeError(`git status does not answer in the worktree ${path}. Check the folder, or detach the task's worktree, then move the task back to Pending.`);
    }
    // No index and nobody writing one: a checkout that never finished. Nothing
    // was ever committed from it; its branch is kept and the folder made again.
    console.warn(`[worktree] ${path} holds a checkout that never finished: making it again`);
    await discardHalfMadeWorktree(repoCwd, path);
  }
  mkdirSync(WORKTREES_ROOT, { recursive: true });
  const baseRef = base ?? (await currentBranch(repoCwd)) ?? 'HEAD';
  // The branch outlives the folder: an unmounted worktree (dispose, GC, manual
  // purge) leaves its commits behind. Recreating it with -b would fail
  // and, worse, we would restart from the base, losing sight of that work — so we
  // reattach to the existing branch rather than forge a new one.
  const addArgs = (await branchExists(repoCwd, branch))
    ? ['worktree', 'add', path, branch]
    : ['worktree', 'add', '-b', branch, path, baseRef];
  await addWorktree(repoCwd, path, addArgs, stallMs);
  await prepareWorktreeDependencies(repoCwd, path);
  return { taskId, path, branch, base: baseRef, sourceRepo: repoCwd };
}

const WORKTREE_ADD_STALL_DEFAULT_MS = 120_000;
/** Against a git that loops while printing, not a delay a real checkout reaches. */
const WORKTREE_ADD_CEILING_MS = 6 * 60 * 60_000;

/** `TIMON_WORKTREE_ADD_STALL_MS`, resolved env > config > settings > default. */
function worktreeAddStallMs(): number {
  try {
    const value = settingNum('TIMON_WORKTREE_ADD_STALL_MS');
    if (Number.isFinite(value) && value > 0) return value;
  } catch { /* registry unreadable: the default */ }
  return WORKTREE_ADD_STALL_DEFAULT_MS;
}

type WorktreeError = Error & { stderr: string; stdout: string; code: number; timedOut?: boolean };

/** Shaped like an `execFileHost` failure: the dispatcher shows `stderr` as the task's reason. */
function worktreeError(reason: string, extra: { stdout?: string; code?: number; timedOut?: boolean } = {}): WorktreeError {
  const err = new Error(`git worktree add failed: ${reason}`) as WorktreeError;
  err.stderr = reason;
  err.stdout = extra.stdout ?? '';
  err.code = extra.code ?? 1;
  if (extra.timedOut) err.timedOut = true;
  return err;
}

/** Git's last words, its progress (`\r`-separated) included, without the hundreds of updates before them. */
function lastLines(output: string, count: number): string {
  return output.split(/[\r\n]+/).map((line) => line.trim()).filter(Boolean).slice(-count).join('\n');
}

/**
 * `git worktree add`, waited on for as long as it reports progress. Git prints
 * `Updating files: N% (x/y)` on its stderr, pipe included, on a checkout that
 * lasts: each new line pushes the deadline back. A fixed 30 s gave up on a
 * large repository behind an antivirus (TIM-0164) and only stopped git itself:
 * on Windows the checkout it had started went on alone, after the task was
 * blocked. Here a git silent for `stallMs` is stopped with every process it
 * started, and the half-made worktree goes with it.
 */
async function addWorktree(repoCwd: string, path: string, addArgs: string[], stallMs: number): Promise<void> {
  const existedBefore = existsSync(path);
  const r = await execTree('git', ['-C', repoCwd, ...addArgs], {
    timeout: WORKTREE_ADD_CEILING_MS,
    stallTimeout: stallMs,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (r.code === 0 && !r.timedOut) return;
  // A folder that was there before is not ours to remove: git refused it, nothing was written in it.
  if (!existedBefore) await discardHalfMadeWorktree(repoCwd, path);
  const said = lastLines(r.stderr, 4);
  if (r.timedOut) {
    throw worktreeError(
      `git reported no progress for ${Math.round(stallMs / 1000)} s and was stopped${said ? ` (last: ${said.split('\n').pop()})` : ''}. `
      + `The half-made worktree was removed and its branch kept. Raise TIMON_WORKTREE_ADD_STALL_MS for a repository this slow to check out, then move the task back to Pending.`,
      { stdout: r.stdout, code: r.code, timedOut: true },
    );
  }
  throw worktreeError(said || `git exited with code ${r.code}`, { stdout: r.stdout, code: r.code });
}

/**
 * Removes a worktree whose checkout did not finish, and KEEPS its branch.
 * `-f -f`: `git worktree add` locks the worktree ("initializing") until it is
 * done, and a stopped one leaves that lock, which a single `--force` respects.
 * The folder goes even when git could not take it, so that the next attempt
 * starts from nothing rather than reusing it.
 */
async function discardHalfMadeWorktree(repoCwd: string, path: string): Promise<void> {
  const inside = relative(WORKTREES_ROOT, path);
  if (!inside || isAbsolute(inside) || inside === '..' || inside.startsWith(`..${sep}`)) return;
  try {
    await exec('git', ['-C', repoCwd, 'worktree', 'remove', '--force', '--force', path], { timeout: 120_000 });
  } catch (error) {
    console.warn(`[worktree] git could not remove the half-made worktree ${path}: ${(error as Error).message}`);
    try { await exec('git', ['-C', repoCwd, 'worktree', 'unlock', path], { timeout: 10_000 }); } catch { /* not locked, or unknown */ }
  }
  try {
    // Retries: on Windows a process that was just stopped, or the antivirus, can still hold a file.
    rmSync(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
  } catch (error) {
    console.warn(`[worktree] could not delete the half-made worktree ${path}: ${(error as Error).message}`);
  }
  try { await exec('git', ['-C', repoCwd, 'worktree', 'prune'], { timeout: 30_000 }); } catch { /* the next prune will do */ }
}

/**
 * Whether an existing worktree folder can be handed to a task as it is.
 * `writing`: git holds the index lock (a checkout still running, or a git
 * that died holding it). `unfinished`: no index at all, the checkout never
 * completed. `unreadable`: `git status` fails or does not answer in time.
 */
async function checkoutState(path: string, stallMs: number): Promise<'complete' | 'writing' | 'unfinished' | 'unreadable'> {
  let gitDir: string;
  try {
    const r = await exec('git', ['-C', path, 'rev-parse', '--path-format=absolute', '--git-dir'], { timeout: 10_000 });
    gitDir = r.stdout.trim();
  } catch {
    return 'unreadable';
  }
  if (!gitDir) return 'unreadable';
  if (existsSync(join(gitDir, 'index.lock'))) return 'writing';
  if (!existsSync(join(gitDir, 'index'))) return 'unfinished';
  try {
    await exec('git', ['-C', path, 'status', '--porcelain', '--untracked-files=no'], { timeout: stallMs, maxBuffer: 64 * 1024 * 1024 });
  } catch {
    return 'unreadable';
  }
  return 'complete';
}

/**
 * Messages of the merge commits Timon creates or prescribes. Git's default
 * (`Merge branch 'timon/task/<uuid>' into …`) carries a task id: a public
 * repository's `commit-msg` hook refuses it, which leaves the merge unfinished,
 * and a merge that does land puts internal ids into the public history. Every
 * merge of a task chain therefore names its base only, in English.
 */
export function refreshMergeMessage(base: string): string {
  return `merge: bring ${base} into the task branch`;
}

export function integrateMergeMessage(base: string): string {
  return `merge: integrate the task branch into ${base}`;
}

/** What an attempt to bring a worktree up to date with its base gave. */
export type RefreshOutcome =
  /** The branch already contained the whole base — nothing moved. */
  | { status: 'up-to-date' }
  /** The base was integrated cleanly into the branch. */
  | { status: 'merged'; base: string }
  /** Conflicts: the merge is left AS IS in the worktree, for the agent to
   *  settle. It is not aborted — an agent coding on a stale base
   *  produces work that will overwrite the others' at the final merge. */
  | { status: 'conflict'; base: string; files: string[] }
  /** Operation impossible (worktree missing, unknown base, merge refused by git
   *  without a conflict). Not fatal: the caller carries on with the base as it is, and
   *  any half-done merge is aborted so the agent does not start inside it. */
  | { status: 'failed'; reason: string };

/**
 * Brings an existing worktree up to date with its base.
 *
 * WHY: a worktree is created at the FIRST spawn of its task and reused as
 * is afterwards (re-queue, iterations `[iter:2]`, `[iter:3]`). A task that
 * iterates for three hours therefore still codes on the `main` of three hours ago, and
 * its final merge reintroduces that old state — that is the mechanism of the
 * regressions observed on 2026-08-20.
 *
 * We MERGE the base into the branch rather than rebasing: a rebase rewrites
 * commits the reviewer may already have read and quoted by sha, and it
 * multiplies the conflict points (one per commit). The merge creates a single one,
 * and the history stays true.
 *
 * Conflicts are not an error: they are left in the worktree and
 * reported to the caller, which tells the agent. It is exactly the work
 * expected of it, and hiding it would be worse.
 */
export async function refreshWorktreeBase(
  worktreePath: string,
  base: string,
): Promise<RefreshOutcome> {
  if (!existsSync(worktreePath) || !(await isGitRepo(worktreePath))) {
    return { status: 'failed', reason: `worktree missing or invalid: ${worktreePath}` };
  }
  try {
    // Already up to date: the base is an ancestor of HEAD. A cheap test that avoids
    // creating an empty merge commit on every re-spawn.
    await exec('git', ['-C', worktreePath, 'merge-base', '--is-ancestor', base, 'HEAD'], {
      timeout: 10_000,
    });
    return { status: 'up-to-date' };
  } catch {
    /* not an ancestor → there is indeed something to integrate */
  }
  try {
    await exec(
      'git',
      ['-C', worktreePath, 'merge', '--no-edit', '-m', refreshMergeMessage(base), base],
      { timeout: 120_000 },
    );
    return { status: 'merged', base };
  } catch (err) {
    // A failing merge leaves the index in a conflicted state. The files
    // concerned are listed so that the agent knows where to look without fumbling.
    let files: string[] = [];
    try {
      const r = await exec(
        'git',
        ['-C', worktreePath, 'diff', '--name-only', '--diff-filter=U'],
        { timeout: 10_000 },
      );
      files = r.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
    } catch { /* list unavailable: the conflict is reported without detail */ }
    if (files.length === 0) {
      // No conflict, yet no merge commit: an untracked file the base would
      // overwrite, or a merge git stopped half-way. A pending merge
      // (MERGE_HEAD) would make the agent's first `git commit` that merge.
      // The repository's hooks never run here (`host/git-neutral.ts`).
      // Abort it so the task starts on its base as is, and say why.
      await abortPendingMerge(worktreePath);
      return { status: 'failed', reason: mergeFailureReason(err) };
    }
    return { status: 'conflict', base, files };
  }
}

/** The tail of git's output, where a hook or git itself says why it refused. */
function mergeFailureReason(err: unknown): string {
  const e = err as Error & { stderr?: string; stdout?: string };
  const detail = [e.stderr, e.stdout].map((t) => (t ?? '').trim()).filter(Boolean).join('\n');
  return (detail || e.message || 'git merge failed').slice(-600);
}

async function abortPendingMerge(worktreePath: string): Promise<void> {
  try {
    await exec('git', ['-C', worktreePath, 'rev-parse', '-q', '--verify', 'MERGE_HEAD'], { timeout: 10_000 });
  } catch {
    return; // no merge in progress
  }
  try {
    await exec('git', ['-C', worktreePath, 'merge', '--abort'], { timeout: 30_000 });
  } catch (err) {
    console.warn(`[worktree] could not abort the pending merge in ${worktreePath}: ${(err as Error).message}`);
  }
}

/** Absolute paths of the symbolic links git tracks in a worktree; empty when git cannot say. */
async function trackedLinks(worktreePath: string): Promise<Set<string>> {
  try {
    const { stdout } = await exec('git', ['-C', worktreePath, 'ls-files', '-s', '-z'], { timeout: 30_000, maxBuffer: 64 * 1024 * 1024 });
    const links = new Set<string>();
    for (const record of stdout.split('\0')) {
      const tab = record.indexOf('\t');
      if (tab > 0 && record.startsWith('120000 ')) links.add(join(resolve(worktreePath), ...record.slice(tab + 1).split('/')));
    }
    return links;
  } catch {
    // Unknown: every link goes, which at worst makes a removal without --force refuse.
    return new Set();
  }
}

/**
 * Removes the links a worktree shares with the main clone before git deletes
 * the folder: on Windows they are junctions, which the deletion has traversed,
 * emptying the main clone's `node_modules`. Throws when one stays, so the
 * folder is never deleted with it. A worktree kept after all (git refuses a
 * dirty one) gets its links back from the dispatcher, which re-links on reuse.
 */
async function unlinkBeforeRemoval(worktreePath: string): Promise<void> {
  if (!existsSync(worktreePath)) return;
  unlinkWorktreeLinks(worktreePath, await trackedLinks(worktreePath));
}

/**
 * Removes a task's worktree folder and KEEPS its branch: its commits stay, and
 * the next dispatch reattaches to it (`createWorktree`). Run from the worktree
 * itself, so it needs neither the agent's cwd nor the source repo (TIM-0113: a
 * task moved to an agent without a folder). No `--force`: git refuses a
 * worktree with uncommitted changes, which is work this gesture must not lose.
 *
 * The removal itself runs from the repository's common dir, never from inside
 * the folder: Windows locks a process's current directory, and a git that
 * stands in the folder it deletes fails with "Permission denied". `root` is
 * the folder its leftovers may be purged from (a pilot's worktree lives in
 * another one than the tasks').
 */
export async function releaseWorktreeFolder(path: string, root: string = WORKTREES_ROOT): Promise<void> {
  const r = await exec(
    'git',
    ['-C', path, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
    { timeout: 10_000 },
  );
  const commonDir = r.stdout.trim();
  await unlinkBeforeRemoval(path);
  await exec('git', ['-C', commonDir || path, 'worktree', 'remove', path], { timeout: 15_000 });
  purgeShell(root, path, 0, Date.now());
}

/**
 * Unmounts a worktree and deletes its local branch. Called by the merger
 * agent after a successful merge (or manually through `timon worktree dispose`
 * on abandon). The trace of the session stays in events + the possible
 * Codex rollouts — that is on purpose.
 *
 * `force = true` ignores the `worktree remove` errors (case of a dirty
 * or already partly deleted worktree), never a shared link that could not be
 * removed first: that one throws, and the folder and the branch both stay.
 */
export async function disposeWorktree(
  info: WorktreeInfo,
  force = false,
): Promise<void> {
  await unlinkBeforeRemoval(info.path);
  try {
    const args = ['-C', info.sourceRepo, 'worktree', 'remove'];
    if (force) args.push('--force');
    args.push(info.path);
    await exec('git', args, { timeout: 15_000 });
  } catch (err) {
    if (!force) {
      // Git refused (uncommitted work): the worktree stays, and may still be in use, so it gets its links back.
      await prepareWorktreeDependencies(info.sourceRepo, info.path);
      throw err;
    }
  }
  // Branch -D (forced, it was already merged if we get here).
  try {
    await exec('git', ['-C', info.sourceRepo, 'branch', '-D', info.branch], { timeout: 5_000 });
  } catch {
    /* branch already deleted or conflict — no big deal, the merge sha is in the DB */
  }
  // Every removal path goes through here, so the shell is purged at the
  // source. No grace: git has just let go of this folder. A failed remove
  // leaves its `.git`, which purgeShell refuses to touch.
  purgeShell(WORKTREES_ROOT, info.path, 0, Date.now());
}
