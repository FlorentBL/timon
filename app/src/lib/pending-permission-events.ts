/**
 * The stream names the daemon sends when a mission's permission card opens,
 * closes or gets a longer auto-deny delay (`sse.ts`, TODO #1200). The Kanban
 * board and a task's detail read the task again on them, so its "waiting for a
 * permission" line moves at once instead of at the next poll.
 */

import { useEffect, useRef, useState } from 'react';
import { sseOn } from './sse-stream';
import type { PendingPermission } from './kanban-card';

export const PENDING_PERMISSION_EVENTS = [
  'permission_request', 'permission_resolved', 'permission_expired', 'permission_timeout_adapted',
] as const;

type On = (type: string, fn: (event: MessageEvent) => void) => () => void;

/** The mission an alias names; the body carries nothing else. */
export function missionOfPermissionEvent(data: unknown): string | null {
  if (typeof data !== 'string') return null;
  try {
    const body = JSON.parse(data) as { missionId?: unknown };
    return typeof body.missionId === 'string' && body.missionId ? body.missionId : null;
  } catch {
    return null;
  }
}

/** Calls `onChange` with the mission of every card event; returns the unsubscription. */
export function subscribePendingPermissionChanges(onChange: (missionId: string) => void, on: On = sseOn): () => void {
  const stops = PENDING_PERMISSION_EVENTS.map((type) => on(type, (event) => {
    const missionId = missionOfPermissionEvent(event.data);
    if (missionId) onChange(missionId);
  }));
  return () => { for (const stop of stops) stop(); };
}

/**
 * Coalesces the card events of the given missions into one `reload` per burst:
 * a card resolved and the next one raised arrive together.
 */
export function subscribeMissionsPermissionChanges(
  watched: () => ReadonlySet<string>,
  reload: () => void,
  options: { on?: On; delayMs?: number } = {},
): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stop = subscribePendingPermissionChanges((missionId) => {
    if (!watched().has(missionId)) return;
    clearTimeout(timer);
    timer = setTimeout(reload, options.delayMs ?? 150);
  }, options.on);
  return () => {
    stop();
    clearTimeout(timer);
  };
}

/**
 * What one task's mission waits on, kept current while a screen shows it: the
 * value the task was read with, then the daemon's again after each card event
 * of that mission. `now` ticks every half minute while a card waits, for the
 * age and the deadline the line prints.
 */
export function useTaskPendingPermission(task: {
  id: string;
  mission_id?: string | null;
  status?: string;
  pending_permission?: PendingPermission | null;
} | null): { pending: PendingPermission | null; now: number } {
  const [pending, setPending] = useState<PendingPermission | null>(task?.pending_permission ?? null);
  const [now, setNow] = useState(() => Date.now());
  const taskId = task?.id ?? null;
  const missionId = task?.status === 'IN_PROGRESS' ? task.mission_id ?? null : null;
  const initial = useRef(task?.pending_permission ?? null);
  initial.current = task?.pending_permission ?? null;

  useEffect(() => { setPending(initial.current); }, [taskId, missionId]);

  useEffect(() => {
    if (!taskId || !missionId) return;
    let alive = true;
    const watched = new Set([missionId]);
    const stop = subscribeMissionsPermissionChanges(() => watched, () => {
      fetch(`/api/ui/tasks/${encodeURIComponent(taskId)}`, { cache: 'no-store' })
        .then((r) => (r.ok ? r.json() : null))
        .then((body: { task?: { pending_permission?: PendingPermission | null } } | null) => {
          if (alive && body?.task) setPending(body.task.pending_permission ?? null);
        })
        .catch(() => { /* the line keeps its last state */ });
    });
    return () => { alive = false; stop(); };
  }, [taskId, missionId]);

  useEffect(() => {
    if (!pending) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [pending]);

  return { pending: missionId ? pending : null, now };
}
