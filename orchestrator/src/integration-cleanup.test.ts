/**
 * The cleanup after a landing, narrow version (TODO #1210): the local branch
 * and the pilot's worktree, nothing else. The task worktrees stay for the
 * worktree GC, the remote copy is only proposed.
 */
import './test-home.js';
import assert from 'node:assert/strict';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { db, dbApi } from './db.js';
import { getForgeProposalByKey, publishForgeProposal } from './forge-proposals.js';
import { cleanConcludedIntegrations, cleanIntegration } from './integration-cleanup.js';
import {
  branchKept, commit, deps, git, has, land, landedJob, mergeLocally, mergeOnForge, pilotKept, prJob, proposalDeps,
  remoteHas, root, taskUntouched,
} from './integration-cleanup-fixture.js';
import { remoteDeletionKey } from './landing-branch-delete.js';
import { invalidateSettingsCache } from './settings.js';

function cleanupSwitch(on: boolean): void {
  if (on) process.env.TIMON_INTEGRATION_CLEANUP_ENABLED = '1';
  else delete process.env.TIMON_INTEGRATION_CLEANUP_ENABLED;
  invalidateSettingsCache();
}

after(() => rmSync(root, { recursive: true, force: true }));

test('off by default: nothing is looked at unless turned on', async () => {
  const { job } = await landedJob();
  cleanupSwitch(false);
  assert.equal((await cleanConcludedIntegrations(deps(job))).size, 0);
  pilotKept(job);
  branchKept(job);
});

test('a landed job loses its local branch and its pilot\'s worktree, and nothing else', async () => {
  const { job, row } = await landedJob();
  cleanupSwitch(true);
  try {
    const results = await cleanConcludedIntegrations(deps(job));
    assert.equal(results.get(row.id), 'cleaned');
  } finally {
    cleanupSwitch(false);
  }
  assert.equal(has(job.repo, `refs/heads/${job.branch}`), false, 'the branch goes');
  assert.equal(existsSync(job.pilot), false, 'the pilot worktree goes');
  taskUntouched(job);
  assert.equal(remoteHas(job, job.branch), true, 'the remote copy is never deleted by the pass');
  assert.ok(dbApi.getIntegrationById(row.id)?.cleaned_at, 'the row is dealt with once');
  // Its deletion on the remote waits for a person.
  const proposal = getForgeProposalByKey(job.slug, remoteDeletionKey(row));
  assert.equal(proposal?.kind, 'delete_branch');
  assert.equal(proposal?.state, 'draft');
  assert.equal(proposal?.target_number, row.pr_number);
});

test('a person approves the remote deletion: the branch goes, leased on the commit that landed', async () => {
  const { job, row } = await landedJob();
  assert.equal(await cleanIntegration(row, deps(job)), 'cleaned');
  const proposal = getForgeProposalByKey(job.slug, remoteDeletionKey(row))!;
  const out = await publishForgeProposal(job.slug, proposal.id, 'user-ada', undefined, proposalDeps(job));
  assert.equal(out.ok, true);
  assert.equal(remoteHas(job, job.branch), false);
  // Published once: approving again changes nothing.
  const again = await publishForgeProposal(job.slug, proposal.id, 'user-ada', undefined, proposalDeps(job));
  assert.ok(again.ok && again.already);
});

test('a remote branch pushed to since it was merged is kept, even once approved', async () => {
  const { job, row } = await landedJob();
  assert.equal(await cleanIntegration(row, deps(job)), 'cleaned');
  const proposal = getForgeProposalByKey(job.slug, remoteDeletionKey(row))!;
  git(job.forgeSide, 'checkout', '-q', '-b', 'later', `origin/${job.branch}`);
  commit(job.forgeSide, 'later.txt', 'feat: later work');
  git(job.forgeSide, 'push', '-q', 'origin', `HEAD:refs/heads/${job.branch}`);
  const out = await publishForgeProposal(job.slug, proposal.id, 'user-ada', undefined, proposalDeps(job));
  assert.equal(out.ok, false);
  assert.equal(!out.ok && out.code, 'forge_head_moved');
  assert.equal(remoteHas(job, job.branch), true);
});

test('no proposal when the forge already deleted the merged branch', async () => {
  const job = await prJob();
  mergeOnForge(job);
  git(job.forgeSide, 'push', '-q', 'origin', `:refs/heads/${job.branch}`);
  const row = land(job);
  dbApi.finishMission(job.series, 'completed', 0);
  assert.equal(await cleanIntegration(row, deps(job)), 'cleaned');
  assert.equal(getForgeProposalByKey(job.slug, remoteDeletionKey(row)), undefined);
});

test('a squash leaves everything: the head the job integrated is not in the target', async () => {
  const job = await prJob();
  mergeOnForge(job, 'squash');
  const row = land(job);
  dbApi.finishMission(job.series, 'completed', 0);
  assert.equal(await cleanIntegration(row, deps(job)), 'cleaned');
  pilotKept(job);
  branchKept(job);
  assert.equal(getForgeProposalByKey(job.slug, remoteDeletionKey(row)), undefined);
});

test('a pull request closed without a merge gives back the pilot\'s worktree only', async () => {
  const job = await prJob();
  dbApi.finishMission(job.series, 'completed', 0);
  assert.ok(dbApi.markIntegrationClosed(job.row.id));
  const row = dbApi.getIntegrationById(job.row.id)!;
  assert.equal(await cleanIntegration(row, deps(job)), 'cleaned');
  assert.equal(existsSync(job.pilot), false);
  branchKept(job);
  assert.equal(remoteHas(job, job.branch), true);
});

test('a pull request closed, then opened again and merged: its branch still goes once it lands', async () => {
  const job = await prJob();
  dbApi.finishMission(job.series, 'completed', 0);
  assert.ok(dbApi.markIntegrationClosed(job.row.id));
  assert.equal(await cleanIntegration(dbApi.getIntegrationById(job.row.id)!, deps(job)), 'cleaned');
  assert.equal(existsSync(job.pilot), false);
  branchKept(job);

  // The landing gesture opens a new pull request: the closing's cleanup is forgotten.
  const number = 7000 + Number(job.branch.split('-').pop());
  assert.ok(dbApi.markIntegrationReopened(job.row.id, { number, url: `https://github.com/acme/app/pull/${number}`, headSha: job.head }));
  assert.equal(dbApi.getIntegrationById(job.row.id)?.cleaned_at, null);
  mergeOnForge(job);
  const row = land(job);
  cleanupSwitch(true);
  try {
    assert.equal((await cleanConcludedIntegrations(deps(job))).get(row.id), 'cleaned');
  } finally {
    cleanupSwitch(false);
  }
  assert.equal(has(job.repo, `refs/heads/${job.branch}`), false, 'the branch goes');
  taskUntouched(job);
  assert.equal(remoteHas(job, job.branch), true, 'the remote copy is only proposed');
  assert.equal(getForgeProposalByKey(job.slug, remoteDeletionKey(row))?.target_number, number);
});

test('a pull request opened again while its closing is being cleaned: the pass stops before its effect', async () => {
  const job = await prJob();
  dbApi.finishMission(job.series, 'completed', 0);
  assert.ok(dbApi.markIntegrationClosed(job.row.id));
  const number = 8000 + Number(job.branch.split('-').pop());
  const reopen = (): void => {
    assert.ok(dbApi.markIntegrationReopened(job.row.id, { number, url: `https://github.com/acme/app/pull/${number}`, headSha: job.head }));
  };
  const out = await cleanIntegration(dbApi.getIntegrationById(job.row.id)!, deps(job, {
    at: (point) => { if (point === 'pilot:remove') reopen(); },
  }));
  assert.equal(out, 'waiting');
  pilotKept(job);
  branchKept(job);
  const row = dbApi.getIntegrationById(job.row.id)!;
  assert.deepEqual([row.state, row.cleaned_at, row.cleanup_token], ['open', null, null]);
});

test('a pilot worktree holding uncommitted work is kept, the branch still goes', async () => {
  const { job, row } = await landedJob();
  writeFileSync(join(job.pilot, 'draft.txt'), 'never committed\n');
  assert.equal(await cleanIntegration(row, deps(job)), 'cleaned');
  pilotKept(job);
  assert.equal(existsSync(join(job.pilot, 'draft.txt')), true);
  assert.equal(has(job.repo, `refs/heads/${job.branch}`), false);
});

test('a pilot worktree holding a commit the target lacks is kept', async () => {
  const { job, row } = await landedJob();
  commit(job.pilot, 'after.txt', 'feat: after the merge');
  assert.equal(await cleanIntegration(row, deps(job)), 'cleaned');
  pilotKept(job);
});

test('a running pilot, or a task not DONE, holds everything', async () => {
  const job = await prJob();
  mergeOnForge(job);
  const row = land(job);
  // The pilot's mission still runs.
  assert.equal(await cleanIntegration(row, deps(job)), 'waiting');
  pilotKept(job);
  branchKept(job);
  dbApi.finishMission(job.series, 'completed', 0);
  dbApi.updateTaskStatus(job.task.id, 'PENDING');
  assert.equal(await cleanIntegration(row, deps(job)), 'waiting');
  pilotKept(job);
  branchKept(job);
});

test('a branch git dates from the job\'s conclusion or later is not the job\'s', async () => {
  const { job, row } = await landedJob();
  // Deleted and made again at the same commit after the landing.
  git(job.repo, 'branch', '-D', job.branch);
  git(job.repo, 'branch', job.branch, job.head);
  assert.equal(await cleanIntegration(row, deps(job)), 'cleaned');
  branchKept(job);
});

test('main, master and the target are never deleted', async () => {
  const job = await prJob({ local: true });
  dbApi.finishMission(job.series, 'completed', 0);
  mergeLocally(job);
  const row = land(job);
  // A row that names the target as its branch, whatever wrote it.
  db.prepare(`UPDATE integrations SET branch = 'main' WHERE id = ?`).run(row.id);
  assert.equal(await cleanIntegration(dbApi.getIntegrationById(row.id)!, deps(job)), 'cleaned');
  assert.equal(has(job.repo, 'refs/heads/main'), true);
});

test('a local landing: the branch merged into the local target goes, and no remote is asked', async () => {
  const job = await prJob({ local: true });
  dbApi.finishMission(job.series, 'completed', 0);
  mergeLocally(job);
  const row = land(job);
  assert.equal(await cleanIntegration(row, deps(job)), 'cleaned');
  assert.equal(has(job.repo, `refs/heads/${job.branch}`), false);
  assert.equal(existsSync(job.pilot), false);
  assert.equal(getForgeProposalByKey(job.slug, remoteDeletionKey(row)), undefined);
});

test('two passes at once: one reserves the row, the other waits', async () => {
  const { job, row } = await landedJob();
  const [a, b] = await Promise.all([cleanIntegration(row, deps(job)), cleanIntegration(row, deps(job))]);
  assert.deepEqual([a, b].sort(), ['cleaned', 'waiting']);
  assert.equal(has(job.repo, `refs/heads/${job.branch}`), false);
});
