/**
 * Build caches of finished worktrees (`worktree-build-cache.ts`): only a real
 * folder git ignores goes, never what a link inside it points to, never in a
 * worktree a task still uses.
 */
import './test-home.js';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { db, dbApi } from './db.js';
import { agentConfig, agentDir } from './paths.js';
import { buildCacheCandidates, removeBuildCaches } from './worktree-build-cache.js';
import { createWorktree } from './worktree.js';
import { reconcileStaleWorktrees } from './worktree-gc.js';

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

function repoWithIgnore(): string {
  const repo = mkdtempSync(join(tmpdir(), 'timon-build-cache-'));
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 't@example.com');
  git(repo, 'config', 'user.name', 'T');
  writeFileSync(join(repo, '.gitignore'), '/.next/\n/app/.next/\n');
  git(repo, 'add', '.gitignore');
  git(repo, 'commit', '-q', '-m', 'one');
  return repo;
}

function cache(dir: string): void {
  mkdirSync(join(dir, 'cache'), { recursive: true });
  writeFileSync(join(dir, 'cache', 'blob'), 'x'.repeat(1000));
}

test('ignored caches go, a cache git does not ignore stays, and a link inside is removed without its target', async () => {
  const repo = repoWithIgnore();
  cache(join(repo, '.next'));
  cache(join(repo, 'app', '.next'));
  cache(join(repo, 'lib', '.next'));
  const outside = mkdtempSync(join(tmpdir(), 'timon-build-cache-target-'));
  writeFileSync(join(outside, 'precious'), 'keep me');
  symlinkSync(outside, join(repo, 'app', '.next', 'linked'), 'junction');

  assert.equal(buildCacheCandidates(repo).length, 3);
  const removed = await removeBuildCaches(repo, () => true);
  assert.deepEqual(removed.sort(), [join(repo, '.next'), join(repo, 'app', '.next')].sort());
  assert.equal(existsSync(join(repo, 'app', '.next')), false);
  assert.ok(existsSync(join(repo, 'lib', '.next', 'cache', 'blob')), 'not ignored: kept');
  assert.ok(existsSync(join(outside, 'precious')), 'the link target is untouched');
});

test('a .next that is itself a link is never followed nor removed', async () => {
  const repo = repoWithIgnore();
  const outside = mkdtempSync(join(tmpdir(), 'timon-build-cache-link-'));
  cache(outside);
  symlinkSync(outside, join(repo, '.next'), 'junction');
  assert.deepEqual(await removeBuildCaches(repo, () => true), []);
  assert.ok(existsSync(join(outside, 'cache', 'blob')));
});

test('nothing goes once the worktree is no longer owned only by finished tasks', async () => {
  const repo = repoWithIgnore();
  cache(join(repo, 'app', '.next'));
  assert.deepEqual(await removeBuildCaches(repo, () => false), []);
  assert.ok(existsSync(join(repo, 'app', '.next', 'cache', 'blob')));
});

test('the GC empties the cache of a finished worktree it keeps, never of a running task', async () => {
  const repo = repoWithIgnore();
  const agent = `build-cache-${randomUUID().slice(0, 8)}`;
  mkdirSync(agentDir(agent), { recursive: true });
  writeFileSync(agentConfig(agent), JSON.stringify({ cwd: repo }));
  git(repo, 'branch', 'feat/not-landed', 'main');
  dbApi.recordIntegration({ repo, branch: 'feat/not-landed', remote: 'origin', target: 'main', mode: 'pr' });

  const make = async (status: 'DONE' | 'IN_PROGRESS'): Promise<string> => {
    const id = randomUUID();
    dbApi.createTask(id, 'feature', agent, { type: 'code', baseBranch: 'feat/not-landed', integrationMode: 'pr', baseRef: 'origin/main' });
    const info = await createWorktree(id, repo, 'feat/not-landed');
    dbApi.setTaskWorktree(id, info.path, info.branch, info.base);
    cache(join(info.path, 'app', '.next'));
    db.prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?').run(status, Date.now() - 24 * 3600_000, id);
    return info.path;
  };
  const done = await make('DONE');
  const running = await make('IN_PROGRESS');

  await reconcileStaleWorktrees();
  assert.ok(existsSync(done), 'the worktree itself is kept: its job has not landed');
  assert.equal(existsSync(join(done, 'app', '.next')), false, 'its build cache is gone');
  assert.ok(existsSync(join(running, 'app', '.next', 'cache', 'blob')), 'a running task keeps its cache');
});
