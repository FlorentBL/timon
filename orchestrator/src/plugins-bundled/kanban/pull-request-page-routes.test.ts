/**
 * The page of one pull request and the end of a failed check's log: who may
 * read them, what reaches the forge (reads only, never git), and the short
 * cache that keeps a window opened twice from starting gh twice, and the
 * account gh signs in as, checked before any read.
 */
import '../../test-home.js';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, mock, test } from 'node:test';
import express from 'express';
import { bus } from '../../bus.js';
import { dbApi } from '../../db.js';
import { getHost } from '../../host/index.js';
import { ghCredentialsStamp, type GhLoginOutcome } from '../../host/gh.js';
import type { ExecOpts, ExecResult } from '../../host/types.js';
import { ACCOUNT_CHECK_MS, forgetPullRequestPages, PAGE_CACHE_MS, watchPullRequestPages } from '../../pull-request-page.js';
import { registerExternalPrRoutes } from './external-pr-routes.js';

const home = realpathSync(mkdtempSync(join(tmpdir(), 'timon-pr-page-')));
mkdirSync(join(home, 'code', 'acme'), { recursive: true });
dbApi.upsertProject('acme', { cwd: join(home, 'code', 'acme') });
dbApi.upsertProject('solo', { cwd: join(home, 'code', 'solo') });
dbApi.setProjectIntegration('acme', JSON.stringify({
  mode: 'pr', remote: 'origin', target: 'main', forge: 'github', account: 'ai-bot',
  gh_config_dir: null, branch_prefix: 'feat/', remote_url: 'git@github.com:acme/widgets.git',
}));
// Its own gh config folder, whose active account a test switches.
const ghDir = join(home, 'gh-switch');
mkdirSync(ghDir, { recursive: true });
// File storage: the active token is written under the host (a placeholder,
// never a token). Without that key gh reads it from the keyring.
const hostsFile = (user: string, storage: 'file' | 'keyring' = 'file') =>
  `github.com:\n    users:\n        ai-bot:\n        someone-else:\n${storage === 'file' ? '    oauth_token: in-file\n' : ''}    user: ${user}\n`;
dbApi.upsertProject('switch', { cwd: join(home, 'code', 'switch') });
dbApi.setProjectIntegration('switch', JSON.stringify({
  mode: 'pr', remote: 'origin', target: 'main', forge: 'github', account: 'ai-bot',
  gh_config_dir: ghDir, branch_prefix: 'feat/', remote_url: 'git@github.com:acme/widgets.git',
}));
// Stored before an account was required: its reads run as they always did.
dbApi.upsertProject('open', { cwd: join(home, 'code', 'open') });
dbApi.setProjectIntegration('open', JSON.stringify({
  mode: 'pr', remote: 'origin', target: 'main', forge: 'github', account: null,
  gh_config_dir: null, branch_prefix: 'feat/', remote_url: 'git@github.com:acme/widgets.git',
}));

const PAGE = {
  number: 12, title: 'Add a dark theme', url: 'https://github.com/acme/widgets/pull/12', state: 'OPEN', isDraft: false,
  author: { login: 'stranger' }, createdAt: '2026-11-17T10:00:00Z', updatedAt: '2026-11-18T09:30:00Z',
  baseRefName: 'main', headRefName: 'dark-theme', headRefOid: 'a'.repeat(40),
  headRepository: { name: 'widgets' }, headRepositoryOwner: { login: 'stranger' }, isCrossRepository: true,
  mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', reviewDecision: null,
  body: 'Hello ghp_abcdefghijklmnopqrstuvwxyz0123', comments: [], reviews: [], commits: [], files: [],
  statusCheckRollup: [],
};
const THREADS = { data: { repository: { pullRequest: { reviewThreads: { totalCount: 0, nodes: [] } } } } };
const EVENTS = { data: { repository: { pullRequest: { timelineItems: { totalCount: 1, nodes: [
  { __typename: 'LabeledEvent', createdAt: '2026-11-17T11:00:00Z', actor: { login: 'maintainer' }, label: { name: 'ui', color: 'a2eeef' } },
] } } } } };

type Call = { name: string; args: string[] };
const calls: Call[] = [];
let threadsFail = false;
let eventsFail = false;
let updatedAt = PAGE.updatedAt;

mock.method(getHost(), 'execAsync', async (name: string, args: string[], _opts: ExecOpts = {}): Promise<ExecResult> => {
  calls.push({ name, args });
  if (name !== 'gh') return { code: 1, stdout: '', stderr: 'no process in this test' };
  if (args[0] === 'pr' && args[1] === 'view') return { code: 0, stdout: JSON.stringify({ ...PAGE, updatedAt }), stderr: '' };
  if (args[0] === 'api' && args[1] === 'graphql' && args.some((a) => a.includes('timelineItems'))) {
    return eventsFail ? { code: 1, stdout: '', stderr: 'HTTP 502' } : { code: 0, stdout: JSON.stringify(EVENTS), stderr: '' };
  }
  if (args[0] === 'api' && args[1] === 'graphql') {
    return threadsFail ? { code: 1, stdout: '', stderr: 'HTTP 502' } : { code: 0, stdout: JSON.stringify(THREADS), stderr: '' };
  }
  if (args[0] === 'run' && args[1] === 'view') return { code: 0, stdout: 'step\nError: boom\n', stderr: '' };
  return { code: 1, stdout: '', stderr: 'unexpected gh call' };
});

const app = express();
app.use(express.json());
// Stand-in for the daemon's auth middleware: no header = anonymous.
app.use((req, _res, next) => {
  const who = req.header('x-test-who');
  if (who === 'manager') req.auth = { kind: 'api-token', user: null, isSuperadmin: false, permissions: ['projects:manage'] };
  else if (who === 'reader') req.auth = { kind: 'api-token', user: null, isSuperadmin: false, permissions: ['projects:read'] };
  next();
});
let clock = 1_000_000;
const loginCalls: Array<string | null> = [];
let loginAnswer: GhLoginOutcome = { ok: true, login: 'AI-Bot' };
// The default folder is the machine's own: its stamp is set here; a named
// folder is stamped for real.
let defaultStamp: string | null = 'stamp-1';
registerExternalPrRoutes(app, {
  now: () => clock,
  ghLogin: async (dir) => { loginCalls.push(dir); return loginAnswer; },
  credentialsStamp: (dir) => (dir ? ghCredentialsStamp(dir) : defaultStamp),
});
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const stopWatching = watchPullRequestPages();
after(() => { stopWatching(); server.close(); });
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

function get(path: string, who: 'anonymous' | 'reader' | 'manager') {
  return fetch(`${base}${path}`, { headers: who === 'anonymous' ? {} : { 'x-test-who': who } });
}

const PAGE_URL = '/api/projects/acme/pull-requests/12';
const LOG_URL = `${PAGE_URL}/check-log?url=${encodeURIComponent('https://github.com/acme/widgets/actions/runs/1/job/2')}`;

beforeEach(() => {
  calls.length = 0;
  loginCalls.length = 0;
  loginAnswer = { ok: true, login: 'AI-Bot' };
  defaultStamp = 'stamp-1';
  writeFileSync(join(ghDir, 'hosts.yml'), hostsFile('ai-bot'));
  forgetPullRequestPages();
  threadsFail = false;
  eventsFail = false;
  updatedAt = PAGE.updatedAt;
});

test('an anonymous caller is refused, and gh never runs', async () => {
  assert.equal((await get(PAGE_URL, 'anonymous')).status, 401);
  assert.equal((await get(LOG_URL, 'anonymous')).status, 401);
  assert.deepEqual(calls, []);
  assert.deepEqual(loginCalls, []);
});

test('a caller without projects:manage is refused', async () => {
  assert.equal((await get(PAGE_URL, 'reader')).status, 403);
  assert.equal((await get(LOG_URL, 'reader')).status, 403);
  assert.deepEqual(calls, []);
});

test('a project that lands locally is refused clearly, without reaching the forge', async () => {
  const res = await get('/api/projects/solo/pull-requests/12', 'manager');
  assert.equal(res.status, 409);
  assert.equal(((await res.json()) as { code: string }).code, 'integration_not_pr');
  assert.equal((await get('/api/projects/ghost/pull-requests/12', 'manager')).status, 404);
  assert.deepEqual(calls, []);
});

test('bad parameters are refused before the forge', async () => {
  assert.equal((await get('/api/projects/acme/pull-requests/abc', 'manager')).status, 400);
  assert.equal((await get(`${PAGE_URL}?updated=yesterday`, 'manager')).status, 400);
  assert.equal((await get(`${PAGE_URL}/check-log?url=${encodeURIComponent('http://github.com/x')}`, 'manager')).status, 400);
  assert.equal((await get(`${PAGE_URL}/check-log`, 'manager')).status, 400);
  assert.deepEqual(calls, []);
});

test('the page is read from gh, reads only, without a token in it', async () => {
  const res = await get(PAGE_URL, 'manager');
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.doesNotMatch(text, /ghp_/);
  const body = JSON.parse(text) as { pull: { number: number; headRepository: string; threads: unknown[]; threadsError: string | null }; cached: boolean };
  assert.equal(body.pull.number, 12);
  assert.equal(body.pull.headRepository, 'stranger/widgets');
  assert.deepEqual(body.pull.threads, []);
  assert.equal(body.pull.threadsError, null);
  assert.equal(body.cached, false);
  assert.deepEqual(calls.map((c) => [c.name, c.args[0], c.args[1]]).sort(), [['gh', 'api', 'graphql'], ['gh', 'api', 'graphql'], ['gh', 'pr', 'view']]);
});

test('the timeline events sit among the comments; their failing leaves the page', async () => {
  const body = await (await get(PAGE_URL, 'manager')).json() as { pull: { timeline: Array<{ kind: string }> } };
  assert.deepEqual(body.pull.timeline.map((e) => e.kind), ['labeled']);
  forgetPullRequestPages();
  eventsFail = true;
  const failed = await get(PAGE_URL, 'manager');
  assert.equal(failed.status, 200);
  assert.deepEqual(((await failed.json()) as { pull: { timeline: unknown[] } }).pull.timeline, []);
});

test('the threads failing leaves the rest of the page', async () => {
  threadsFail = true;
  const body = await (await get(PAGE_URL, 'manager')).json() as { pull: { title: string; threadsError: string | null } };
  assert.equal(body.pull.title, 'Add a dark theme');
  assert.ok(body.pull.threadsError);
});

test('a page read a moment ago is shown again without gh, until it ages or the pull request changed', async () => {
  await get(PAGE_URL, 'manager');
  assert.equal(calls.length, 3);
  const again = await (await get(PAGE_URL, 'manager')).json() as { cached: boolean };
  assert.equal(again.cached, true);
  assert.equal(calls.length, 3);
  // The list says the pull request changed since: read again.
  updatedAt = '2026-11-19T00:00:00Z';
  const changed = await (await get(`${PAGE_URL}?updated=${encodeURIComponent(updatedAt)}`, 'manager')).json() as { cached: boolean };
  assert.equal(changed.cached, false);
  assert.equal(calls.length, 6);
  // A fresh read asked for.
  await get(`${PAGE_URL}?fresh=1`, 'manager');
  assert.equal(calls.length, 9);
  // Aged out.
  clock += PAGE_CACHE_MS;
  await get(PAGE_URL, 'manager');
  assert.equal(calls.length, 12);
});

test('a job of the project that moves drops its pages', async () => {
  await get(PAGE_URL, 'manager');
  bus.publish({ kind: 'integration_changed', integrationId: 'x', project: 'acme', seriesId: null, state: 'open', changed: ['checks'] });
  const body = await (await get(PAGE_URL, 'manager')).json() as { cached: boolean };
  assert.equal(body.cached, false);
});

test('the end of a failed check\'s log comes from the repository\'s own CI only', async () => {
  const res = await get(LOG_URL, 'manager');
  assert.equal(res.status, 200);
  const body = await res.json() as { log: { tail: string } };
  assert.match(body.log.tail, /Error: boom/);
  assert.deepEqual(calls.at(-1)!.args.slice(0, 2), ['run', 'view']);
  const other = await get(`${PAGE_URL}/check-log?url=${encodeURIComponent('https://github.com/other/repo/actions/runs/1/job/2')}`, 'manager');
  assert.equal(other.status, 422);
  assert.equal(calls.length, 1);
});

test('gh signed in as another account than the project expects reads nothing, and says so without the login', async () => {
  loginAnswer = { ok: true, login: 'someone-else' };
  for (const url of [PAGE_URL, LOG_URL]) {
    const res = await get(url, 'manager');
    assert.equal(res.status, 409);
    const text = await res.text();
    assert.equal((JSON.parse(text) as { code: string }).code, 'forge_account_mismatch');
    assert.doesNotMatch(text, /someone-else/i);
  }
  assert.deepEqual(calls, []);
});

test('an account check that cannot run reads nothing', async () => {
  loginAnswer = { ok: false, code: 'gh_failed', reason: 'HTTP 401: Bad credentials' };
  const res = await get(PAGE_URL, 'manager');
  assert.equal(res.status, 502);
  assert.equal(((await res.json()) as { code: string }).code, 'forge_read_failed');
  assert.deepEqual(calls, []);
  // A failure is not kept: the next window asks again.
  loginAnswer = { ok: true, login: 'ai-bot' };
  assert.equal((await get(PAGE_URL, 'manager')).status, 200);
  assert.equal(loginCalls.length, 2);
});

test('the account is checked once a minute per config folder, not at every window', async () => {
  await get(`${PAGE_URL}?fresh=1`, 'manager');
  await get(`${PAGE_URL}?fresh=1`, 'manager');
  await get(LOG_URL, 'manager');
  assert.deepEqual(loginCalls, [null]);
  clock += ACCOUNT_CHECK_MS;
  await get(`${PAGE_URL}?fresh=1`, 'manager');
  assert.equal(loginCalls.length, 2);
});

test('once the account check expires, a page its cache still holds is refused for another account', async () => {
  assert.equal((await get(PAGE_URL, 'manager')).status, 200);
  // Refreshed 10 s before the account check expires: the page is cached until
  // 20 s after it.
  clock += ACCOUNT_CHECK_MS - 10_000;
  const refreshed = await (await get(PAGE_URL, 'manager')).json() as { cached: boolean };
  assert.equal(refreshed.cached, false);
  assert.deepEqual(loginCalls, [null]);
  const pageReads = calls.length;
  // Past the account check, within the page cache.
  clock += 15_000;
  assert.ok(15_000 < PAGE_CACHE_MS);
  loginAnswer = { ok: true, login: 'someone-else' };
  const res = await get(PAGE_URL, 'manager');
  assert.equal(res.status, 409);
  assert.equal(((await res.json()) as { code: string }).code, 'forge_account_mismatch');
  assert.equal(loginCalls.length, 2);
  assert.equal(calls.length, pageReads);
});

test('switching accounts in the same config folder is refused before the check expires', async () => {
  const url = '/api/projects/switch/pull-requests/12';
  assert.equal((await get(url, 'manager')).status, 200);
  assert.deepEqual(loginCalls, [ghDir]);
  // What `gh auth switch` does: the folder's hosts.yml names another user.
  clock += 5_000;
  writeFileSync(join(ghDir, 'hosts.yml'), hostsFile('someone-else'));
  loginAnswer = { ok: true, login: 'someone-else' };
  const pageReads = calls.length;
  for (const target of [url, `${url}?fresh=1`, `${url}/check-log?url=${encodeURIComponent('https://github.com/acme/widgets/actions/runs/1/job/2')}`]) {
    assert.equal((await get(target, 'manager')).status, 409);
  }
  assert.equal(calls.length, pageReads);
  assert.equal(loginCalls.length, 2, 'the new stamp is checked once, then kept');
});

test('a folder that keeps its token in hosts.yml is checked once within the minute', async () => {
  const url = '/api/projects/switch/pull-requests/12';
  assert.equal((await get(`${url}?fresh=1`, 'manager')).status, 200);
  clock += 5_000;
  assert.equal((await get(`${url}?fresh=1`, 'manager')).status, 200);
  assert.equal((await get(url, 'manager')).status, 200);
  assert.deepEqual(loginCalls, [ghDir]);
});

test('a folder whose token lives in the keyring asks gh at every read, its hosts.yml unchanged', async () => {
  // The keyring's active token is shared by every config folder: a switch
  // made with another one leaves this hosts.yml as it is.
  writeFileSync(join(ghDir, 'hosts.yml'), hostsFile('ai-bot', 'keyring'));
  const url = '/api/projects/switch/pull-requests/12';
  assert.equal((await get(url, 'manager')).status, 200);
  assert.deepEqual(loginCalls, [ghDir]);
  clock += 1_000;
  const pageReads = calls.length;
  loginAnswer = { ok: true, login: 'someone-else' };
  // Even the page its cache holds is refused.
  const res = await get(url, 'manager');
  assert.equal(res.status, 409);
  assert.equal(((await res.json()) as { code: string }).code, 'forge_account_mismatch');
  assert.equal((await get(`${url}/check-log?url=${encodeURIComponent('https://github.com/acme/widgets/actions/runs/1/job/2')}`, 'manager')).status, 409);
  assert.equal(loginCalls.length, 3);
  assert.equal(calls.length, pageReads);
  loginAnswer = { ok: true, login: 'ai-bot' };
  const back = await (await get(url, 'manager')).json() as { cached: boolean };
  assert.equal(back.cached, true);
  assert.equal(loginCalls.length, 4);
});

test('a stamp that moves, or that cannot be read, asks gh again', async () => {
  await get(`${PAGE_URL}?fresh=1`, 'manager');
  defaultStamp = 'stamp-2';
  await get(`${PAGE_URL}?fresh=1`, 'manager');
  assert.equal(loginCalls.length, 2);
  defaultStamp = null;
  await get(`${PAGE_URL}?fresh=1`, 'manager');
  await get(`${PAGE_URL}?fresh=1`, 'manager');
  assert.equal(loginCalls.length, 4);
  // A real folder whose hosts.yml is gone.
  rmSync(join(ghDir, 'hosts.yml'));
  const url = '/api/projects/switch/pull-requests/12?fresh=1';
  await get(url, 'manager');
  await get(url, 'manager');
  assert.equal(loginCalls.length, 6);
});

test('a project that names no account reads as before, without checking one', async () => {
  const res = await get('/api/projects/open/pull-requests/12', 'manager');
  assert.equal(res.status, 200);
  assert.deepEqual(loginCalls, []);
  assert.equal(calls.length, 3);
});

test('an event older than the first comment kept counts with the entries left out', async () => {
  const { withEvents } = await import('../../pull-request-page.js');
  const comment = (at: string) => ({ kind: 'comment' as const, author: null, body: '', bodyTruncated: false, createdAt: at, url: null, hidden: false, reactions: [] });
  const label = (at: string) => ({ kind: 'labeled' as const, actor: null, createdAt: at, label: { name: 'ui', color: null } });
  const page = { timeline: [comment('2026-11-17T12:00:00Z'), comment('2026-11-17T14:00:00Z')], timelineMore: 4 };
  const merged = withEvents(page as Parameters<typeof withEvents>[0], {
    events: [label('2026-11-17T11:00:00Z'), label('2026-11-17T13:00:00Z')], eventsMore: 2,
  });
  assert.deepEqual(merged.timeline.map((e) => [e.kind, e.createdAt]), [
    ['comment', '2026-11-17T12:00:00Z'], ['labeled', '2026-11-17T13:00:00Z'], ['comment', '2026-11-17T14:00:00Z'],
  ]);
  assert.equal(merged.timelineMore, 4 + 2 + 1);
  // Nothing cut: every event shows.
  const whole = withEvents({ ...page, timelineMore: 0 } as Parameters<typeof withEvents>[0], { events: [label('2026-11-17T11:00:00Z')], eventsMore: 0 });
  assert.equal(whole.timeline[0]!.kind, 'labeled');
  assert.equal(whole.timelineMore, 0);
});
