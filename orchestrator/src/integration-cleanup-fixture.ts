/**
 * The throwaway world of the cleanup tests (`integration-cleanup*.test.ts`):
 * a bare repository plays the remote, a clone plays the merge button, and
 * `gh` is a stand-in, so nothing reaches a forge. Import `./test-home.js`
 * before this module.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { db, dbApi, type IntegrationRow } from './db.js';
import type { ForgeCommentWriter, GitRunner } from './host/forge.js';
import type { CleanupDeps } from './integration-cleanup.js';
import type { RemoteDeletionDeps } from './landing-branch-delete.js';
import { agentConfig, agentDir } from './paths.js';
import { updateProjectIntegration } from './project-integration.js';
import { createWorktree } from './worktree.js';

/** One throwaway folder per test process; each file removes it `after` its tests. */
export const root = realpathSync(mkdtempSync(join(tmpdir(), 'timon-integration-cleanup-')));
export const pilots = join(root, 'series-worktrees');
mkdirSync(pilots, { recursive: true });

export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=Acme Bot', '-c', 'user.email=bot@acme.test', '-c', 'commit.gpgsign=false', ...args], {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

/** A git command expected to fail: true when git refused it. */
export function refused(cwd: string, ...args: string[]): boolean {
  try { git(cwd, ...args); return false; } catch { return true; }
}

export function commit(cwd: string, file: string, message: string): string {
  writeFileSync(join(cwd, file), `${message}\n`);
  git(cwd, 'add', file);
  git(cwd, 'commit', '-q', '-m', message);
  return git(cwd, 'rev-parse', 'HEAD');
}

export function has(repo: string, ref: string): boolean {
  try { git(repo, 'rev-parse', '--verify', '--quiet', ref); return true; } catch { return false; }
}

export const LONG_AGO = Date.now() - 24 * 3600_000;
export const PUSH_URL = 'git@github.com:acme/app.git';

export type Job = {
  repo: string; remote: string; forgeSide: string; slug: string; agent: string;
  branch: string; head: string; series: string; pilot: string; task: { id: string; path: string; branch: string };
  row: IntegrationRow;
};

let counter = 0;

/**
 * A job of a project that lands through pull requests: `feat/job-<n>` pushed
 * to the bare remote, one DONE code task merged into it from its worktree, a
 * sequential pilot's worktree detached on it, and its pull request open.
 */
export async function prJob(opts: { local?: boolean } = {}): Promise<Job> {
  // The job is built an hour before it lands, as it is for real: git dates a
  // branch from its reflog, which takes the committer's date.
  const before = process.env.GIT_COMMITTER_DATE;
  process.env.GIT_COMMITTER_DATE = `@${Math.floor((Date.now() - 3600_000) / 1000)} +0000`;
  try {
    return await buildJob(opts);
  } finally {
    if (before === undefined) delete process.env.GIT_COMMITTER_DATE;
    else process.env.GIT_COMMITTER_DATE = before;
  }
}

async function buildJob(opts: { local?: boolean }): Promise<Job> {
  counter += 1;
  const remote = join(root, `remote-${counter}.git`);
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  const repo = join(root, `repo-${counter}`);
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  if (!opts.local) {
    git(repo, 'remote', 'add', 'origin', remote);
    git(repo, 'config', 'remote.origin.pushurl', PUSH_URL);
  }
  commit(repo, 'a.txt', 'chore: start');
  if (!opts.local) git(repo, 'push', '-q', remote, 'main');
  const branch = `feat/job-${counter}`;
  git(repo, 'branch', branch, 'main');

  const slug = `cleanup-${counter}`;
  dbApi.upsertProject(slug, { cwd: repo });
  if (!opts.local) updateProjectIntegration(slug, { mode: 'pr', account: 'ai-bot', remote_url: PUSH_URL });
  const agent = `cleanup-agent-${counter}`;
  mkdirSync(agentDir(agent), { recursive: true });
  writeFileSync(agentConfig(agent), JSON.stringify({ cwd: repo, project: slug }));

  const series = `series-${randomUUID()}`;
  dbApi.createMission(series, agent, 'job');
  const mode = opts.local ? 'branch' : 'pr';
  const row = dbApi.recordIntegration({
    repo, branch, remote: opts.local ? '' : 'origin', target: 'main', mode, project: slug, seriesId: series,
  });

  // The code task, merged into the branch from its worktree.
  const id = randomUUID();
  dbApi.createTask(id, 'feature', agent, {
    type: 'code', project: slug, baseBranch: branch, integrationMode: mode, baseRef: opts.local ? 'main' : 'origin/main',
    seriesId: series, creatorMissionId: series,
  });
  const info = await createWorktree(id, repo, branch);
  dbApi.setTaskWorktree(id, info.path, info.branch, info.base);
  const taskTip = commit(info.path, `t-${counter}.txt`, 'feat(t): task work');
  git(repo, 'update-ref', `refs/heads/${branch}`, taskTip);
  db.prepare(`UPDATE tasks SET status = 'DONE', merged_commit_sha = ?, updated_at = ? WHERE id = ?`).run(taskTip, LONG_AGO, id);

  // The pilot's own commit, from its detached worktree, moved by reference.
  const pilot = join(pilots, series);
  git(repo, 'worktree', 'add', '-q', '--detach', '--', pilot, `refs/heads/${branch}`);
  commit(pilot, `p-${counter}.txt`, 'feat(p): pilot work');
  git(pilot, 'push', '-q', '.', `HEAD:refs/heads/${branch}`);
  const head = git(repo, 'rev-parse', branch);

  const forgeSide = join(root, `forge-${counter}`);
  if (!opts.local) {
    git(repo, 'push', '-q', remote, `refs/heads/${branch}:refs/heads/${branch}`);
    dbApi.markIntegrationOpen(row.id, { number: counter, url: `https://github.com/acme/app/pull/${counter}`, headSha: head });
    execFileSync('git', ['clone', '-q', remote, forgeSide]);
  }
  return {
    repo, remote, forgeSide, slug, agent, branch, head, series, pilot,
    task: { id, path: info.path, branch: info.branch }, row: dbApi.getIntegrationById(row.id)!,
  };
}

/** The merge button, then the poller's fetch of the target. */
export function mergeOnForge(job: Job, how: 'merge' | 'squash' = 'merge'): void {
  git(job.forgeSide, 'fetch', '-q', 'origin');
  if (how === 'merge') git(job.forgeSide, 'merge', '-q', '--no-ff', '-m', 'Merge pull request', `origin/${job.branch}`);
  else {
    git(job.forgeSide, 'merge', '-q', '--squash', `origin/${job.branch}`);
    git(job.forgeSide, 'commit', '-q', '-m', 'Squashed pull request');
  }
  git(job.forgeSide, 'push', '-q', 'origin', 'main');
  git(job.repo, 'fetch', '-q', job.remote, 'refs/heads/main:refs/remotes/origin/main');
}

/** A local landing: the branch merged into `main` of the repository itself. */
export function mergeLocally(job: Job): void {
  git(job.repo, 'merge', '-q', '--no-ff', '-m', 'merge: land the job', job.branch);
}

export function land(job: Job, mergeSha: string | null = null): IntegrationRow {
  dbApi.markIntegrationMerged(job.row.id, mergeSha);
  assert.ok(dbApi.claimIntegrationLanding(job.row.id));
  return dbApi.getIntegrationById(job.row.id)!;
}

/** Plain git, the push URL replaced by the bare repository playing the remote. */
export function remoteGit(job: Job): GitRunner {
  return async (args) => {
    const mapped = args.map((a) => (a === PUSH_URL ? job.remote : a));
    try {
      return { code: 0, stdout: execFileSync('git', mapped, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), stderr: '' };
    } catch (err) {
      const e = err as { status?: number; stderr?: string };
      return { code: e.status ?? 1, stdout: '', stderr: String(e.stderr ?? '') };
    }
  };
}

/** The forge's account, as `gh api user` answers it. */
export const comments: ForgeCommentWriter = {
  login: async () => ({ ok: true, login: 'AI-Bot' }),
  findIssueComment: async () => ({ ok: true, comment: null }),
  postIssueComment: async () => { throw new Error('the cleanup never comments'); },
};

export function proposalDeps(job: Job): RemoteDeletionDeps {
  return { forge: () => comments, runners: { git: remoteGit(job) } };
}

/** What a pass reaches: the pilots' folder, no grace, the stand-in remote. */
export function deps(job: Job, over: Partial<CleanupDeps> = {}): CleanupDeps {
  return { seriesWorktreesRoot: pilots, graceMs: 0, proposals: proposalDeps(job), ...over };
}

export const remoteHas = (job: Job, branch: string): boolean =>
  execFileSync('git', ['ls-remote', '--heads', job.remote, `refs/heads/${branch}`], { encoding: 'utf8' }).trim() !== '';

export async function landedJob(): Promise<{ job: Job; row: IntegrationRow }> {
  const job = await prJob();
  mergeOnForge(job);
  const row = land(job);
  dbApi.finishMission(job.series, 'completed', 0);
  return { job, row };
}

export function pilotKept(job: Job): void {
  assert.equal(existsSync(join(job.pilot, '.git')), true, 'the pilot worktree stays');
}

export function branchKept(job: Job): void {
  assert.equal(has(job.repo, `refs/heads/${job.branch}`), true, 'the job\'s branch stays');
}

/** The task worktrees are the worktree GC's: the cleanup never touches them. */
export function taskUntouched(job: Job): void {
  assert.equal(existsSync(join(job.task.path, '.git')), true, 'the task worktree stays');
  assert.equal(dbApi.getTask(job.task.id)?.worktree_path, job.task.path, 'its link in the database stays');
  assert.equal(has(job.repo, `refs/heads/${job.task.branch}`), true, 'its branch stays');
}
