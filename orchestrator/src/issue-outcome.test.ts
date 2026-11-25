/**
 * An idea imported from a GitHub issue, resolved without a fix: the answer to
 * the issue and, for a declined or duplicated one, its closing are PROPOSED,
 * apart, and reach GitHub only when a person publishes them. The forge is a
 * fake: nothing here reaches GitHub.
 */
import './test-home.js';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, test } from 'node:test';
import { bus, type TodoResolvedSnapshot } from './bus.js';
import { db, dbApi } from './db.js';
import {
  discardForgeProposal, editForgeProposal, getForgeProposal, getForgeProposalByKey, publishForgeProposal,
  type ForgeProposalDeps,
} from './forge-proposals.js';
import type { ForgeCommentWriter, ForgeIssueCloser, IssueCloseReason, IssueDetails } from './host/forge.js';
import { closeText, issueCloseKey } from './issue-close.js';
import { outcomeComment, outcomeKey, proposeIssueOutcome, watchIssueOutcomes } from './issue-outcome.js';
import { TODO_OUTCOME_DDL } from './todo-outcome-migration.js';

const home = realpathSync(mkdtempSync(join(tmpdir(), 'timon-issue-outcome-')));
after(() => rmSync(home, { recursive: true, force: true }));
db.exec(TODO_OUTCOME_DDL);

dbApi.upsertProject('acme', { cwd: join(home, 'acme') });
dbApi.setProjectIntegration('acme', JSON.stringify({
  mode: 'pr', remote: 'origin', target: 'main', forge: 'github', account: 'ai-bot',
  gh_config_dir: null, branch_prefix: 'feat/', remote_url: 'https://github.com/acme/widgets.git',
}));
dbApi.upsertProject('local', { cwd: join(home, 'local') });

let issueState: 'open' | 'closed' = 'open';
const closes: Array<{ repo: string; number: number; reason: IssueCloseReason }> = [];
const posted: Array<{ number: number; body: string }> = [];

const details = (number: number): IssueDetails => ({
  number, title: 'Crash', author: 'outsider', url: `https://github.com/acme/widgets/issues/${number}`, state: issueState,
  labels: [], createdAt: '', updatedAt: '', body: '', bodyTruncated: false, stateReason: null,
});
const fakeIssues: ForgeIssueCloser = {
  login: async () => ({ ok: true, login: 'ai-bot' }),
  listIssues: async () => ({ ok: true, issues: [] }),
  issueDetails: async (_repo, number) => ({ ok: true, issue: details(number) }),
  closeIssue: async (repo, number, reason) => {
    closes.push({ repo, number, reason });
    return { ok: true, url: `https://github.com/${repo}/issues/${number}`, reason };
  },
};
const fakeComments: ForgeCommentWriter = {
  login: async () => ({ ok: true, login: 'ai-bot' }),
  findIssueComment: async () => ({ ok: true, comment: null }),
  postIssueComment: async (_repo, number, body) => {
    posted.push({ number, body });
    return { ok: true, comment: { id: 1, url: `https://github.com/acme/widgets/issues/${number}#issuecomment-1` } };
  },
};
const deps: ForgeProposalDeps = { forge: () => fakeComments, issueForge: () => fakeIssues };

beforeEach(() => {
  issueState = 'open';
  closes.length = 0;
  posted.length = 0;
});

/** An idea of `project` linked to `refs` (`owner/repo#n`), with its outcome. */
function resolvedIdea(project: string | null, refs: string[], resolution: string, note: string | null = null): TodoResolvedSnapshot {
  const id = dbApi.insertProjectTodo({ text: 'imported idea', project, ownerUserId: 'user-ada' }).id;
  for (const ref of refs) {
    dbApi.putTodoExternalRef({
      todoId: id, provider: 'github', ref, url: `https://github.com/${ref.replace('#', '/issues/')}`, label: null, pluginId: 'github-issues',
    });
  }
  db.prepare(`INSERT INTO todo_outcome (todo_id, resolution, public_note, duplicate_of, updated_at) VALUES (?, ?, ?, NULL, 1)`)
    .run(id, resolution, note);
  return Object.freeze({ id, text: 'imported idea', project, resolution, public_note: note, duplicate_of: null, owner_user_id: 'user-ada' });
}

test('a declined idea proposes the answer and, apart, the closing as not planned; nothing reaches GitHub', () => {
  const todo = resolvedIdea('acme', ['acme/widgets#12', 'other/repo#3'], 'declined', 'Out of scope, see @maintainer.');
  assert.deepEqual(proposeIssueOutcome(todo, deps), { comments: 1, closes: 1 }, 'only the project repository is answered');
  const comment = getForgeProposalByKey('acme', outcomeKey(todo.id, 12, 'declined'))!;
  assert.deepEqual([comment.kind, comment.target_number, comment.trigger, comment.state, comment.created_by], ['comment', 12, 'todo_resolved', 'draft', null]);
  assert.equal(comment.body, 'Thank you for this report. We decided not to take it on:\n\nOut of scope, see `@maintainer`.');
  const close = getForgeProposalByKey('acme', issueCloseKey(todo.id, 12))!;
  assert.deepEqual([close.kind, close.target_number, close.state, JSON.parse(close.payload!).reason], ['close_issue', 12, 'draft', 'not_planned']);
  assert.equal(close.body, closeText(12, 'not_planned'));
  assert.deepEqual([closes.length, posted.length], [0, 0]);

  assert.deepEqual(proposeIssueOutcome(todo, deps), { comments: 0, closes: 0 }, 'one proposal per key');
});

test('a duplicate closes as a duplicate; needs_info only answers; fixed and planned propose nothing here', () => {
  const dup = resolvedIdea('acme', ['acme/widgets#20'], 'duplicate');
  assert.deepEqual(proposeIssueOutcome(dup, deps), { comments: 1, closes: 1 });
  assert.equal(JSON.parse(getForgeProposalByKey('acme', issueCloseKey(dup.id, 20))!.payload!).reason, 'duplicate');
  assert.equal(getForgeProposalByKey('acme', outcomeKey(dup.id, 20, 'duplicate'))!.body, outcomeComment('duplicate', null));

  const info = resolvedIdea('acme', ['acme/widgets#21'], 'needs_info');
  assert.deepEqual(proposeIssueOutcome(info, deps), { comments: 1, closes: 0 });
  assert.equal(getForgeProposalByKey('acme', issueCloseKey(info.id, 21)), undefined);

  for (const resolution of ['fixed', 'planned', 'in_progress']) {
    assert.deepEqual(proposeIssueOutcome(resolvedIdea('acme', ['acme/widgets#22'], resolution), deps), { comments: 0, closes: 0 }, resolution);
  }
});

test('an idea without a project, or in a project that does not open pull requests, proposes nothing', () => {
  assert.deepEqual(proposeIssueOutcome(resolvedIdea(null, ['acme/widgets#30'], 'declined'), deps), { comments: 0, closes: 0 });
  assert.deepEqual(proposeIssueOutcome(resolvedIdea('local', ['acme/widgets#31'], 'declined'), deps), { comments: 0, closes: 0 });
});

test('publishing the closing closes the issue once, with its reason; an issue closed already is left as it is', async () => {
  const todo = resolvedIdea('acme', ['acme/widgets#40'], 'declined');
  proposeIssueOutcome(todo, deps);
  const close = getForgeProposalByKey('acme', issueCloseKey(todo.id, 40))!;
  assert.equal(getForgeProposal('acme', close.id)!.body, close.body, 'no text to rewrite');
  const edit = editForgeProposal('acme', close.id, 'Something else', 'user-ada', deps);
  assert.equal(edit.ok, false, 'a closing has no text to edit');

  const out = await publishForgeProposal('acme', close.id, 'user-ada', undefined, deps);
  assert.equal(out.ok, true);
  assert.deepEqual(closes, [{ repo: 'acme/widgets', number: 40, reason: 'not_planned' }]);
  assert.equal(posted.length, 0, 'closing posts no comment');
  assert.equal(getForgeProposal('acme', close.id)!.state, 'published');

  const again = await publishForgeProposal('acme', close.id, 'user-ada', undefined, deps);
  assert.equal(again.ok && again.already, true);
  assert.equal(closes.length, 1);

  const dup = resolvedIdea('acme', ['acme/widgets#41'], 'duplicate');
  proposeIssueOutcome(dup, deps);
  issueState = 'closed';
  const closed = await publishForgeProposal('acme', getForgeProposalByKey('acme', issueCloseKey(dup.id, 41))!.id, 'user-ada', undefined, deps);
  assert.equal(closed.ok && closed.already, true);
  assert.equal(closes.length, 1, 'nothing written on an issue closed already');
});

test('a closing left open: the person discards it and the issue stays as it is', () => {
  const todo = resolvedIdea('acme', ['acme/widgets#45'], 'declined');
  proposeIssueOutcome(todo, deps);
  const close = getForgeProposalByKey('acme', issueCloseKey(todo.id, 45))!;
  assert.equal(discardForgeProposal('acme', close.id, 'user-ada', deps).ok, true);
  assert.deepEqual(proposeIssueOutcome(todo, deps), { comments: 0, closes: 0 }, 'a discarded proposal is not made again');
  assert.equal(closes.length, 0);
});

test('the answer follows the public note until a person edits it', () => {
  const todo = resolvedIdea('acme', ['acme/widgets#50'], 'needs_info');
  proposeIssueOutcome(todo, deps);
  const draft = getForgeProposalByKey('acme', outcomeKey(todo.id, 50, 'needs_info'))!;
  assert.equal(draft.body, outcomeComment('needs_info', null));
  db.prepare(`UPDATE todo_outcome SET public_note = 'Which version?' WHERE todo_id = ?`).run(todo.id);
  assert.equal(getForgeProposal('acme', draft.id)!.body, 'Thank you for this report. We need a little more to move on:\n\nWhich version?');
  assert.equal(editForgeProposal('acme', draft.id, 'Mine.', 'user-ada', deps).ok, true);
  db.prepare(`UPDATE todo_outcome SET public_note = 'Later' WHERE todo_id = ?`).run(todo.id);
  assert.equal(getForgeProposal('acme', draft.id)!.body, 'Mine.');
});

test('the event of a resolved idea prepares the proposals, out of the write', async () => {
  const stop = watchIssueOutcomes(deps);
  try {
    const todo = resolvedIdea('acme', ['acme/widgets#60'], 'declined');
    bus.publish({ kind: 'todo_resolved', todoId: todo.id, previousResolution: null, todo });
    assert.equal(getForgeProposalByKey('acme', outcomeKey(todo.id, 60, 'declined')), undefined, 'not inside the publish');
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(getForgeProposalByKey('acme', outcomeKey(todo.id, 60, 'declined')));
    assert.ok(getForgeProposalByKey('acme', issueCloseKey(todo.id, 60)));
  } finally {
    stop();
  }
});
