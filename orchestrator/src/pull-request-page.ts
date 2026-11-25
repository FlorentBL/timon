/**
 * The page of one pull request of a project, as the detail window of the Pull
 * requests widget shows it: GitHub's page, read only (`host/forge-pull-view.ts`),
 * its timeline events among its comments, and the end of a failed check's log.
 *
 * A short cache per (project, repository, number) keeps a window opened twice
 * from starting `gh` twice. It is bypassed when the caller knows the pull
 * request changed since (its `updatedAt` from the list differs: a push moved
 * its head, a comment was added) or asks for a fresh read, and dropped for a
 * project whose job moved (`integration_changed`).
 *
 * When the project names the GitHub account it expects, `gh` must sign in as
 * that account before anything is read with its config folder; the login it
 * answers is kept a minute per folder and per state of that folder's
 * credentials (`ghCredentialsStamp`), so opening windows does not ask the
 * forge each time, and switching accounts in the folder asks it at once.
 */
import { bus, type BusEvent } from './bus.js';
import { projectRepository, type ExternalPrRefusal } from './external-pr-review.js';
import { ghCredentialsStamp, ghLogin, type GhLoginOutcome } from './host/gh.js';
import { githubForge, type FailedCheckLog, type ForgeCheckLogReader } from './host/forge.js';
import {
  githubPullPageReader, type ForgePullPageReader, type PullEventsPage, type PullRequestPage, type ReviewThreadsPage,
} from './host/forge-pull-view.js';

/** How long a page read is shown again without asking the forge. */
export const PAGE_CACHE_MS = 30_000;
/** Most pages kept: a person looks at a handful at a time. */
const PAGE_CACHE_SIZE = 50;
/** How long the login `gh` answered for a config folder is trusted again. */
export const ACCOUNT_CHECK_MS = 60_000;
/** Fixed on purpose: the login gh actually answers never reaches the caller. */
const ACCOUNT_MISMATCH = 'gh does not sign in as the GitHub account set in the project\'s integration';

export type PullRequestPageView = PullRequestPage & {
  threads: ReviewThreadsPage['threads'];
  threadsMore: number;
  /** Why the review threads could not be read; the rest of the page still shows. */
  threadsError: string | null;
};

export type PageDeps = {
  /** Stand in for `gh` in tests: nothing in the suite reaches GitHub. */
  pageReader?: (configDir: string | null) => ForgePullPageReader;
  checkLogReader?: (configDir: string | null) => ForgeCheckLogReader;
  /** Stands in for `gh api user`, the check the integration's page runs. */
  ghLogin?: (configDir: string | null) => Promise<GhLoginOutcome>;
  /** Stands in for the `stat` of the folder's `hosts.yml`. */
  credentialsStamp?: (configDir: string | null) => string | null;
  now?: () => number;
};

type Entry = { at: number; project: string; view: PullRequestPageView };
const cache = new Map<string, Entry>();

const keyOf = (slug: string, repo: string, number: number) => `${slug}\n${repo.toLowerCase()}\n${number}`;

function remember(key: string, entry: Entry): void {
  cache.delete(key);
  cache.set(key, entry);
  // A Map keeps insertion order: the first key is the oldest read.
  while (cache.size > PAGE_CACHE_SIZE) cache.delete(cache.keys().next().value as string);
}

/** Logins `gh` answered, per config folder ('' for none), with the stamp of
 *  that folder's credentials when they were asked. */
const logins = new Map<string, { at: number; stamp: string; login: string }>();

/** Forgets every page read for `project` (all of them, and every login
 *  checked, when null). */
export function forgetPullRequestPages(project: string | null = null): void {
  if (project === null) { cache.clear(); logins.clear(); return; }
  for (const [key, entry] of cache) if (entry.project === project) cache.delete(key);
}

/**
 * The page's timeline with the events among its comments and reviews, oldest
 * first. Past its bound the page kept the latest comments: an event older
 * than the first one kept would stand alone among them, so it counts with the
 * entries left out.
 */
export function withEvents(page: PullRequestPage, events: PullEventsPage | null): Pick<PullRequestPage, 'timeline' | 'timelineMore'> {
  if (!events || events.events.length + events.eventsMore === 0) return { timeline: page.timeline, timelineMore: page.timelineMore };
  const from = page.timelineMore > 0 ? page.timeline[0]?.createdAt ?? '' : '';
  const kept = events.events.filter((e) => e.createdAt >= from);
  return {
    // A stable sort: at the same second, a comment stays before an event.
    timeline: [...page.timeline, ...kept].sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    timelineMore: page.timelineMore + events.eventsMore + (events.events.length - kept.length),
  };
}

/**
 * Null when the project's reads may go on: it names no account (they run as
 * before), or `gh` signs in as that account with its config folder. A check
 * that cannot run refuses too: nothing is read with an account nobody saw.
 */
async function accountRefusal(
  integration: { account: string | null; gh_config_dir: string | null }, deps: PageDeps, now: number,
): Promise<ExternalPrRefusal | null> {
  const expected = integration.account;
  if (!expected) return null;
  const key = integration.gh_config_dir ?? '';
  // Read before gh is asked: an account switched while it answers leaves a
  // stamp that no longer matches, so the next read asks again.
  const stamp = (deps.credentialsStamp ?? ghCredentialsStamp)(integration.gh_config_dir);
  let known = logins.get(key);
  if (!known || now - known.at >= ACCOUNT_CHECK_MS || stamp === null || known.stamp !== stamp) {
    logins.delete(key);
    const out = await (deps.ghLogin ?? ((dir: string | null) => ghLogin(dir)))(integration.gh_config_dir);
    if (!out.ok) return { ok: false, status: 502, code: 'forge_read_failed', reason: `the GitHub account could not be checked: ${out.reason}` };
    known = { at: now, stamp: stamp ?? '', login: out.login };
    // Unreadable credentials are checked again at every read.
    if (stamp !== null) logins.set(key, known);
  }
  // GitHub logins ignore case.
  return known.login.toLowerCase() === expected.toLowerCase()
    ? null
    : { ok: false, status: 409, code: 'forge_account_mismatch', reason: ACCOUNT_MISMATCH };
}

export type PageOutcome = { ok: true; view: PullRequestPageView; cached: boolean } | ExternalPrRefusal;

export async function readPullRequestPage(
  slug: string, number: number, deps: PageDeps = {},
  opts: { fresh?: boolean; updatedAt?: string | null } = {},
): Promise<PageOutcome> {
  const resolved = projectRepository(slug);
  if (!resolved.ok) return resolved;
  const { repo, integration } = resolved.value;
  const now = (deps.now ?? Date.now)();
  // Before the cache too: a page read with the right account is not shown
  // once the folder signs in as another one.
  const refusal = await accountRefusal(integration, deps, now);
  if (refusal) return refusal;
  const key = keyOf(slug, repo, number);
  const known = cache.get(key);
  if (known && !opts.fresh && now - known.at < PAGE_CACHE_MS && (!opts.updatedAt || opts.updatedAt === known.view.updatedAt)) {
    return { ok: true, view: known.view, cached: true };
  }
  const reader = (deps.pageReader ?? ((dir) => githubPullPageReader(dir)))(integration.gh_config_dir);
  const [page, threads, events] = await Promise.all([
    reader.pullRequestPage(repo, number),
    reader.pullRequestThreadsPage(repo, number),
    reader.pullRequestEvents(repo, number),
  ]);
  if (!page.ok) return { ok: false, status: 502, code: 'forge_read_failed', reason: page.reason };
  // The events failing leaves the conversation as `gh pr view` gives it.
  const view: PullRequestPageView = {
    ...page.page,
    ...withEvents(page.page, events.ok ? events.value : null),
    threads: threads.ok ? threads.value.threads : [],
    threadsMore: threads.ok ? threads.value.threadsMore : 0,
    threadsError: threads.ok ? null : threads.reason,
  };
  remember(key, { at: now, project: slug, view });
  return { ok: true, view, cached: false };
}

export type CheckLogOutcome =
  | { ok: true; log: FailedCheckLog }
  | ExternalPrRefusal
  | { ok: false; status: 422; code: 'check_log_unavailable'; reason: string };

/** The end of a failed check's log, when it is a job of the repository's own
 *  CI (`failedCheckLog` refuses any other address). */
export async function readCheckLog(slug: string, checkUrl: string, deps: PageDeps = {}): Promise<CheckLogOutcome> {
  const resolved = projectRepository(slug);
  if (!resolved.ok) return resolved;
  const { repo, integration } = resolved.value;
  const refusal = await accountRefusal(integration, deps, (deps.now ?? Date.now)());
  if (refusal) return refusal;
  const reader = (deps.checkLogReader ?? ((dir) => githubForge(dir)))(integration.gh_config_dir);
  const out = await reader.failedCheckLog(repo, checkUrl);
  if (out.ok) return out;
  if (out.code === 'not_actions') return { ok: false, status: 422, code: 'check_log_unavailable', reason: out.reason };
  return { ok: false, status: 502, code: 'forge_read_failed', reason: out.reason };
}

/** Drops a project's pages when one of its jobs moves: its pull request was
 *  opened, merged, closed or got new checks. */
export function watchPullRequestPages(): () => void {
  const onEvent = (ev: BusEvent): void => {
    if (ev.kind === 'integration_changed' && ev.project) forgetPullRequestPages(ev.project);
  };
  bus.on('event', onEvent);
  return () => { bus.off('event', onEvent); };
}
