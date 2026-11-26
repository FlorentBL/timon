/**
 * A job whose pull request was closed without a merge, then opened again by
 * the landing gesture (TODO #1153): the closing's cleanup only gave back the
 * pilot's worktree, so the branch still goes once the new pull request lands.
 * Apart from `integration-cleanup.test.ts`, whose real git repositories already
 * fill its time limit on a busy machine.
 */
import './test-home.js';
import assert from 'node:assert/strict';
import { existsSync, rmSync } from 'node:fs';
import { after, test } from 'node:test';
import { dbApi } from './db.js';
import { getForgeProposalByKey } from './forge-proposals.js';
import { cleanConcludedIntegrations, cleanIntegration } from './integration-cleanup.js';
import {
  branchKept, deps, has, land, mergeOnForge, pilotKept, prJob, remoteHas, root, taskUntouched,
} from './integration-cleanup-fixture.js';
import { remoteDeletionKey } from './landing-branch-delete.js';
import { invalidateSettingsCache } from './settings.js';

function cleanupSwitch(on: boolean): void {
  if (on) process.env.TIMON_INTEGRATION_CLEANUP_ENABLED = '1';
  else delete process.env.TIMON_INTEGRATION_CLEANUP_ENABLED;
  invalidateSettingsCache();
}

after(() => rmSync(root, { recursive: true, force: true }));

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
