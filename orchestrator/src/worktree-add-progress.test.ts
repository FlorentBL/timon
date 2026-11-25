/**
 * TIM-0164: creating a worktree waits for as long as git reports progress, and
 * a git that goes silent is stopped with what it started, its half-made
 * worktree removed and its branch kept. An existing folder is reused only once
 * its checkout is complete.
 *
 * A fake `git` ahead on PATH plays the slow or stalled checkout of
 * `git worktree add`, and hands every other call to the real git.
 */
import './test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { accessSync, chmodSync, constants, existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

const posix = process.platform !== 'win32';

function realGit(): string {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    const candidate = join(dir, 'git');
    try { accessSync(candidate, constants.X_OK); return candidate; } catch { /* next */ }
  }
  throw new Error('git not found on PATH');
}

const fakeDir = mkdtempSync(join(tmpdir(), 'timon-fake-git-'));
const pidFile = join(fakeDir, 'stalled-child.pid');
if (posix) {
  const real = realGit();
  // `slow`: eight progress lines, 250 ms apart, then the real checkout.
  // `stalled`: registers the worktree without its checkout, as one cut short
  // leaves it, prints one progress line and hangs with a child of its own.
  writeFileSync(join(fakeDir, 'git'), `#!/bin/sh
real=${JSON.stringify(real)}
case " $* " in *" worktree add "*) ;; *) exec "$real" "$@" ;; esac
if [ "$FAKE_GIT_MODE" = slow ]; then
  i=1
  while [ $i -le 8 ]; do
    printf 'Updating files: %d%% (%d/8)\\r' $((i * 12)) $i >&2
    sleep 0.25
    i=$((i + 1))
  done
  exec "$real" "$@"
fi
if [ "$FAKE_GIT_MODE" = stalled ]; then
  first=1
  for a in "$@"; do
    if [ $first = 1 ]; then set --; first=0; fi
    set -- "$@" "$a"
    if [ "$a" = add ]; then set -- "$@" --no-checkout --lock; fi
  done
  "$real" "$@" >/dev/null 2>&1
  printf 'Updating files:  55%% (4760/8608)\\r' >&2
  sleep 30 &
  echo $! > ${JSON.stringify(pidFile)}
  wait
  exit 0
fi
exec "$real" "$@"
`);
  chmodSync(join(fakeDir, 'git'), 0o755);
  process.env.PATH = `${fakeDir}${delimiter}${process.env.PATH ?? ''}`;
}
process.on('exit', () => rmSync(fakeDir, { recursive: true, force: true }));

const { createWorktree, disposeWorktree } = await import('./worktree.js');
const { invalidateSettingsCache } = await import('./settings.js');

function useStall(ms: number): void {
  process.env.TIMON_WORKTREE_ADD_STALL_MS = String(ms);
  invalidateSettingsCache();
}

function makeRepo(): { repo: string; git: (...args: string[]) => string } {
  const repo = mkdtempSync(join(tmpdir(), 'timon-worktree-progress-'));
  const git = (...args: string[]) => execFileSync(realGit(), ['-C', repo, ...args], { encoding: 'utf8', stdio: 'pipe' });
  git('init', '-b', 'main');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.invalid');
  for (let i = 0; i < 20; i++) writeFileSync(join(repo, `file-${i}.txt`), `${i}\n`);
  git('add', '.');
  git('commit', '-m', 'Initial files');
  return { repo, git };
}

function running(pid: number): boolean {
  try { process.kill(pid, 0); } catch { return false; }
  if (process.platform !== 'linux') return true;
  // portability: Linux pseudo-fs, behind the platform guard above
  try { return !/^\d+ \(.*\) Z /s.test(readFileSync(`/proc/${pid}/stat`, 'utf8')); } catch { return false; }
}

async function stopsRunning(pid: number, withinMs = 3_000): Promise<boolean> {
  for (const end = Date.now() + withinMs; Date.now() < end; await new Promise((r) => { setTimeout(r, 25); })) {
    if (!running(pid)) return true;
  }
  return !running(pid);
}

test('a checkout that keeps reporting progress is waited on past the stall delay', { skip: !posix }, async () => {
  const { repo, git } = makeRepo();
  const taskId = randomUUID();
  useStall(800);
  process.env.FAKE_GIT_MODE = 'slow';
  let worktree: Awaited<ReturnType<typeof createWorktree>> | undefined;
  try {
    const started = Date.now();
    worktree = await createWorktree(taskId, repo, 'main');
    assert.ok(Date.now() - started >= 1_500, 'the fake checkout lasts 2 s, well past the 800 ms stall delay');
    assert.ok(existsSync(join(worktree.path, 'file-19.txt')));
    assert.equal(execFileSync(realGit(), ['-C', worktree.path, 'status', '--porcelain'], { encoding: 'utf8' }), '');
    assert.equal(git('branch', '--show-current').trim(), 'main');
  } finally {
    delete process.env.FAKE_GIT_MODE;
    if (worktree) await disposeWorktree(worktree, true);
    rmSync(repo, { recursive: true, force: true });
  }
});

test('a silent git is stopped with its children, its half-made worktree removed and its branch kept', { skip: !posix }, async () => {
  const { repo, git } = makeRepo();
  const taskId = randomUUID();
  useStall(600);
  process.env.FAKE_GIT_MODE = 'stalled';
  let worktree: Awaited<ReturnType<typeof createWorktree>> | undefined;
  let left = 0;
  try {
    const started = Date.now();
    const error = await createWorktree(taskId, repo, 'main').then(
      () => assert.fail('a stalled checkout must fail'),
      (e: unknown) => e as Error & { stderr: string; timedOut?: boolean },
    );
    assert.ok(Date.now() - started < 10_000, 'the stall delay ends the call, not the fake 30 s');
    assert.equal(error.timedOut, true);
    assert.match(error.stderr, /no progress for 1 s/);
    assert.match(error.stderr, /Updating files: {2}55%/, 'the last progress line is quoted');
    assert.match(error.stderr, /TIMON_WORKTREE_ADD_STALL_MS/);
    left = Number(readFileSync(pidFile, 'utf8').trim());
    assert.ok(await stopsRunning(left), `the checkout's child ${left} survived`);

    const path = join(process.env.TIMON_HOME ?? '', 'worktrees', taskId);
    assert.equal(existsSync(path), false, 'the half-made folder is gone');
    assert.doesNotMatch(git('worktree', 'list', '--porcelain'), new RegExp(taskId));
    assert.ok(git('branch', '--list', `timon/task/${taskId}`).trim(), 'the branch is kept');

    // The next dispatch reattaches to that branch and gets a complete checkout.
    delete process.env.FAKE_GIT_MODE;
    worktree = await createWorktree(taskId, repo, 'main');
    assert.equal(worktree.path, path);
    assert.ok(existsSync(join(path, 'file-19.txt')));
    assert.equal(execFileSync(realGit(), ['-C', path, 'branch', '--show-current'], { encoding: 'utf8' }).trim(), `timon/task/${taskId}`);
  } finally {
    delete process.env.FAKE_GIT_MODE;
    if (left > 1) { try { process.kill(left, 'SIGKILL'); } catch { /* gone, as it should be */ } }
    if (worktree) await disposeWorktree(worktree, true);
    rmSync(repo, { recursive: true, force: true });
  }
});

test('an existing folder is reused only once its checkout is complete', { skip: !posix }, async () => {
  const { repo } = makeRepo();
  const taskId = randomUUID();
  useStall(30_000);
  let worktree: Awaited<ReturnType<typeof createWorktree>> | undefined;
  try {
    worktree = await createWorktree(taskId, repo, 'main');
    const gitDir = execFileSync(realGit(), ['-C', worktree.path, 'rev-parse', '--path-format=absolute', '--git-dir'], { encoding: 'utf8' }).trim();
    writeFileSync(join(worktree.path, 'work-in-progress.txt'), 'kept\n');

    // A git still writing (or one that died holding its lock): refused, nothing touched.
    writeFileSync(join(gitDir, 'index.lock'), '');
    await assert.rejects(createWorktree(taskId, repo, 'main'), (e: Error & { stderr: string }) => /index\.lock/.test(e.stderr));
    assert.ok(existsSync(join(worktree.path, 'work-in-progress.txt')));
    unlinkSync(join(gitDir, 'index.lock'));

    // Complete: reused as it is.
    const again = await createWorktree(taskId, repo, 'main');
    assert.equal(again.path, worktree.path);
    assert.ok(existsSync(join(worktree.path, 'work-in-progress.txt')));

    // No index: a checkout that never finished is made again, on the same branch.
    unlinkSync(join(gitDir, 'index'));
    rmSync(join(worktree.path, 'file-3.txt'));
    const remade = await createWorktree(taskId, repo, 'main');
    assert.equal(remade.path, worktree.path);
    assert.ok(existsSync(join(worktree.path, 'file-3.txt')));
    assert.equal(execFileSync(realGit(), ['-C', worktree.path, 'status', '--porcelain'], { encoding: 'utf8' }), '');
  } finally {
    if (worktree) await disposeWorktree(worktree, true);
    rmSync(repo, { recursive: true, force: true });
  }
});
