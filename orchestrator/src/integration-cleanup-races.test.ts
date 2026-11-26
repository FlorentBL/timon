/**
 * The three races the security reviews of the cleanup after a landing found
 * open (TODO #1210), each played at the moment it happened:
 *
 * 1. a guard that waits after the pilot's worktree is gone;
 * 2. a task reopened, or the pilot's HEAD moved, while git proves what goes;
 * 3. a branch deleted and made again at the same commit around the reading
 *    of its history.
 */
import './test-home.js';
import assert from 'node:assert/strict';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { dbApi } from './db.js';
import { cleanIntegration, type CleanupPoint } from './integration-cleanup.js';
import {
  branchKept, deps, git, has, landedJob, pilotKept, refused, root, type Job,
} from './integration-cleanup-fixture.js';

after(() => rmSync(root, { recursive: true, force: true }));

/** Runs `act` once, when the pass reaches `point`. */
function when(point: CleanupPoint, act: () => void): { at: (p: CleanupPoint) => void; fired: () => boolean } {
  let fired = false;
  return {
    at: (p) => {
      if (p !== point || fired) return;
      fired = true;
      act();
    },
    fired: () => fired,
  };
}

const reopen = (job: Job): void => { dbApi.updateTaskStatus(job.task.id, 'PENDING'); };

// ─── 1. Nothing waits after the pilot is gone ───────────────────────────────

test('race 1: a checkout of the branch during the pass leaves the pilot\'s worktree and the branch', async () => {
  const { job, row } = await landedJob();
  const elsewhere = join(root, `checkout-${job.series}`);
  // Between the proof and the ref's lock: once locked, git refuses the checkout itself (race 3).
  const hook = when('branch:proven', () => { git(job.repo, 'worktree', 'add', '-q', elsewhere, job.branch); });
  assert.equal(await cleanIntegration(row, deps(job, { at: hook.at })), 'waiting');
  assert.ok(hook.fired());
  pilotKept(job);
  branchKept(job);
  // The checkout gone, the next pass removes both.
  git(job.repo, 'worktree', 'remove', elsewhere);
  assert.equal(await cleanIntegration(row, deps(job)), 'cleaned');
  assert.equal(existsSync(job.pilot), false);
  assert.equal(has(job.repo, `refs/heads/${job.branch}`), false);
});

test('race 1: the pilot\'s worktree is the last effect of a pass', async () => {
  const { job, row } = await landedJob();
  const seen: CleanupPoint[] = [];
  assert.equal(await cleanIntegration(row, deps(job, { at: (p) => { seen.push(p); } })), 'cleaned');
  assert.deepEqual(seen, ['branch:proven', 'branch:locked', 'branch:commit', 'pilot:proving', 'pilot:remove']);
});

// ─── 2. The database is read after git, HEAD cannot move ─────────────────────

test('race 2: a task reopened while git reads the branch keeps the branch and the pilot', async () => {
  const { job, row } = await landedJob();
  const hook = when('branch:locked', () => reopen(job));
  assert.equal(await cleanIntegration(row, deps(job, { at: hook.at })), 'waiting');
  assert.ok(hook.fired());
  branchKept(job);
  pilotKept(job);
});

test('race 2: a task reopened while git proves the pilot\'s HEAD keeps the pilot', async () => {
  const { job, row } = await landedJob();
  const hook = when('pilot:proving', () => reopen(job));
  assert.equal(await cleanIntegration(row, deps(job, { at: hook.at })), 'waiting');
  assert.ok(hook.fired());
  pilotKept(job);
});

test('race 2: a pilot back at work during the proof keeps its worktree', async () => {
  const { job, row } = await landedJob();
  const hook = when('pilot:remove', () => dbApi.reopenMission(job.series));
  assert.equal(await cleanIntegration(row, deps(job, { at: hook.at })), 'waiting');
  assert.ok(hook.fired());
  pilotKept(job);
});

test('race 2: the pilot\'s HEAD cannot move while git proves it landed', async () => {
  const { job, row } = await landedJob();
  const before = git(job.pilot, 'rev-parse', 'HEAD');
  const attempts: boolean[] = [];
  const hook = when('pilot:proving', () => {
    attempts.push(refused(job.pilot, 'commit', '-q', '--allow-empty', '-m', 'during the proof'));
    attempts.push(refused(job.pilot, 'update-ref', '--no-deref', 'HEAD', `${before}~1`));
  });
  assert.equal(await cleanIntegration(row, deps(job, { at: hook.at })), 'cleaned');
  assert.deepEqual(attempts, [true, true], 'git refuses to move HEAD while the cleanup holds it');
  assert.equal(existsSync(job.pilot), false, 'what was proven is what went');
  // The commit proven is still in the target: nothing was lost.
  assert.equal(refused(job.repo, 'merge-base', '--is-ancestor', before, 'refs/remotes/origin/main'), false);
});

test('race 2: a checkout refused during the proof leaves HEAD, and the worktree it touched is kept', async () => {
  const { job, row } = await landedJob();
  const before = git(job.pilot, 'rev-parse', 'HEAD');
  let headDuring = '';
  const hook = when('pilot:proving', () => {
    assert.equal(refused(job.pilot, 'checkout', '-q', '--detach', 'HEAD~1'), true);
    headDuring = git(job.pilot, 'rev-parse', 'HEAD');
  });
  assert.equal(await cleanIntegration(row, deps(job, { at: hook.at })), 'waiting');
  assert.equal(headDuring, before, 'HEAD did not move');
  pilotKept(job);
  // Its lock is given back: the pilot can put its files back.
  assert.equal(refused(job.pilot, 'reset', '-q', '--hard', 'HEAD'), false);
});

test('race 2: a change written in the pilot\'s worktree during the proof keeps it', async () => {
  const { job, row } = await landedJob();
  const hook = when('pilot:proving', () => { writeFileSync(join(job.pilot, 'late.txt'), 'written during the proof\n'); });
  assert.equal(await cleanIntegration(row, deps(job, { at: hook.at })), 'waiting');
  pilotKept(job);
  assert.equal(existsSync(join(job.pilot, 'late.txt')), true);
  // Its lock is given back: the pilot can commit again.
  assert.equal(refused(job.pilot, 'add', 'late.txt'), false);
  assert.equal(refused(job.pilot, 'commit', '-q', '-m', 'kept work'), false);
});

// ─── 3. A branch made again at the same commit ──────────────────────────────

test('race 3: a branch deleted and made again at the same commit before its history is read is kept', async () => {
  const { job, row } = await landedJob();
  const hook = when('branch:proven', () => {
    git(job.repo, 'branch', '-D', job.branch);
    git(job.repo, 'branch', job.branch, job.head);
  });
  assert.equal(await cleanIntegration(row, deps(job, { at: hook.at })), 'cleaned');
  assert.ok(hook.fired());
  assert.equal(git(job.repo, 'rev-parse', `refs/heads/${job.branch}`), job.head);
  branchKept(job);
});

test('race 3: once its history is read, the branch cannot be deleted nor made again until it goes', async () => {
  const { job, row } = await landedJob();
  const attempts: boolean[] = [];
  const hook = when('branch:commit', () => {
    attempts.push(refused(job.repo, 'branch', '-D', job.branch));
    attempts.push(refused(job.repo, 'update-ref', `refs/heads/${job.branch}`, job.head));
    attempts.push(refused(job.repo, 'branch', '-f', job.branch, job.head));
    attempts.push(refused(job.repo, 'worktree', 'add', '-q', join(root, `late-${job.series}`), job.branch));
  });
  assert.equal(await cleanIntegration(row, deps(job, { at: hook.at })), 'cleaned');
  assert.deepEqual(attempts, [true, true, true, true], 'git holds the ref\'s lock from its proof to its deletion');
  assert.equal(has(job.repo, `refs/heads/${job.branch}`), false);
});
