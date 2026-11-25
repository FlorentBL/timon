/**
 * An idea imported from a GitHub issue lands when a contributor's pull
 * request closes that issue (`docs/FORGE-FLOW-PLAN.md` §2 (b) step 7): the
 * work was done outside Timon, the idea is done all the same.
 *
 * The forge decides, not the pull request's description: an idea goes `done`
 * only when GitHub says its issue is CLOSED as `completed` and that what
 * closed it is a MERGED pull request of the project's own repository. A
 * closing keyword in an open or unmerged pull request is its author's claim,
 * and an issue closed by hand, as not planned or as a duplicate, is a person's
 * decision that `@timon/todo-outcomes` records instead.
 *
 * Skipped: an idea promoted into a task (its chain closes it), an idea done
 * already, and a pull request that is one of our own jobs (its landing does
 * the same through `integration-landing.ts`). No comment is proposed: GitHub
 * already told the issue's author when the pull request closed it.
 *
 * One state read per repository and pass (`issueStates`, at most
 * `ISSUE_STATE_BATCH` issues), run with the landing poller; nothing is
 * read when no open idea links to an issue.
 */
import { db, dbApi, type ProjectTodoRow } from './db.js';
import { projectRepository } from './external-pr-review.js';
import { GITHUB_ISSUE_PROVIDER, parseGithubIssueRef } from './forge-links.js';
import {
  githubForge, ISSUE_STATE_BATCH, type ForgeIssueStateReader, type ForgeRunners, type IssueStateRead,
} from './host/forge.js';
import { publishPluginRealtime } from './plugins/realtime.js';

export type ContributorLandingDeps = {
  /** Stands in for `gh` in tests: nothing in the suite reaches GitHub. */
  forge?: (configDir: string | null) => ForgeIssueStateReader;
  runners?: ForgeRunners;
};

/** What a pass closed: the idea, its issue and the pull request that closed it. */
export type ContributorLanding = { todoId: number; project: string; issue: number; pull: number };

type Candidate = { todo_id: number; project: string; ref: string };

const candidatesStmt = db.prepare(`
  SELECT t.id AS todo_id, t.project AS project, r.ref AS ref
  FROM project_todo t JOIN todo_external_ref r ON r.todo_id = t.id
  WHERE r.provider = ? AND t.status = 'open' AND t.project IS NOT NULL
  ORDER BY t.id DESC
  LIMIT 1000
`);

function publishTodoChanged(row: ProjectTodoRow): void {
  // Same event as the notebook routes: the TO DO widgets refresh on it.
  if (!row.owner_user_id) return;
  publishPluginRealtime('@timon/kanban', 'project-todo.changed', { id: row.id }, { ownerUserId: row.owner_user_id });
}

/** Whether GitHub says this issue was fixed by a merged pull request of `repo`. */
export function landedByPull(read: IssueStateRead, repo: string): boolean {
  if (read.state !== 'closed' || read.stateReason !== 'completed' || !read.closedBy) return false;
  return read.closedBy.merged && read.closedBy.repo !== null && read.closedBy.repo.toLowerCase() === repo.toLowerCase();
}

/** One pass: the open ideas tied to an issue that a contributor's merged pull request closed go `done`. */
export async function landContributorClosings(deps: ContributorLandingDeps = {}): Promise<ContributorLanding[]> {
  // project → issue number → the ideas linked to it, each with the repository its link names.
  const byProject = new Map<string, Map<number, Array<{ todoId: number; repo: string }>>>();
  for (const row of candidatesStmt.all(GITHUB_ISSUE_PROVIDER) as Candidate[]) {
    const parsed = parseGithubIssueRef(row.ref);
    if (!parsed) continue;
    const issues = byProject.get(row.project) ?? new Map<number, Array<{ todoId: number; repo: string }>>();
    const ideas = issues.get(parsed.number) ?? [];
    ideas.push({ todoId: row.todo_id, repo: parsed.repo });
    issues.set(parsed.number, ideas);
    byProject.set(row.project, issues);
  }
  const landed: ContributorLanding[] = [];
  for (const [project, issues] of byProject) {
    const where = projectRepository(project);
    if (!where.ok) continue;
    const { repo, integration } = where.value;
    const own = (r: string) => r.toLowerCase() === repo.toLowerCase();
    const numbers = [...issues.entries()].filter(([, ideas]) => ideas.some((i) => own(i.repo))).map(([n]) => n)
      .slice(0, ISSUE_STATE_BATCH);
    if (numbers.length === 0) continue;
    const forge = (deps.forge ?? ((dir) => githubForge(dir, deps.runners)))(integration.gh_config_dir);
    const read = await forge.issueStates(repo, numbers);
    if (!read.ok) {
      console.warn(`[contributor-landing] cannot read the issues of ${project}: ${read.reason}`);
      continue;
    }
    for (const state of read.issues) {
      const pull = state.closedBy?.number;
      if (pull === undefined || !landedByPull(state, repo) || dbApi.listIntegrationsByPullRequest(project, pull).length > 0) continue;
      for (const idea of issues.get(state.number) ?? []) {
        if (!own(idea.repo)) continue;
        const todo = dbApi.getProjectTodo(idea.todoId);
        if (!todo || todo.status !== 'open') continue;
        const row = dbApi.updateProjectTodo(idea.todoId, { status: 'done', progress: 'done' });
        if (!row) continue;
        publishTodoChanged(row);
        landed.push({ todoId: idea.todoId, project, issue: state.number, pull });
        console.log(`[contributor-landing] TO DO #${idea.todoId} done: ${repo}#${state.number} closed by the merged pull request #${pull}`);
      }
    }
  }
  return landed;
}
