/**
 * An imported idea lands when a contributor's MERGED pull request closed its
 * issue, on GitHub's word, and on nothing less: an issue closed by hand, as
 * not planned, by an unmerged pull request, by another repository's or by
 * one of our own jobs leaves the idea as it is. The forge is a fake.
 */
import './test-home.js';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, test } from 'node:test';
import { dbApi } from './db.js';
import { landContributorClosings, landedByPull, type ContributorLandingDeps } from './contributor-landing.js';
import { issueStatesQuery, parseIssueStates, type IssueStateRead } from './host/forge.js';

const home = realpathSync(mkdtempSync(join(tmpdir(), 'timon-contributor-landing-')));
after(() => rmSync(home, { recursive: true, force: true }));

dbApi.upsertProject('acme', { cwd: join(home, 'acme') });
dbApi.setProjectIntegration('acme', JSON.stringify({
  mode: 'pr', remote: 'origin', target: 'main', forge: 'github', account: 'ai-bot',
  gh_config_dir: null, branch_prefix: 'feat/', remote_url: 'https://github.com/acme/widgets.git',
}));
dbApi.upsertProject('local', { cwd: join(home, 'local') });

let states: IssueStateRead[] = [];
const asked: Array<{ repo: string; numbers: number[] }> = [];
const deps: ContributorLandingDeps = {
  forge: () => ({
    issueStates: async (repo, numbers) => {
      asked.push({ repo, numbers: [...numbers] });
      return { ok: true, issues: states.filter((s) => numbers.includes(s.number)) };
    },
  }),
};

beforeEach(() => {
  states = [];
  asked.length = 0;
});

function idea(project: string | null, ref: string): number {
  const id = dbApi.insertProjectTodo({ text: `idea ${ref}`, project, ownerUserId: 'user-ada' }).id;
  dbApi.putTodoExternalRef({
    todoId: id, provider: 'github', ref, url: `https://github.com/${ref.replace('#', '/issues/')}`, label: null, pluginId: 'github-issues',
  });
  return id;
}

const closedBy = (number: number, pull: number, extra: Partial<IssueStateRead> = {}, merged = true, repo = 'acme/widgets'): IssueStateRead => ({
  number, state: 'closed', stateReason: 'completed', closedBy: { number: pull, url: `https://github.com/${repo}/pull/${pull}`, merged, repo }, ...extra,
});

test('a contributor\'s merged pull request that closed the issue lands its idea, once', async () => {
  const id = idea('acme', 'acme/widgets#10');
  states = [closedBy(10, 501)];
  const landed = await landContributorClosings(deps);
  assert.deepEqual(landed, [{ todoId: id, project: 'acme', issue: 10, pull: 501 }]);
  const row = dbApi.getProjectTodo(id)!;
  assert.deepEqual([row.status, row.progress], ['done', 'done']);
  assert.deepEqual(await landContributorClosings(deps), [], 'a done idea is not read again');
});

test('anything short of a merged pull request of the repository leaves the idea open', async () => {
  const cases: Array<[string, IssueStateRead]> = [
    ['acme/widgets#20', { number: 20, state: 'open', stateReason: null, closedBy: null }],
    ['acme/widgets#21', { number: 21, state: 'closed', stateReason: 'completed', closedBy: null }],
    ['acme/widgets#22', closedBy(22, 502, { stateReason: 'not_planned' })],
    ['acme/widgets#23', closedBy(23, 503, {}, false)],
    ['acme/widgets#24', closedBy(24, 504, {}, true, 'other/fork')],
  ];
  const ids = cases.map(([ref]) => idea('acme', ref));
  states = cases.map(([, s]) => s);
  assert.deepEqual(await landContributorClosings(deps), []);
  for (const id of ids) assert.equal(dbApi.getProjectTodo(id)!.status, 'open');
});

test('our own job\'s pull request, a promoted idea, another repository or a project without pull requests are left alone', async () => {
  const ours = idea('acme', 'acme/widgets#30');
  dbApi.recordIntegration({ repo: home, branch: 'feat/ours', remote: 'origin', target: 'main', mode: 'pr', project: 'acme' });
  const row = dbApi.getIntegration(home, 'feat/ours')!;
  dbApi.markIntegrationOpen(row.id, { number: 600, url: 'https://github.com/acme/widgets/pull/600', headSha: 'a'.repeat(40) });
  const promoted = idea('acme', 'acme/widgets#31');
  dbApi.updateProjectTodo(promoted, { status: 'promoted' });
  const elsewhere = idea('acme', 'other/repo#32');
  const local = idea('local', 'acme/widgets#33');
  states = [closedBy(30, 600), closedBy(31, 601), closedBy(32, 602), closedBy(33, 603)];
  assert.deepEqual(await landContributorClosings(deps), []);
  for (const id of [ours, elsewhere, local]) assert.equal(dbApi.getProjectTodo(id)!.status, 'open');
  assert.equal(dbApi.getProjectTodo(promoted)!.status, 'promoted');
  assert.deepEqual(asked.map((a) => [a.repo, a.numbers.includes(32), a.numbers.includes(31)]), [['acme/widgets', false, false]],
    'one read for the project repository, only the issues worth reading');
});

test('a state read: aliased numbers, a closer that is a pull request, an alias the forge could not resolve left out', () => {
  assert.match(issueStatesQuery([7, 9]), /i7: issue\(number: 7\).*i9: issue\(number: 9\)/s);
  const answer = JSON.stringify({
    data: {
      repository: {
        i7: {
          number: 7, state: 'CLOSED', stateReason: 'COMPLETED',
          timelineItems: { nodes: [{ closer: { __typename: 'PullRequest', number: 12, url: 'https://github.com/acme/widgets/pull/12', merged: true, repository: { nameWithOwner: 'acme/widgets' } } }] },
        },
        i8: { number: 8, state: 'CLOSED', stateReason: 'COMPLETED', timelineItems: { nodes: [{ closer: { __typename: 'Commit' } }] } },
        i9: null,
      },
    },
  });
  const read = parseIssueStates(answer)!;
  assert.deepEqual(read, [
    { number: 7, state: 'closed', stateReason: 'completed', closedBy: { number: 12, url: 'https://github.com/acme/widgets/pull/12', merged: true, repo: 'acme/widgets' } },
    { number: 8, state: 'closed', stateReason: 'completed', closedBy: null },
  ]);
  assert.equal(landedByPull(read[0]!, 'ACME/Widgets'), true);
  assert.equal(landedByPull(read[1]!, 'acme/widgets'), false, 'closed by a commit: not a contributor\'s pull request');
  assert.equal(parseIssueStates('{"errors":[]}'), null);
});
