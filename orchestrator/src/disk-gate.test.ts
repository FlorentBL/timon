/**
 * The dispatcher's free-space floor (`disk-gate.ts`): a simulated filesystem
 * answers how much is free, nothing reads the real disk.
 */
import './test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { db } from './db.js';
import { DiskPause, diskGate } from './disk-gate.js';
import { diskAllowsDispatch } from './dispatcher.js';
import { setSetting } from './settings.js';
import { WORKTREES_ROOT, createWorktree, worktreeDiskGate } from './worktree.js';

const GiB = 1024 ** 3;
const home = mkdtempSync(join(tmpdir(), 'timon-disk-gate-'));

test('the gate opens above the floor and closes under it, on the first existing folder', () => {
  const seen: string[] = [];
  const free = (bytes: number) => (dir: string) => { seen.push(dir); return bytes; };
  const missing = join(home, 'not-there');
  assert.deepEqual(diskGate([missing, home], GiB, free(2 * GiB)), { ok: true, free: 2 * GiB });
  assert.deepEqual(seen, [home]);
  assert.deepEqual(diskGate([home], GiB, free(GiB / 2)), { ok: false, free: GiB / 2, min: GiB, dir: home });
});

test('a floor of 0, an unreadable disk or no folder at all keep the gate open', () => {
  assert.equal(diskGate([home], 0, () => 0).ok, true);
  assert.equal(diskGate([home], GiB, () => null).ok, true);
  assert.equal(diskGate([join(home, 'nowhere')], GiB, () => 0).ok, true);
});

test('the pause changes state once per episode', () => {
  const pause = new DiskPause();
  const low = { ok: false as const, free: 1, min: 2, dir: home };
  const fine = { ok: true as const, free: 3 };
  assert.equal(pause.update(fine), null);
  assert.equal(pause.update(low), 'paused');
  assert.equal(pause.update(low), null);
  assert.equal(pause.isPaused, true);
  assert.equal(pause.update(fine), 'resumed');
  assert.equal(pause.update(fine), null);
});

test('the setting sets the floor of the worktree gate', () => {
  setSetting('TIMON_DISK_MIN_FREE_MB', '2048');
  try {
    assert.equal(worktreeDiskGate(() => 3 * GiB).ok, true);
    assert.equal(worktreeDiskGate(() => GiB).ok, false);
    setSetting('TIMON_DISK_MIN_FREE_MB', '0');
    assert.equal(worktreeDiskGate(() => 0).ok, true);
  } finally {
    setSetting('TIMON_DISK_MIN_FREE_MB', null);
  }
});

const notifications = (code: string): number =>
  (db.prepare(`SELECT payload FROM agent_messages WHERE kind = 'notification'`).all() as { payload: string }[])
    .filter((r) => (JSON.parse(r.payload) as { code?: string }).code === code).length;

test('the dispatcher pauses under the floor and tells the user once, then once again when it resumes', () => {
  const low = { ok: false as const, free: GiB / 2, min: 3 * GiB, dir: home };
  assert.equal(diskAllowsDispatch(low), false);
  assert.equal(diskAllowsDispatch(low), false);
  assert.equal(notifications('dispatcher_disk_paused'), 1);
  assert.equal(diskAllowsDispatch({ ok: true, free: 10 * GiB }), true);
  assert.equal(diskAllowsDispatch({ ok: true, free: 10 * GiB }), true);
  assert.equal(notifications('dispatcher_disk_resumed'), 1);
});

test('no worktree is created under the floor, and nothing is left on disk', async () => {
  const repo = join(home, `repo-${randomUUID()}`);
  mkdirSync(repo, { recursive: true });
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 'T');
  writeFileSync(join(repo, 'a'), '1');
  git('add', 'a');
  git('commit', '-q', '-m', 'one');
  // No disk has a billion MB free: the floor is out of reach.
  setSetting('TIMON_DISK_MIN_FREE_MB', String(1_000_000_000));
  const id = randomUUID();
  try {
    await assert.rejects(createWorktree(id, repo, 'main'), /TIMON_DISK_MIN_FREE_MB/);
  } finally {
    setSetting('TIMON_DISK_MIN_FREE_MB', null);
  }
  assert.equal(existsSync(join(WORKTREES_ROOT, id)), false);
  assert.equal(git('branch', '--list', `timon/task/${id}`).trim(), '');
});
