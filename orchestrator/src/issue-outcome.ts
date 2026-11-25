/**
 * An idea imported from a GitHub issue, resolved without a fix
 * (`docs/FORGE-FLOW-PLAN.md` §2 (a), the case outside "fixed"): the person who
 * opened the issue hears what became of it.
 *
 * On `todo_resolved` (`@timon/todo-outcomes`) with `declined`, `duplicate` or
 * `needs_info`, the daemon PROPOSES, for each issue of the project's own
 * repository the idea links to:
 * - a comment answering the issue: a template per outcome, then the idea's
 *   public note, its mentions defused (`defuseMentions`);
 * - for `declined` and `duplicate`, a second proposal that closes the issue,
 *   as not planned or as a duplicate (`issue-close.ts`).
 * Two validations, never grouped: a person may answer and leave the issue
 * open. Nothing reaches GitHub here; each proposal waits in the "Publish on
 * GitHub" window, where a signed-in person publishes or discards it.
 *
 * The text never quotes the issue nor the idea's private notes. `duplicate_of`
 * names a Timon reference (`TIM-0001`), meaningless on GitHub: left out.
 *
 * One proposal per idea, issue and outcome (`todo:<id>:issue:<n>:<outcome>`):
 * an outcome given twice proposes once, and a discarded proposal is not made
 * again. Until a person edits it, the comment follows the idea's public note
 * (`registerDraftRefresher`).
 */
import { bus, type BusEvent, type TodoResolvedSnapshot } from './bus.js';
import { dbApi } from './db.js';
import { projectRepository } from './external-pr-review.js';
import { GITHUB_ISSUE_PROVIDER, parseGithubIssueRef } from './forge-links.js';
import {
  proposeForgeWrite, registerDraftRefresher, type ForgeProposalDeps, type ForgeProposalRow,
} from './forge-proposals.js';
import { proposeIssueClose } from './issue-close.js';
import { defuseMentions, publicNote, PUBLIC_NOTE_LIMIT } from './issue-resolution.js';

/** Outcomes that answer the issue's author here; `fixed` is the landing's. */
export const ANSWERED_RESOLUTIONS = ['declined', 'duplicate', 'needs_info'] as const;
export type AnsweredResolution = (typeof ANSWERED_RESOLUTIONS)[number];

function answered(value: string): AnsweredResolution | null {
  return ANSWERED_RESOLUTIONS.find((r) => r === value) ?? null;
}

/** The proposal's key for an idea, one of its issues and the outcome given. */
export function outcomeKey(todoId: number, issue: number, resolution: AnsweredResolution): string {
  return `todo:${todoId}:issue:${issue}:${resolution}`;
}

const HEADS: Record<AnsweredResolution, { withNote: string; alone: string }> = {
  declined: {
    withNote: 'Thank you for this report. We decided not to take it on:',
    alone: 'Thank you for this report. We decided not to take it on for now.',
  },
  duplicate: {
    withNote: 'Thank you for this report. It duplicates one we already follow:',
    alone: 'Thank you for this report. It duplicates one we already follow, where the work goes on.',
  },
  needs_info: {
    withNote: 'Thank you for this report. We need a little more to move on:',
    alone: 'Thank you for this report. We need a little more to move on: could you add the steps, the version and the system where it happens?',
  },
};

/** The comment's text: a template, then the public note when there is one. */
export function outcomeComment(resolution: AnsweredResolution, note: string | null): string {
  const text = note?.trim() ?? '';
  if (!text) return HEADS[resolution].alone;
  const cut = text.length > PUBLIC_NOTE_LIMIT ? `${text.slice(0, PUBLIC_NOTE_LIMIT - 1)}…` : text;
  return `${HEADS[resolution].withNote}\n\n${defuseMentions(cut)}`;
}

/** The issues of the project's own repository an idea links to. */
function issuesOf(todoId: number, repo: string): number[] {
  const numbers: number[] = [];
  for (const link of dbApi.listTodoExternalRefs([todoId])) {
    if (link.provider !== GITHUB_ISSUE_PROVIDER) continue;
    const parsed = parseGithubIssueRef(link.ref);
    if (!parsed || parsed.repo.toLowerCase() !== repo.toLowerCase()) continue;
    if (!numbers.includes(parsed.number)) numbers.push(parsed.number);
  }
  return numbers;
}

export type IssueOutcomeResult = { comments: number; closes: number };

/**
 * Proposes the answer (and the closing) of every issue the resolved idea
 * links to. Nothing for an outcome that answers no one, an idea without a
 * project, or a project that does not open pull requests on GitHub.
 */
export function proposeIssueOutcome(todo: TodoResolvedSnapshot, deps: ForgeProposalDeps = {}): IssueOutcomeResult {
  const out: IssueOutcomeResult = { comments: 0, closes: 0 };
  const resolution = answered(todo.resolution);
  if (!resolution || !todo.project) return out;
  const where = projectRepository(todo.project);
  if (!where.ok) return out;
  for (const number of issuesOf(todo.id, where.value.repo)) {
    const comment = proposeForgeWrite({
      project: todo.project,
      kind: 'comment',
      target: { type: 'issue', number },
      body: outcomeComment(resolution, todo.public_note),
      trigger: 'todo_resolved',
      key: outcomeKey(todo.id, number, resolution),
      sourceRef: `todo:${todo.id}`,
      createdBy: null,
    }, deps);
    if (comment.ok && comment.created) out.comments += 1;
    else if (!comment.ok) console.warn(`[issue-outcome] answer of issue #${number} not proposed: ${comment.code}`);

    if (resolution === 'needs_info') continue;
    const close = proposeIssueClose({
      project: todo.project, number, reason: resolution === 'duplicate' ? 'duplicate' : 'not_planned',
      todoId: todo.id, trigger: 'todo_resolved', createdBy: null,
    }, deps);
    if (close.ok && close.created) out.closes += 1;
    else if (!close.ok) console.warn(`[issue-outcome] closing of issue #${number} not proposed: ${close.code}`);
  }
  return out;
}

const OUTCOME_KEY = /^todo:(\d+):issue:\d+:(declined|duplicate|needs_info)$/;

/** The text an outcome's draft holds now: the same template, today's note. */
export function refreshedOutcomeComment(proposal: ForgeProposalRow): string | null {
  if (proposal.trigger !== 'todo_resolved') return null;
  const key = OUTCOME_KEY.exec(proposal.idem_key);
  const resolution = key?.[2] ? answered(key[2]) : null;
  if (!key?.[1] || !resolution) return null;
  return outcomeComment(resolution, publicNote(Number(key[1])));
}

registerDraftRefresher(refreshedOutcomeComment);

/** Listens for resolved ideas. Returns the unsubscribe. */
export function watchIssueOutcomes(deps: ForgeProposalDeps = {}): () => void {
  const onEvent = (ev: BusEvent): void => {
    if (ev.kind !== 'todo_resolved') return;
    const todo = ev.todo;
    // Out of the write that resolved the idea: a refusal here never undoes it.
    setImmediate(() => {
      try {
        const made = proposeIssueOutcome(todo, deps);
        if (made.comments + made.closes > 0) {
          console.log(`[issue-outcome] idea #${todo.id} ${todo.resolution}: ${made.comments} answer(s), ${made.closes} closing(s) proposed`);
        }
      } catch (err) {
        console.error(`[issue-outcome] idea #${todo.id}: ${(err as Error).message}`);
      }
    });
  };
  bus.on('event', onEvent);
  return () => { bus.off('event', onEvent); };
}
