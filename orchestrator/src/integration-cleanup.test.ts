/**
 * What a concluded job leaves behind (`docs/KANBAN-PR-PIPELINE.md` §2.7): once
 * its integration lands, its tasks' worktrees, its pilot's worktree, its
 * branch and (when asked) its remote copy go, once; nothing goes while a task
 * of the job is open or its pilot runs, nor what did not land.
 *
 * Real throwaway repositories: a bare one plays the remote, a clone plays the
 * merge button. `gh` is a stand-in: nothing here reaches a forge.
 */
import './test-home.js';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { db, dbApi, type IntegrationRow } from './db.js';
import { deleteRemoteBranch, type GitRunner, type GitTransport } from './host/forge.js';
import { cleanConcludedIntegrations, cleanIntegration, type CleanupDeps } from './integration-cleanup.js';
import { agentConfig, agentDir } from './paths.js';
import { updateProjectIntegration } from './project-integration.js';
import { createWorktree } from './worktree.js';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'timon-integration-cleanup-')));
after(() => rmSync(root, { recursive: true, force: true }));
const pilots = join(root, 'series-worktrees');
mkdirSync(pilots, { recursive: true });

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=Acme Bot', '-c', 'user.email=bot@acme.test', '-c', 'commit.gpgsign=false', ...args], {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function commit(cwd: string, file: string, message: string): string {
  writeFileSync(join(cwd, file), `${message}\n`);
  git(cwd, 'add', file);
  git(cwd, 'commit', '-q', '-m', message);
  return git(cwd, 'rev-parse', 'HEAD');
}

function has(repo: string, ref: string): boolean {
  try { git(repo, 'rev-parse', '--verify', '--quiet', ref); return true; } catch { return false; }
}

const LONG_AGO = Date.now() - 24 * 3600_000;
const PUSH_URL = 'git@github.com:acme/app.git';

/** Plain git for the stand-ins: the host adapter refuses a remote that is a
 *  local folder a mission could write, which a throwaway remote is. */
const plainGit: GitRunner = async (args) => {
  try {
    return { code: 0, stdout: execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), stderr: '' };
  } catch (err) {
    const e = err as { status?: number; stderr?: string };
    return { code: e.status ?? 1, stdout: '', stderr: String(e.stderr ?? '') };
  }
};

type Job = {
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
async function prJob(opts: { local?: boolean } = {}): Promise<Job> {
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
  if (!opts.local) {
    updateProjectIntegration(slug, { mode: 'pr', account: 'ai-bot', remote_url: PUSH_URL, delete_remote_branch: true });
  }
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
function mergeOnForge(job: Job): void {
  git(job.forgeSide, 'fetch', '-q', 'origin');
  git(job.forgeSide, 'merge', '-q', '--no-ff', '-m', 'Merge pull request', `origin/${job.branch}`);
  git(job.forgeSide, 'push', '-q', 'origin', 'main');
  git(job.repo, 'fetch', '-q', job.remote, 'refs/heads/main:refs/remotes/origin/main');
}

function land(job: Job, mergeSha: string | null = null): IntegrationRow {
  dbApi.markIntegrationMerged(job.row.id, mergeSha);
  assert.ok(dbApi.claimIntegrationLanding(job.row.id));
  return dbApi.getIntegrationById(job.row.id)!;
}

let logins: number;
let deletions: Array<{ url: string; branch: string; sha: string }>;

/** The forge's account and the remote, played by the bare repository. */
function deps(job: Job, over: Partial<CleanupDeps> = {}): CleanupDeps {
  logins = 0;
  deletions = [];
  const transport = (): GitTransport => ({
    remoteBranchSha: async (_url, branch) => {
      const out = execFileSync('git', ['ls-remote', '--heads', job.remote, `refs/heads/${branch}`], { encoding: 'utf8' }).trim();
      return { ok: true, sha: out ? out.split('\t')[0]! : null };
    },
    fetchBranch: async () => { throw new Error('the cleanup never fetches'); },
    pushBranch: async () => { throw new Error('the cleanup never pushes'); },
  });
  return {
    forge: () => ({ login: async () => { logins += 1; return { ok: true, login: 'AI-Bot' }; } }),
    transport,
    // The real deletion, leased, against the bare remote instead of the forge.
    deleteRemote: (repo, url, branch, sha) => {
      deletions.push({ url, branch, sha });
      return deleteRemoteBranch(repo, job.remote, branch, sha, { git: plainGit });
    },
    seriesWorktreesRoot: pilots,
    graceMs: 0,
    ...over,
  };
}

const remoteHas = (job: Job, branch: string): boolean =>
  execFileSync('git', ['ls-remote', '--heads', job.remote, `refs/heads/${branch}`], { encoding: 'utf8' }).trim() !== '';

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
  assert.deepEqual(deletions, [{ url: PUSH_URL, branch: job.branch, sha: job.head }], 'leased on the merged head');
  assert.equal(logins, 1, 'the account is checked before the deletion');
  assert.ok(dbApi.getIntegrationById(job.row.id)?.cleaned_at);
  assert.equal(has(job.repo, 'refs/heads/main'), true, 'the target is untouched');

  // A second pass finds nothing to do.
  const again = await cleanConcludedIntegrations(deps(job));
  assert.equal(again.has(job.row.id), false);
  assert.equal(logins, 0);
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
  const extra = join(root, `extra-${counter}`);
  git(job.repo, 'worktree', 'add', '-q', '--detach', '--', extra, `refs/heads/${job.branch}`);
  commit(extra, 'late.txt', 'fix: late change');
  git(extra, 'push', '-q', '.', `HEAD:refs/heads/${job.branch}`);
  git(job.repo, 'push', '-q', job.remote, `refs/heads/${job.branch}:refs/heads/${job.branch}`);
  git(job.repo, 'worktree', 'remove', extra);
  // And a change the pilot never committed.
  writeFileSync(join(job.pilot, 'p-' + counter + '.txt'), 'edited\n');

  assert.equal(await cleanIntegration(row, deps(job)), 'cleaned');
  assert.equal(existsSync(job.task.path), false, 'the task worktree, whose work is in the branch, goes');
  assert.equal(has(job.repo, `refs/heads/${job.branch}`), true, 'the branch holds work main does not');
  assert.equal(remoteHas(job, job.branch), true, 'the remote copy moved since: never deleted');
  assert.equal(deletions.length, 0);
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
  assert.equal(logins, 0, 'the forge is not even asked');

  const gone = await prJob();
  mergeOnForge(gone);
  dbApi.finishMission(gone.series, 'completed', 0);
  git(gone.forgeSide, 'push', '-q', 'origin', `:refs/heads/${gone.branch}`);
  assert.equal(await cleanIntegration(land(gone), deps(gone)), 'cleaned');
  assert.equal(deletions.length, 0);
});

test('a wrong account waits, and deletes nothing', async () => {
  const job = await prJob();
  mergeOnForge(job);
  dbApi.finishMission(job.series, 'completed', 0);
  const row = land(job);
  const out = await cleanIntegration(row, deps(job, { forge: () => ({ login: async () => ({ ok: true, login: 'someone-else' }) }) }));
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
  assert.equal(logins, 0, 'no forge for a local job');
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
