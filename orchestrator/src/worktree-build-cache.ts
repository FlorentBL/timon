/**
 * Build caches left in the worktree of a finished task.
 *
 * A worktree the GC must keep (its job has not landed, or it holds unmerged
 * work) still carries what a build wrote in it: a Next.js `.next` weighs
 * 560 to 700 MB, a hundred times its source, and none of it is work. On
 * 2026-11-25 these caches helped fill the disk.
 *
 * Only a folder git ignores goes (never tracked or untracked work), only a
 * real folder (never a link, whose target is someone else's), and the links
 * inside it are removed first, without following them: on Windows a
 * recursive delete has traversed a junction and emptied its target.
 *
 * Kept free of `db.js` imports: the caller decides whose worktree it is.
 */
import { lstatSync, readdirSync, rmSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { getHost } from './host/index.js';
import { unlinkWorktreeLinks } from './worktree-shell.js';

/** Folder names of rebuildable build output, looked for at the root and one level down. */
export const BUILD_CACHE_NAMES: readonly string[] = ['.next'];

function isRealDirectory(path: string): boolean {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  return Boolean(stat?.isDirectory() && !stat.isSymbolicLink());
}

/** Candidate cache folders of `worktree`: `<name>` and `<child>/<name>`, real folders only. */
export function buildCacheCandidates(worktree: string, names: readonly string[] = BUILD_CACHE_NAMES): string[] {
  const out: string[] = [];
  for (const name of names) {
    const top = join(worktree, name);
    if (isRealDirectory(top)) out.push(top);
  }
  let children: string[];
  try {
    children = readdirSync(worktree, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name !== '.git' && e.name !== 'node_modules')
      .map((e) => e.name);
  } catch {
    return out;
  }
  for (const child of children) {
    for (const name of names) {
      const nested = join(worktree, child, name);
      if (isRealDirectory(nested)) out.push(nested);
    }
  }
  return out;
}

/** True only when git answers that `path` is ignored in `worktree`; any doubt keeps it. */
async function ignoredByGit(worktree: string, path: string): Promise<boolean> {
  const rel = relative(worktree, path).split(sep).join('/');
  try {
    const r = await getHost().execAsync('git', ['-C', worktree, 'check-ignore', '-q', '--', `${rel}/`], {
      timeout: 15_000, windowsHide: true,
    });
    return r.code === 0 && !r.timedOut;
  } catch {
    return false;
  }
}

/**
 * Removes the ignored build caches of `worktree`. `stillOwned` is asked right
 * before each removal: false (a task reopened on the worktree) stops at once.
 * Returns the folders removed.
 */
export async function removeBuildCaches(
  worktree: string,
  stillOwned: () => boolean,
  names: readonly string[] = BUILD_CACHE_NAMES,
): Promise<string[]> {
  const removed: string[] = [];
  for (const dir of buildCacheCandidates(worktree, names)) {
    if (!(await ignoredByGit(worktree, dir))) continue;
    if (!stillOwned()) break;
    try {
      unlinkWorktreeLinks(dir);
      rmSync(dir, { recursive: true, force: true });
      removed.push(dir);
    } catch (err) {
      console.warn(`[worktree-gc] build cache ${dir} kept: ${(err as Error).message}`);
    }
  }
  return removed;
}
