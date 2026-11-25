/**
 * The cleanup after a landing keeps everything in doubt: one test per
 * scenario of its security review (uncommitted work, a HEAD moved since the
 * merge, another series, a task reopened mid-pass, a squash, a checked-out
 * branch, a mirror, the branches never deleted, concurrent passes).
 */
import './test-home.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { db, dbApi } from './db.js';
import { cleanConcludedIntegrations, cleanIntegration } from './integration-cleanup.js';
import { resolveWorktree } from './dispatcher.js';
import {
  commit, deleteOnForge, deps, git, has, land, landedJob, LONG_AGO, mergeOnForge, prJob, remoteHas, root, seen, taskKept,
  type Job,
} from './integration-cleanup-fixture.js';
import { updateProjectIntegration } from './project-integration.js';
import { createWorktree } from './worktree.js';

/** What a pass that waited must have left: the pilot's worktree, the branch, its remote copy. */
function restKept(job: Job): void {
  assert.equal(existsSync(join(job.pilot, '.git')), true, 'the pilot worktree stays');
  assert.equal(has(job.repo, `refs/heads/${job.branch}`), true, 'the job\'s branch stays');
  assert.equal(remoteHas(job, job.branch), true, 'its remote copy stays');
  assert.equal(seen.deletions.length, 0, 'no remote deletion');
}

/** A git commit on `ref` that no other ref holds, made without a working tree. */
function danglingCommit(repo: string, ref: string, message: string): string {
  return git(repo, 'commit-tree', `${ref}^{tree}`, '-p', ref, '-m', message);
}

after(() => rmSync(root, { recursive: true, force: true }));
process.env.TIMON_INTEGRATION_CLEANUP_ENABLED = '1';

test('a DONE task whose worktree holds uncommitted changes keeps its worktree, its link and its branch', async () => {
  const { job, row } = await landedJob();
  writeFileSync(join(job.task.path, 'draft.txt'), 'never committed\n');
  assert.equal(await cleanIntegration(row, deps(job)), 'cleaned');
  taskKept(job);
  assert.equal(existsSync(join(job.task.path, 'draft.txt')), true);
});

test('a task worktree whose HEAD moved past its recorded merge is kept', async () => {
  const { job, row } = await landedJob();
  // Committed, so the worktree is clean, but in no branch the target holds.
  commit(job.task.path, 'after.txt', 'feat: after the merge');
  assert.notEqual(git(job.task.path, 'rev-parse', 'HEAD'), dbApi.getTask(job.task.id)?.merged_commit_sha);
  assert.equal(await cleanIntegration(row, deps(job)), 'cleaned');
  taskKept(job);
});

test('a task of another series posed on the same base is never touched', async () => {
  const job = await prJob();
  const other = randomUUID();
  const otherSeries = `series-${randomUUID()}`;
  dbApi.createMission(otherSeries, job.agent, 'another job');
  dbApi.finishMission(otherSeries, 'completed', 0);
  dbApi.createTask(other, 'feature', job.agent, {
    type: 'code', project: job.slug, baseBranch: job.branch, integrationMode: 'pr', baseRef: 'origin/main',
    seriesId: otherSeries, creatorMissionId: otherSeries,
  });
  const info = await createWorktree(other, job.repo, job.branch);
  dbApi.setTaskWorktree(other, info.path, info.branch, info.base);
  db.prepare(`UPDATE tasks SET status = 'DONE', merged_commit_sha = ?, updated_at = ? WHERE id = ?`)
    .run(git(info.path, 'rev-parse', 'HEAD'), LONG_AGO, other);
  mergeOnForge(job);
  const row = land(job);
  dbApi.finishMission(job.series, 'completed', 0);
  assert.equal(await cleanIntegration(row, deps(job)), 'cleaned');
  assert.equal(existsSync(job.task.path), false, 'the job\'s own task worktree goes');
  assert.equal(existsSync(join(info.path, '.git')), true, 'the other series\' worktree stays');
  assert.equal(dbApi.getTask(other)?.worktree_path, info.path);
  assert.equal(has(job.repo, `refs/heads/${info.branch}`), true);
});

const reopen = (id: string): void => { db.prepare(`UPDATE tasks SET status = 'PENDING' WHERE id = ?`).run(id); };

test('a task reopened during the pass is spared, and the pass stops there', async () => {
  const { job, row } = await landedJob();
  const out = await cleanIntegration(row, deps(job, {
    beforeDeletion: (what) => { if (what === `worktree:${job.task.id}`) reopen(job.task.id); },
  }));
  assert.equal(out, 'waiting');
  taskKept(job);
  restKept(job);
  assert.equal(dbApi.getIntegrationById(job.row.id)?.cleaned_at ?? null, null);
  assert.equal(dbApi.getIntegrationById(job.row.id)?.cleanup_token ?? null, null, 'the reservation is handed back');
});

test('a task reopened and dispatched between its detachment and its removal keeps its worktree', async () => {
  const { job, row } = await landedJob();
  // Read before the pass: the dispatcher may hold a row that still names the folder.
  const stale = dbApi.getTask(job.task.id)!;
  const dispatched: Array<Promise<unknown>> = [];
  const out = await cleanIntegration(row, deps(job, {
    beforeDeletion: (what) => {
      if (what !== `remove:${job.task.id}`) return;
      assert.equal(dbApi.getTask(job.task.id)?.worktree_path, null, 'detached at this point');
      reopen(job.task.id);
      dispatched.push(resolveWorktree(stale), resolveWorktree(dbApi.getTask(job.task.id)!));
    },
  }));
  assert.equal(out, 'waiting');
  const infos = await Promise.all(dispatched) as Array<{ path: string } | null>;
  for (const info of infos) assert.equal(info?.path, job.task.path, 'the dispatcher gets the very folder, kept');
  taskKept(job);
  assert.equal(existsSync(join(job.task.path, `t-${job.branch.slice('feat/job-'.length)}.txt`)), true, 'its files are there');
  restKept(job);
});

test('a dispatch during the removal waits for it, and its fresh worktree survives the pass', async () => {
  const { job, row } = await landedJob();
  let dispatch: Promise<{ path: string } | null> | null = null;
  const out = await cleanIntegration(row, deps(job, {
    beforeDeletion: async (what) => {
      // The task, still DONE, is detached: the dispatcher makes a folder again.
      if (what === `remove:${job.task.id}`) dispatch = resolveWorktree(dbApi.getTask(job.task.id)!);
      // Before the job's branch goes, which the new folder starts from.
      if (what === `ref:${job.branch}`) await dispatch;
    },
  }));
  assert.equal(out, 'cleaned');
  const info = await dispatch!;
  assert.equal(info?.path, job.task.path);
  assert.equal(existsSync(join(job.task.path, '.git')), true, 'the fresh worktree is not removed');
  assert.equal(dbApi.getTask(job.task.id)?.worktree_path, job.task.path);
  assert.equal(has(job.repo, `refs/heads/${job.task.branch}`), true, 'its branch, made again, stays');
});

test('a commit made in a worktree between its proof and its removal keeps it', async () => {
  const { job, row } = await landedJob();
  let late = '';
  const out = await cleanIntegration(row, deps(job, {
    beforeDeletion: (what) => {
      if (what === `remove:${job.task.id}`) late = commit(job.task.path, 'late.txt', 'feat: late work');
      if (what === 'remove:pilot') commit(job.pilot, 'late-pilot.txt', 'feat: late pilot work');
    },
  }));
  assert.equal(out, 'cleaned');
  taskKept(job);
  assert.equal(git(job.repo, 'rev-parse', job.task.branch), late, 'the task branch holds the late commit');
  assert.equal(existsSync(join(job.pilot, '.git')), true, 'the pilot worktree, with its late commit, stays');
  assert.equal(git(job.pilot, 'log', '-1', '--format=%s'), 'feat: late pilot work');
});

test('a branch moved between its proof and its deletion is kept, on its new commit', async () => {
  const { job, row } = await landedJob();
  const moved: Record<string, string> = {};
  const out = await cleanIntegration(row, deps(job, {
    beforeDeletion: (what) => {
      for (const branch of [job.branch, job.task.branch]) {
        if (what !== `ref:${branch}`) continue;
        moved[branch] = danglingCommit(job.repo, branch, 'feat: moved meanwhile');
        git(job.repo, 'update-ref', `refs/heads/${branch}`, moved[branch]!);
      }
    },
  }));
  assert.equal(out, 'cleaned');
  assert.equal(git(job.repo, 'rev-parse', job.task.branch), moved[job.task.branch], 'the task branch stays, moved');
  assert.equal(git(job.repo, 'rev-parse', job.branch), moved[job.branch], 'the job\'s branch stays, moved');
});

test('a pull request merged by squash deletes nothing, not even a worktree whose HEAD is in the target', async () => {
  const job = await prJob();
  // A task of the job that never committed: its HEAD is the target's own commit.
  const idle = randomUUID();
  dbApi.createTask(idle, 'nothing to do', job.agent, {
    type: 'code', project: job.slug, baseBranch: job.branch, integrationMode: 'pr', baseRef: 'origin/main',
    seriesId: job.series, creatorMissionId: job.series,
  });
  const idleInfo = await createWorktree(idle, job.repo, 'main');
  dbApi.setTaskWorktree(idle, idleInfo.path, idleInfo.branch, job.branch);
  db.prepare(`UPDATE tasks SET status = 'DONE', merged_commit_sha = ?, updated_at = ? WHERE id = ?`)
    .run(git(idleInfo.path, 'rev-parse', 'HEAD'), LONG_AGO, idle);
  git(job.forgeSide, 'fetch', '-q', 'origin');
  git(job.forgeSide, 'merge', '-q', '--squash', `origin/${job.branch}`);
  git(job.forgeSide, 'commit', '-q', '-m', 'feat: the job, squashed');
  git(job.forgeSide, 'push', '-q', 'origin', 'main');
  git(job.repo, 'fetch', '-q', job.remote, 'refs/heads/main:refs/remotes/origin/main');
  const row = land(job);
  dbApi.finishMission(job.series, 'completed', 0);
  assert.equal(git(job.repo, 'merge-base', '--is-ancestor', git(idleInfo.path, 'rev-parse', 'HEAD'), 'origin/main'), '');
  assert.equal(await cleanIntegration(row, deps(job)), 'cleaned');
  taskKept(job);
  assert.equal(existsSync(join(idleInfo.path, '.git')), true, 'the idle task\'s worktree stays');
  assert.equal(dbApi.getTask(idle)?.worktree_path, idleInfo.path);
  assert.equal(existsSync(join(job.pilot, '.git')), true, 'the pilot worktree stays');
  assert.equal(has(job.repo, `refs/heads/${job.branch}`), true, 'the branch stays');
  assert.equal(remoteHas(job, job.branch), true, 'its remote copy stays');
  assert.equal(seen.deletions.length, 0);
});

test('a branch checked out in the main checkout at the moment of its deletion is kept, and so is its remote copy', async () => {
  for (const moment of ['branch', 'ref:']) {
    const { job, row } = await landedJob();
    const out = await cleanIntegration(row, deps(job, {
      beforeDeletion: (what) => {
        if (what === moment || what === `${moment}${job.branch}`) git(job.repo, 'checkout', '-q', job.branch);
      },
    }));
    assert.equal(out, 'waiting', moment);
    assert.equal(has(job.repo, `refs/heads/${job.branch}`), true, 'a checked-out branch is never deleted');
    assert.equal(git(job.repo, 'branch', '--show-current'), job.branch);
    assert.equal(remoteHas(job, job.branch), true, 'the pass stops: the remote copy waits too');
    assert.equal(seen.deletions.length, 0);
    git(job.repo, 'checkout', '-q', 'main');
  }
});

test('a guard of the branch or of its remote copy that waits keeps the pilot worktree', async () => {
  // Local: the branch is checked out while its deletion is being proven.
  {
    const { job, row } = await landedJob();
    const out = await cleanIntegration(row, deps(job, {
      beforeDeletion: (what) => { if (what === `ref:${job.branch}`) git(job.repo, 'checkout', '-q', job.branch); },
    }));
    assert.equal(out, 'waiting');
    assert.equal(existsSync(join(job.pilot, '.git')), true, 'the pilot worktree outlives a local guard that waits');
    git(job.repo, 'checkout', '-q', 'main');
  }
  // Remote: the forge answers for another account.
  {
    const { job, row } = await landedJob();
    const out = await cleanIntegration(row, deps(job, { forge: () => ({
      login: async () => ({ ok: true, login: 'someone-else' }),
      branchStanding: async () => { throw new Error('never asked'); },
    }) }));
    assert.equal(out, 'waiting');
    assert.equal(remoteHas(job, job.branch), true);
    assert.equal(existsSync(join(job.pilot, '.git')), true, 'the pilot worktree outlives a remote guard that waits');
  }
});

test('origin pointed at a mirror: the remote branch is refused', async () => {
  // The project's setting and origin moved together to another repository.
  const both = await landedJob();
  const MIRROR = 'git@github.com:mirror/app.git';
  git(both.job.repo, 'config', 'remote.origin.pushurl', MIRROR);
  updateProjectIntegration(both.job.slug, { remote_url: MIRROR });
  assert.equal(await cleanIntegration(both.row, deps(both.job)), 'cleaned');
  assert.equal(seen.deletions.length, 0);
  assert.equal(remoteHas(both.job, both.job.branch), true);

  // Same owner and name, another host.
  const host = await landedJob();
  const ELSEWHERE = 'git@mirror.example:acme/app.git';
  git(host.job.repo, 'config', 'remote.origin.pushurl', ELSEWHERE);
  updateProjectIntegration(host.job.slug, { remote_url: ELSEWHERE });
  assert.equal(await cleanIntegration(host.row, deps(host.job)), 'cleaned');
  assert.equal(seen.deletions.length, 0);

  // origin alone repointed.
  const origin = await landedJob();
  git(origin.job.repo, 'config', 'remote.origin.pushurl', MIRROR);
  assert.equal(await cleanIntegration(origin.row, deps(origin.job)), 'cleaned');
  assert.equal(seen.deletions.length, 0);

  // A pull request recorded before the repository was: never deleted.
  const old = await landedJob();
  db.prepare(`UPDATE integrations SET pr_repository = NULL, pr_push_url = NULL WHERE id = ?`).run(old.row.id);
  assert.equal(await cleanIntegration(dbApi.getIntegrationById(old.row.id)!, deps(old.job)), 'cleaned');
  assert.equal(seen.deletions.length, 0);
  assert.equal(remoteHas(old.job, old.job.branch), true);
});

test('main, the target, the default branch and a protected branch are refused', async () => {
  // A row naming main as its branch.
  const named = await landedJob();
  db.prepare(`UPDATE integrations SET branch = 'main' WHERE id = ?`).run(named.row.id);
  assert.equal(await cleanIntegration(dbApi.getIntegrationById(named.row.id)!, deps(named.job)), 'cleaned');
  assert.equal(has(named.job.repo, 'refs/heads/main'), true);
  assert.equal(remoteHas(named.job, 'main'), true);
  assert.equal(seen.deletions.length, 0);

  // A row whose branch is its own target.
  const target = await landedJob();
  git(target.job.repo, 'fetch', '-q', target.job.remote, `refs/heads/${target.job.branch}:refs/remotes/origin/${target.job.branch}`);
  db.prepare(`UPDATE integrations SET target = branch WHERE id = ?`).run(target.row.id);
  assert.equal(await cleanIntegration(dbApi.getIntegrationById(target.row.id)!, deps(target.job)), 'cleaned');
  assert.equal(has(target.job.repo, `refs/heads/${target.job.branch}`), true);
  assert.equal(remoteHas(target.job, target.job.branch), true);
  assert.equal(seen.deletions.length, 0);

  // The repository's default branch, then a protected one, as the forge says.
  for (const standing of [{ defaultBranch: '', protected: false }, { defaultBranch: 'main', protected: true }]) {
    const { job, row } = await landedJob();
    const said = { defaultBranch: standing.defaultBranch || job.branch, protected: standing.protected };
    const out = await cleanIntegration(row, deps(job, {
      forge: () => ({
        login: async () => ({ ok: true, login: 'ai-bot' }),
        branchStanding: async () => ({ ok: true, standing: said }),
        headRefDeleted: async () => ({ ok: true, deleted: false }),
      }),
    }));
    assert.equal(out, 'cleaned');
    assert.equal(remoteHas(job, job.branch), true, JSON.stringify(said));
    assert.equal(seen.deletions.length, 0);
  }

  // A forge that cannot say: the remote branch waits.
  const unknown = await landedJob();
  const out = await cleanIntegration(unknown.row, deps(unknown.job, {
    forge: () => ({
      login: async () => ({ ok: true, login: 'ai-bot' }),
      branchStanding: async () => ({ ok: false, code: 'gh_failed', reason: 'HTTP 502' }),
      headRefDeleted: async () => ({ ok: true, deleted: false }),
    }),
  }));
  assert.equal(out, 'waiting');
  assert.equal(remoteHas(unknown.job, unknown.job.branch), true);
});

test('two concurrent passes delete once', async () => {
  const { job, row } = await landedJob();
  const shared = deps(job);
  const results = await Promise.all([cleanIntegration(row, shared), cleanIntegration(row, shared)]);
  assert.deepEqual(results.sort(), ['cleaned', 'waiting']);
  assert.equal(seen.deletions.length, 1, 'one remote deletion');
  assert.equal(has(job.repo, `refs/heads/${job.branch}`), false);
  // And a reload mid-pass: a second poller finds the row reserved.
  const second = await landedJob();
  let inner: Promise<string> | null = null;
  const out = await cleanIntegration(second.row, deps(second.job, {
    beforeDeletion: (what) => {
      if (what === 'branch' && !inner) inner = cleanConcludedIntegrations(deps(second.job)).then((m) => m.get(second.row.id) ?? 'absent');
    },
  }));
  assert.equal(out, 'cleaned');
  assert.equal(await inner, 'waiting');
  assert.equal(seen.deletions.length, 1);
});

test('a reservation a dead pass left is taken over once stale, never before', async () => {
  const { job, row } = await landedJob();
  db.prepare(`UPDATE integrations SET cleanup_started_at = ?, cleanup_token = 'dead-pass' WHERE id = ?`).run(Date.now(), row.id);
  assert.equal(await cleanIntegration(row, deps(job)), 'waiting');
  assert.equal(existsSync(job.task.path), true, 'a live reservation is left alone');
  db.prepare(`UPDATE integrations SET cleanup_started_at = ? WHERE id = ?`).run(Date.now() - 2 * 3600_000, row.id);
  assert.equal(await cleanIntegration(row, deps(job)), 'cleaned');
  assert.equal(existsSync(job.task.path), false);
  assert.equal(has(job.repo, `refs/heads/${job.branch}`), false);
});

test('a branch created again after the job concluded is not taken for the old one', async () => {
  // Right after the landing, in the same second or the next: the same commit.
  const { job, row } = await landedJob();
  git(job.repo, 'branch', '-D', job.branch);
  git(job.repo, 'branch', job.branch, job.head);
  assert.equal(await cleanIntegration(row, deps(job)), 'cleaned');
  assert.equal(has(job.repo, `refs/heads/${job.branch}`), true);

  // On the remote: deleted on the forge, then pushed again at the same commit.
  const remote = await landedJob();
  deleteOnForge(remote.job);
  git(remote.job.repo, 'push', '-q', remote.job.remote, `${remote.job.head}:refs/heads/${remote.job.branch}`);
  assert.equal(await cleanIntegration(remote.row, deps(remote.job)), 'cleaned');
  assert.equal(remoteHas(remote.job, remote.job.branch), true);
  assert.equal(seen.deletions.length, 0);

  // A deletion that timed out after it happened, then the branch pushed again.
  const cut = await landedJob();
  const first = deps(cut.job);
  const timedOut = await cleanIntegration(cut.row, {
    ...first,
    deleteRemote: async (repo, url, branch, sha) => {
      await first.deleteRemote!(repo, url, branch, sha);
      return { ok: false, code: 'timed_out', reason: 'git did not answer in time' };
    },
  });
  assert.equal(timedOut, 'waiting');
  assert.equal(remoteHas(cut.job, cut.job.branch), false);
  git(cut.job.repo, 'push', '-q', cut.job.remote, `${cut.job.head}:refs/heads/${cut.job.branch}`);
  assert.equal(await cleanIntegration(dbApi.getIntegrationById(cut.row.id)!, deps(cut.job)), 'cleaned');
  assert.equal(remoteHas(cut.job, cut.job.branch), true);
  assert.equal(seen.deletions.length, 0);

  // A forge that cannot tell: the remote copy waits.
  const unsure = await landedJob();
  const out = await cleanIntegration(unsure.row, deps(unsure.job, {
    forge: () => ({
      login: async () => ({ ok: true, login: 'ai-bot' }),
      branchStanding: async () => ({ ok: true, standing: { defaultBranch: 'main', protected: false } }),
      headRefDeleted: async () => ({ ok: false, code: 'gh_failed', reason: 'HTTP 502' }),
    }),
  }));
  assert.equal(out, 'waiting');
  assert.equal(remoteHas(unsure.job, unsure.job.branch), true);
});
