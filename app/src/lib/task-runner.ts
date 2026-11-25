/**
 * TIM-0109 — the agent that ran a Kanban task, when the dispatcher sent it to
 * another one than the task names (a role pinned in `roles.json`, an agent of
 * another project…). The daemon adds `run_by` to the task row only then; on a
 * task no mission ran yet, `planned` marks the agent it WILL be handed to (#1109).
 */

import { t } from '@/lib/i18n';

export type TaskRunBy = {
  agent: string;
  source: string | null;
  reason: string | null;
  planned?: boolean;
};

/** The agent whose chat holds the task's mission, or will: the one the card shows. */
export function taskRunAgent(task: { agent_name: string; run_by?: TaskRunBy | null }): string {
  return task.run_by?.agent ?? task.agent_name;
}

const REASON_KEYS: Record<string, string> = {
  pinned: 'kanbanPage.runBy.reasonPinned',
  missing: 'kanbanPage.runBy.reasonMissing',
  other_project: 'kanbanPage.runBy.reasonOtherProject',
  orchestrator: 'kanbanPage.runBy.reasonOrchestrator',
  other_role: 'kanbanPage.runBy.reasonOtherRole',
};

/** i18n key of the sentence that says why; an unknown or missing reason has a generic one. */
export function runByReasonKey(reason: string | null | undefined): string {
  return (reason && REASON_KEYS[reason]) || 'kanbanPage.runBy.reasonUnknown';
}

/** The sentence that says who runs the task instead of the one it names, and why. */
export function runByTitle(named: string, runBy: TaskRunBy): string {
  const vars = { named, agent: runBy.agent };
  const reason = t(runByReasonKey(runBy.reason), vars);
  return runBy.planned
    ? t('kanbanPage.runBy.titlePlanned', { ...vars, reason })
    : t('kanbanPage.runBy.title', { ...vars, reason });
}
