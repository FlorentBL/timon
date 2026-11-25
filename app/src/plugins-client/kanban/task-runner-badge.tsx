'use client';

import { Shuffle } from 'lucide-react';
import { t as i18n } from '@/lib/i18n';
import { runByTitle, type TaskRunBy } from '@/lib/task-runner';

/** Kanban card chip for a task run by another agent than the one it names
 *  (TIM-0109, #1109): the card already shows the agent that runs it, the chip
 *  recalls the one the task was given to; the reason stays in the tooltip. */
export function TaskRunnerBadge({ named, runBy }: { named: string; runBy: TaskRunBy }) {
  const title = runByTitle(named, runBy);
  return (
    <span
      title={title}
      aria-label={title}
      data-task-runner={runBy.agent}
      data-task-runner-planned={runBy.planned ? '' : undefined}
      className="inline-flex max-w-[180px] items-center gap-1 text-[11px] text-muted-foreground"
    >
      <Shuffle className="size-3 flex-none" aria-hidden />
      <span className="truncate">{i18n('kanbanPage.runBy.assigned', { named })}</span>
    </span>
  );
}
