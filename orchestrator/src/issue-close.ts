/**
 * "Close the issue" (`docs/FORGE-FLOW-PLAN.md` §2 (a), the case outside a
 * fix): an idea imported from a GitHub issue that a person declined, or marked
 * a duplicate, may close that issue, as not planned or as a duplicate.
 *
 * Like every write on the forge it is a proposal (`forge-proposals.ts`): the
 * daemon prepares it, a signed-in person publishes it in the "Publish on
 * GitHub" window, or leaves the issue open. It is a separate proposal from the
 * comment that answers the issue's author, never grouped with it: a person may
 * want to answer and keep the issue open.
 *
 * Publishing reads the issue first: one already closed answers what it is,
 * and nothing is written again. The reason is fixed when it is proposed and
 * has no text a person could edit.
 */
import {
  proposalPayload, proposeForgeWrite, registerForgeProposalExecutor,
  type ForgeProposalDeps, type ForgeProposalExecution, type ForgeProposalExecutorResult, type ProposeOutcome,
} from './forge-proposals.js';
import { githubForge, ISSUE_CLOSE_REASONS, type ForgeIssueCloser, type IssueCloseReason } from './host/forge.js';

/** The proposal's key for an idea and one of its issues: one close per issue. */
export function issueCloseKey(todoId: number, issue: number): string {
  return `todo:${todoId}:issue:${issue}:close`;
}

/** What the window shows: what GitHub does, and how. */
export function closeText(number: number, reason: IssueCloseReason): string {
  return `Close issue #${number} on GitHub ${reason === 'duplicate' ? 'as a duplicate' : 'as not planned'}. Nothing else changes on it.`;
}

export type CloseInput = {
  project: string;
  number: number;
  reason: IssueCloseReason;
  todoId: number;
  trigger: 'todo_resolved' | 'person';
  createdBy: string | null;
};

/** Prepares the closing of an issue for a person to publish. Nothing reaches the forge. */
export function proposeIssueClose(input: CloseInput, deps: ForgeProposalDeps = {}): ProposeOutcome {
  return proposeForgeWrite({
    project: input.project,
    kind: 'close_issue',
    target: { type: 'issue', number: input.number },
    body: closeText(input.number, input.reason),
    trigger: input.trigger,
    key: issueCloseKey(input.todoId, input.number),
    sourceRef: `todo:${input.todoId}`,
    payload: { reason: input.reason, todo_id: input.todoId },
    createdBy: input.createdBy,
  }, deps);
}

function issueForge(configDir: string | null, deps: ForgeProposalDeps): ForgeIssueCloser {
  return (deps.issueForge ?? ((dir) => githubForge(dir, deps.runners)))(configDir);
}

function reasonOf(payload: Record<string, unknown>): IssueCloseReason | null {
  return ISSUE_CLOSE_REASONS.find((r) => r === payload.reason) ?? null;
}

async function executeClose(run: ForgeProposalExecution): Promise<ForgeProposalExecutorResult> {
  const { row } = run;
  const reason = reasonOf(proposalPayload(row));
  if (!reason) return { ok: false, code: 'forge_proposal_invalid', reason: 'this proposal does not say why the issue closes', status: 500, failed: true };
  const forge = issueForge(run.configDir, run.deps);
  const read = await forge.issueDetails(row.repo, row.target_number);
  if (!read.ok) {
    return { ok: false, code: 'forge_read_failed', reason: `the issue could not be read: ${run.scrub(read.reason)}`, status: 502, failed: false };
  }
  // Closed already, by anyone, for any reason: there is nothing left to do.
  if (read.issue.state === 'closed') return { ok: true, url: read.issue.url, already: true };
  const out = await forge.closeIssue(row.repo, row.target_number, reason);
  if (!out.ok) {
    return { ok: false, code: 'forge_publish_failed', reason: `the issue was not closed: ${run.scrub(out.reason)}`, status: 502, failed: true };
  }
  return { ok: true, url: out.url, already: false };
}

registerForgeProposalExecutor('close_issue', { editable: false, execute: executeClose });
