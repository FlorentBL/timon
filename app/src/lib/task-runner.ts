/**
 * TIM-0109 — the agent that ran a Kanban task, when the dispatcher sent it to
 * another one than the task names (a role pinned in `roles.json`, an agent of
 * another project…). The daemon adds `run_by` to the task row only then; on a
 * task no mission ran yet, `planned` marks the agent it WILL be handed to (#1109).
 */

import { backendShortName, type BackendCatalog } from '@/lib/backends';
import { shortModelName, taskModelMark, type TaskModelMark } from '@/lib/kanban-card';
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

/** The task fields a row reads to say who runs it, and on what. */
export type TaskRunSource = {
  agent_name: string;
  run_by?: TaskRunBy | null;
  backend_override?: string | null;
  model_override?: string | null;
  effective_backend?: string | null;
  effective_model?: string | null;
};

/** What a narrow row writes about a task's runner: the same facts as the card (#1203). */
export type TaskRunView = {
  /** The agent that runs the task, or will. */
  agent: string;
  /** The task names another agent: the roles chose this one. */
  rerouted: boolean;
  /** Short model name, else the backend's; `null` when the daemon sent neither. */
  model: string | null;
  mark: TaskModelMark;
  /** Tooltip: the agent, the full backend and model, and why it is not the named agent. */
  title: string;
};

export function taskRunView(catalog: BackendCatalog, task: TaskRunSource): TaskRunView {
  const agent = taskRunAgent(task);
  const backendId = task.effective_backend ?? task.backend_override ?? '';
  const backend = backendId ? backendShortName(catalog, backendId) : '';
  const slug = task.effective_model ?? task.model_override ?? null;
  const mark = taskModelMark(catalog, task);
  const model = slug ? shortModelName(slug) : backend || null;
  const full = slug
    ? [backend, slug].filter(Boolean).join(' / ')
    : backend ? t('kanbanPage.defaultModel', { backend }) : null;
  const lines = [full ? t('kanbanPage.runBy.on', { agent, model: full }) : agent];
  if (task.run_by) lines.push(runByTitle(task.agent_name, task.run_by));
  return { agent, rerouted: !!task.run_by, model, mark, title: lines.join('\n') };
}
