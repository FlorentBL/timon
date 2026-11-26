/**
 * Test cleanup of a worktree a test made dirty or never merged. The product
 * never forces a removal (`removeWorktreeGuarded`); a test that is done with
 * its scratch repository does, after removing the shared links first so a
 * Windows junction is never traversed.
 */
import { execFileHost } from './host/index.js';
import type { WorktreeInfo } from './worktree.js';
import { unlinkWorktreeLinks } from './worktree-shell.js';

export async function forceRemoveTestWorktree(info: WorktreeInfo): Promise<void> {
  unlinkWorktreeLinks(info.path);
  try {
    await execFileHost('git', ['-C', info.sourceRepo, 'worktree', 'remove', '--force', '--force', info.path], { timeout: 15_000 });
  } catch { /* already gone */ }
  try {
    await execFileHost('git', ['-C', info.sourceRepo, 'branch', '-D', info.branch], { timeout: 5_000 });
  } catch { /* already gone */ }
}
