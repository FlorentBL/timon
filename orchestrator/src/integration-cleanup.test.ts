/**
 * What a concluded job leaves behind (`docs/KANBAN-PR-PIPELINE.md` §2.7): once
 * its integration lands, its tasks' worktrees, its pilot's worktree, its
 * branch and (when asked) its remote copy go, once; nothing goes while a task
 * of the job is open or its pilot runs, nor what did not land. The scenarios
 * of the security review live in `integration-cleanup-guards.test.ts`.
 */
import './test-home.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { db, dbApi } from './db.js';
import { deleteRemoteBranch } from './host/forge.js';
import { cleanConcludedIntegrations, cleanIntegration } from './integration-cleanup.js';
import {
  commit, deps, git, has, land, mergeOnForge, plainGit, prJob, PUSH_URL, remoteHas, root, seen,
} from './integration-cleanup-fixture.js';
import { updateProjectIntegration } from './project-integration.js';
import { invalidateSettingsCache } from './settings.js';

after(() => rmSync(root, { recursive: true, force: true }));

test('the cleanup is off until it is turned on', async () => {
  const job = await prJob();
  mergeOnForge(job);
  land(job);
  dbApi.finishMission(job.series, 'completed', 0);
  delete process.env.TIMON_INTEGRATION_CLEANUP_ENABLED;
  invalidateSettingsCache();
  const out = await cleanConcludedIntegrations(deps(job));
  assert.equal(out.size, 0, 'no row is even looked at');
  assert.equal(existsSync(job.task.path), true);
  assert.equal(existsSync(job.pilot), true);
  assert.equal(has(job.repo, `refs/heads/${job.branch}`), true);
  assert.equal(remoteHas(job, job.branch), true);
  assert.equal(dbApi.getIntegrationById(job.row.id)?.cleaned_at ?? null, null);
  // Every other test runs with it on.
  process.env.TIMON_INTEGRATION_CLEANUP_ENABLED = '1';
  invalidateSettingsCache();
  assert.equal((await cleanConcludedIntegrations(deps(job))).get(job.row.id), 'cleaned');
});

test('a merged job loses its task and pilot worktrees, its branch and its remote copy, once', async () => {
  const job = await prJob();
  mergeOnForge(job);
  land(job);
  dbApi.finishMission(job.series, 'completed', 0);

  const out = await cleanConcludedIntegrations(deps(job));
  assert.equal(out.get(job.row.id), 'cleaned');
  assert.equal(existsSync(job.task.path), false, 'the task worktree is gone');
  assert.equal(dbApi.getTask(job.task.id)?.worktree_path, null);
  assert.equal(has(job.repo, `refs/heads/${job.task.branch}`), false, 'the task branch is gone');
  assert.equal(existsSync(job.pilot), false, 'the pilot worktree is gone');
  assert.equal(has(job.repo, `refs/heads/${job.branch}`), false, 'the integration branch is gone');
  assert.equal(remoteHas(job, job.branch), false, 'its remote copy is gone');
  assert.deepEqual(seen.deletions, [{ url: PUSH_URL, branch: job.branch, sha: job.head }], 'leased on the merged head');
  assert.equal(seen.logins, 1, 'the account is checked before the deletion');
  assert.ok(dbApi.getIntegrationById(job.row.id)?.cleaned_at);
  assert.equal(has(job.repo, 'refs/heads/main'), true, 'the target is untouched');

  // A second pass finds nothing to do.
  const again = await cleanConcludedIntegrations(deps(job));
  assert.equal(again.has(job.row.id), false);
  assert.equal(seen.logins, 0);
});

test('nothing goes while a task of the job is open or its pilot runs', async () => {
  const job = await prJob();
  mergeOnForge(job);
  const row = land(job);
  // The doc task the landing created, still to run.
  const doc = randomUUID();
  dbApi.createTask(doc, 'doc', job.agent, { type: 'doc', project: job.slug, baseBranch: job.branch, integrationMode: 'pr' });

  assert.equal(await cleanIntegration(row, deps(job)), 'waiting');
  assert.equal(existsSync(job.task.path), true);
  assert.equal(existsSync(job.pilot), true);
  assert.equal(has(job.repo, `refs/heads/${job.branch}`), true);
  assert.equal(remoteHas(job, job.branch), true);

  db.prepare(`UPDATE tasks SET status = 'DONE' WHERE id = ?`).run(doc);
  // The pilot's mission still runs: its worktree may be its current folder.
  assert.equal(await cleanIntegration(row, deps(job)), 'waiting');
  assert.equal(existsSync(job.pilot), true);
  assert.equal(dbApi.getIntegrationById(job.row.id)?.cleaned_at ?? null, null);

  dbApi.finishMission(job.series, 'completed', 0);
  assert.equal(await cleanIntegration(row, deps(job)), 'cleaned');
  assert.equal(has(job.repo, `refs/heads/${job.branch}`), false);
});

test('what did not land is kept: a branch moved since the merge, a remote pushed to, a dirty pilot worktree', async () => {
  const job = await prJob();
  mergeOnForge(job);
  const row = land(job);
  dbApi.finishMission(job.series, 'completed', 0);
  // A commit on the branch after the merge, pushed: neither copy is in main.
  const n = job.branch.slice('feat/job-'.length);
  const extra = join(root, `extra-${n}`);
  git(job.repo, 'worktree', 'add', '-q', '--detach', '--', extra, `refs/heads/${job.branch}`);
  commit(extra, 'late.txt', 'fix: late change');
  git(extra, 'push', '-q', '.', `HEAD:refs/heads/${job.branch}`);
  git(job.repo, 'push', '-q', job.remote, `refs/heads/${job.branch}:refs/heads/${job.branch}`);
  git(job.repo, 'worktree', 'remove', extra);
  // And a change the pilot never committed.
  writeFileSync(join(job.pilot, `p-${n}.txt`), 'edited\n');

  assert.equal(await cleanIntegration(row, deps(job)), 'cleaned');
  assert.equal(existsSync(job.task.path), false, 'the task worktree, whose work is in the branch, goes');
  assert.equal(has(job.repo, `refs/heads/${job.branch}`), true, 'the branch holds work main does not');
  assert.equal(remoteHas(job, job.branch), true, 'the remote copy moved since: never deleted');
  assert.equal(seen.deletions.length, 0);
  assert.equal(existsSync(join(job.pilot, '.git')), true, 'git refuses a worktree with uncommitted changes');
});

test('the remote copy stays unless the project asks, and the forge may have deleted it already', async () => {
  const kept = await prJob();
  updateProjectIntegration(kept.slug, { delete_remote_branch: false });
  mergeOnForge(kept);
  dbApi.finishMission(kept.series, 'completed', 0);
  assert.equal(await cleanIntegration(land(kept), deps(kept)), 'cleaned');
  assert.equal(has(kept.repo, `refs/heads/${kept.branch}`), false);
  assert.equal(remoteHas(kept, kept.branch), true);
  assert.equal(seen.logins, 0, 'the forge is not even asked');

  const gone = await prJob();
  mergeOnForge(gone);
  dbApi.finishMission(gone.series, 'completed', 0);
  git(gone.forgeSide, 'push', '-q', 'origin', `:refs/heads/${gone.branch}`);
  assert.equal(await cleanIntegration(land(gone), deps(gone)), 'cleaned');
  assert.equal(seen.deletions.length, 0);
});

test('a wrong account waits, and deletes nothing', async () => {
  const job = await prJob();
  mergeOnForge(job);
  dbApi.finishMission(job.series, 'completed', 0);
  const row = land(job);
  const out = await cleanIntegration(row, deps(job, { forge: () => ({
    login: async () => ({ ok: true, login: 'someone-else' }),
    branchStanding: async () => { throw new Error('never asked'); },
  }) }));
  assert.equal(out, 'waiting');
  assert.equal(remoteHas(job, job.branch), true);
  assert.equal(dbApi.getIntegrationById(job.row.id)?.cleaned_at ?? null, null);
});

test('a pull request closed without a merge gives back its pilot worktree only', async () => {
  const job = await prJob();
  dbApi.finishMission(job.series, 'completed', 0);
  assert.ok(dbApi.markIntegrationClosed(job.row.id));
  const out = await cleanConcludedIntegrations(deps(job));
  assert.equal(out.get(job.row.id), 'cleaned');
  assert.equal(existsSync(job.pilot), false, 'its commits are in the branch');
  assert.equal(has(job.repo, `refs/heads/${job.branch}`), true, 'the branch did not land: it stays');
  assert.equal(existsSync(job.task.path), true, 'the task worktree is the worktree GC\'s, which waits for a landing');
  assert.equal(remoteHas(job, job.branch), true);
});

test('a job that merges locally loses its branch once the local target holds it', async () => {
  const job = await prJob({ local: true });
  dbApi.finishMission(job.series, 'completed', 0);
  // Not merged yet: the grace and the state hold it.
  assert.equal((await cleanConcludedIntegrations(deps(job))).has(job.row.id), false);
  git(job.repo, 'merge', '-q', '--no-ff', '-m', 'merge: land the job', job.branch);
  const row = land(job, git(job.repo, 'rev-parse', 'main'));
  assert.equal(await cleanIntegration(row, deps(job)), 'cleaned');
  assert.equal(has(job.repo, `refs/heads/${job.branch}`), false);
  assert.equal(existsSync(job.pilot), false);
  assert.equal(seen.logins, 0, 'no forge for a local job');
});

test('the grace keeps a job that just landed, and a branch checked out somewhere waits', async () => {
  const job = await prJob();
  mergeOnForge(job);
  land(job);
  dbApi.finishMission(job.series, 'completed', 0);
  const early = await cleanConcludedIntegrations(deps(job, { graceMs: 3600_000 }));
  assert.equal(early.get(job.row.id), 'waiting');
  assert.equal(existsSync(job.pilot), true);

  git(job.repo, 'checkout', '-q', job.branch);
  assert.equal((await cleanConcludedIntegrations(deps(job))).get(job.row.id), 'waiting');
  assert.equal(has(job.repo, `refs/heads/${job.branch}`), true, 'the user works on it');
  git(job.repo, 'checkout', '-q', 'main');
  assert.equal((await cleanConcludedIntegrations(deps(job))).get(job.row.id), 'cleaned');
  assert.equal(has(job.repo, `refs/heads/${job.branch}`), false);
});

test('the remote deletion is leased on the commit that landed', async () => {
  const job = await prJob();
  const moved = commit(job.pilot, 'more.txt', 'feat: more');
  git(job.repo, 'push', '-q', job.remote, `${moved}:refs/heads/${job.branch}`);
  const refused = await deleteRemoteBranch(job.repo, job.remote, job.branch, job.head, { git: plainGit });
  assert.equal(refused.ok, false);
  assert.equal(remoteHas(job, job.branch), true);
  const done = await deleteRemoteBranch(job.repo, job.remote, job.branch, moved, { git: plainGit });
  assert.ok(done.ok, JSON.stringify(done));
  assert.equal(remoteHas(job, job.branch), false);
  for (const bad of ['-x', 'a..b', 'a b']) {
    const out = await deleteRemoteBranch(job.repo, job.remote, bad, moved, { git: plainGit });
    assert.equal(out.ok, false, bad);
  }
});
