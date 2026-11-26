/**
 * TODO #1204 — every path that deletes a task worktree (the GC, `timon worktree
 * dispose`, a merger's cleanup) goes through `removeWorktreeGuarded`: the
 * worktree's real HEAD in a holder, `git status --porcelain` empty, no
 * `--force`, the task read again and the folder detached from it in one
 * transaction. On 2026-09-20 a cleanup destroyed a live task's worktree.
 */
import './test-home.js';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { db, dbApi } from './db.js';
import { agentConfig, agentDir } from './paths.js';
import { WORKTREES_ROOT, createWorktree, removeWorktreeGuarded } from './worktree.js';
import { reconcileStaleWorktrees } from './worktree-gc.js';
import { WorktreeServiceError, disposeTaskWorktree } from './worktree-service.js';
import { forceRemoveTestWorktree } from './worktree-fixture.js';

const repo = join(process.env.TIMON_HOME!, `repo-${randomUUID()}`);
mkdirSync(repo, { recursive: true });
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
git(repo, 'init', '-q', '-b', 'main');
git(repo, 'config', 'user.email', 't@example.com');
git(repo, 'config', 'user.name', 'T');
writeFileSync(join(repo, 'a'), '1');
git(repo, 'add', 'a');
git(repo, 'commit', '-q', '-m', 'one');

const agent = `removal-guard-${randomUUID().slice(0, 8)}`;
mkdirSync(agentDir(agent), { recursive: true });
writeFileSync(agentConfig(agent), JSON.stringify({ cwd: repo }));

const LONG_AGO = Date.now() - 24 * 3600_000;

const branchExists = (branch: string): boolean => {
  try { git(repo, 'rev-parse', '--verify', '--quiet', branch); return true; } catch { return false; }
};

/** A code task with one commit merged into `main`, closed DONE with its merge sha long ago. */
async function mergedTask(): Promise<{ id: string; branch: string; path: string; tip: string }> {
  const id = randomUUID();
  dbApi.createTask(id, 'feature', agent, { type: 'code' });
  const info = await createWorktree(id, repo, 'main');
  dbApi.setTaskWorktree(id, info.path, info.branch, info.base);
  writeFileSync(join(info.path, `f-${id}`), '2');
  git(info.path, 'add', '.');
  git(info.path, 'commit', '-q', '-m', 'work');
  const tip = git(repo, 'rev-parse', info.branch);
  git(repo, 'merge', '-q', '--ff-only', info.branch);
  db.prepare(`UPDATE tasks SET status = 'DONE', merged_commit_sha = ?, updated_at = ? WHERE id = ?`).run(tip, LONG_AGO, id);
  return { id, branch: info.branch, path: info.path, tip };
}

function assertKept(t: { id: string; branch: string; path: string }): void {
  assert.ok(existsSync(join(t.path, '.git')), 'worktree kept');
  assert.ok(branchExists(t.branch), 'branch kept');
  assert.equal(dbApi.getTask(t.id)?.worktree_path, t.path, 'the task still records its folder');
}

test('the GC keeps a merged task whose worktree holds an uncommitted change', async () => {
  const t = await mergedTask();
  writeFileSync(join(t.path, 'a'), 'edited, never committed');
  await reconcileStaleWorktrees();
  assertKept(t);
  await forceRemoveTestWorktree({ taskId: t.id, path: t.path, branch: t.branch, base: 'main', sourceRepo: repo });
});

test('the GC keeps a merged task whose worktree holds an untracked file', async () => {
  const t = await mergedTask();
  writeFileSync(join(t.path, 'notes.md'), 'never added');
  await reconcileStaleWorktrees();
  assertKept(t);
  await forceRemoveTestWorktree({ taskId: t.id, path: t.path, branch: t.branch, base: 'main', sourceRepo: repo });
});

test('the GC reads the real HEAD: a commit made after the recorded merge sha keeps everything', async () => {
  const t = await mergedTask();
  writeFileSync(join(t.path, `late-${t.id}`), '3');
  git(t.path, 'add', '.');
  git(t.path, 'commit', '-q', '-m', 'late work');
  await reconcileStaleWorktrees();
  assertKept(t);
  await forceRemoveTestWorktree({ taskId: t.id, path: t.path, branch: t.branch, base: 'main', sourceRepo: repo });
});

test('the GC disposes of a clean, merged DONE task, and the task forgets its folder and branch', async () => {
  const t = await mergedTask();
  await reconcileStaleWorktrees();
  assert.equal(existsSync(t.path), false);
  assert.equal(branchExists(t.branch), false);
  const row = db.prepare('SELECT worktree_path, branch_name FROM tasks WHERE id = ?').get(t.id);
  assert.deepEqual(row, { worktree_path: null, branch_name: null });
});

test('a chain sharing one folder: a task that is not DONE keeps it for all of them', async () => {
  const t = await mergedTask();
  const review = randomUUID();
  dbApi.createTask(review, 'review', agent, { type: 'review' });
  dbApi.setTaskWorktree(review, t.path, t.branch, 'main');
  db.prepare(`UPDATE tasks SET status = 'IN_PROGRESS', updated_at = ? WHERE id = ?`).run(LONG_AGO, review);
  await reconcileStaleWorktrees();
  assertKept(t);
  assert.equal(dbApi.getTask(review)?.worktree_path, t.path);
  db.prepare(`UPDATE tasks SET status = 'DONE' WHERE id = ?`).run(review);
  await reconcileStaleWorktrees();
  assert.equal(existsSync(t.path), false, 'disposed once every task naming it is DONE');
  assert.equal(dbApi.getTask(review)?.worktree_path, null);
});

test('an orphan folder whose HEAD is not merged is kept, whatever its branch', async () => {
  const id = randomUUID();
  const info = await createWorktree(id, repo, 'main', `timon/merge/${id}`);
  writeFileSync(join(info.path, `m-${id}`), 'merge in progress');
  git(info.path, 'add', '.');
  git(info.path, 'commit', '-q', '-m', 'merge work');
  // Old enough for the GC to look at it.
  const old = new Date(LONG_AGO);
  utimesSync(info.path, old, old);
  await reconcileStaleWorktrees();
  assert.ok(existsSync(join(info.path, '.git')), 'orphan kept');
  assert.ok(branchExists(info.branch));
  await forceRemoveTestWorktree(info);
});

test('timon worktree dispose refuses a task that is not DONE, and a DONE one whose worktree is dirty', async () => {
  const t = await mergedTask();
  db.prepare(`UPDATE tasks SET status = 'IN_PROGRESS' WHERE id = ?`).run(t.id);
  await assert.rejects(disposeTaskWorktree(dbApi.getTask(t.id)!), (err: unknown) => err instanceof WorktreeServiceError && err.code === 'busy');
  assertKept(t);

  db.prepare(`UPDATE tasks SET status = 'DONE' WHERE id = ?`).run(t.id);
  writeFileSync(join(t.path, 'a'), 'dirty');
  // `force` no longer forces anything.
  await assert.rejects(disposeTaskWorktree(dbApi.getTask(t.id)!), /never committed/);
  assertKept(t);

  git(t.path, 'checkout', '--', 'a');
  assert.deepEqual(await disposeTaskWorktree(dbApi.getTask(t.id)!), { disposed: true });
  assert.equal(existsSync(t.path), false);
  assert.equal(branchExists(t.branch), false);
});

test('a task reopened between the claim and the removal keeps its folder, and gets it back', async () => {
  const t = await mergedTask();
  let restored = false;
  const result = await removeWorktreeGuarded({
    path: t.path,
    sourceRepo: repo,
    holders: [t.tip],
    branch: t.branch,
    claim: () => () => { restored = true; },
    stillClaimed: () => false,
  });
  assert.equal(result.ok, false);
  assert.equal(restored, true, 'the claim was undone');
  assert.ok(existsSync(join(t.path, '.git')));
  assert.ok(branchExists(t.branch));
  await forceRemoveTestWorktree({ taskId: t.id, path: t.path, branch: t.branch, base: 'main', sourceRepo: repo });
});

test('the transactional detach refuses while another task on the folder is not DONE', () => {
  const path = join(WORKTREES_ROOT, `shared-${randomUUID()}`);
  const done = randomUUID();
  const open = randomUUID();
  dbApi.createTask(done, 'done', agent, { type: 'code' });
  dbApi.createTask(open, 'open', agent, { type: 'review' });
  dbApi.setTaskWorktree(done, path, 'timon/task/x', 'main');
  dbApi.setTaskWorktree(open, path, 'timon/task/x', 'main');
  db.prepare(`UPDATE tasks SET status = 'DONE' WHERE id = ?`).run(done);
  assert.equal(dbApi.detachDoneTaskWorktree(done, path), null);
  db.prepare(`UPDATE tasks SET status = 'DONE' WHERE id = ?`).run(open);
  const ids = dbApi.detachDoneTaskWorktree(done, path);
  assert.deepEqual(new Set(ids), new Set([done, open]));
  assert.equal(dbApi.getTask(open)?.worktree_path, null);
  dbApi.restoreTaskWorktree(ids!, path);
  assert.equal(dbApi.getTask(open)?.worktree_path, path);
});
