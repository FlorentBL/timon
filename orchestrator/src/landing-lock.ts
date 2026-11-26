/**
 * One lock per integration branch name, inside the daemon.
 *
 * The cleanup after a landing (`integration-cleanup.ts`) reads that every task
 * based on a branch is DONE, then deletes the branch: git takes seconds in
 * between. A task reopened in that gap (`PUT /api/tasks/:id`, which the CLI,
 * the MCP `kanban_update` and the board all use) would find its base gone. Both
 * sides take this lock, so a reopening waits for the deletion to finish, or
 * the cleanup reads the task reopened and keeps the branch.
 *
 * Keyed on the branch name alone, whatever the repository: two projects that
 * name a branch alike only wait for each other, which costs nothing.
 */

const tails = new Map<string, Promise<void>>();

/** Runs `fn` alone for `branch`: every other holder of the same name waits. */
export async function withLandingBranchLock<T>(branch: string, fn: () => Promise<T> | T): Promise<T> {
  const before = tails.get(branch) ?? Promise.resolve();
  let release: () => void = () => undefined;
  const mine = new Promise<void>((resolve) => { release = resolve; });
  const tail = before.then(() => mine);
  tails.set(branch, tail);
  await before;
  try {
    return await fn();
  } finally {
    release();
    // The last holder leaves nothing behind.
    if (tails.get(branch) === tail) tails.delete(branch);
  }
}

/** True while a holder runs or waits for `branch` (tests). */
export function landingBranchLocked(branch: string): boolean {
  return tails.has(branch);
}
