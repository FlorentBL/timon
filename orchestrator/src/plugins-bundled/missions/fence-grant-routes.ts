/**
 * `POST /api/missions/:id/fence-grants/:refusalId` — a person's answer to the
 * card of a path the mission fence refused (TODO #1162, #1168).
 *
 *   { decision: 'allow' }   adds the offered folder to the agent's extra folders,
 *                           then relaunches the mission: its fence is fixed when
 *                           its process starts, so the process is stopped and a
 *                           turn resumes the same conversation in a new one.
 *   { decision: 'allow', scope: 'project' }
 *                           the same, into the extra folders of the agent's
 *                           project (`project-extra-dirs.ts`): every mission of
 *                           the project gets it. Takes `projects:manage` too.
 *   { decision: 'refuse' }  closes the card; nothing changes.
 *
 * A Kanban task the refusal blocked (a launch refused, `task_fence_refused`)
 * has no conversation to resume: its mission never ran. The accord puts the
 * task back to PENDING instead, as a person's requeue, and the dispatcher
 * starts it again with the folder open. A task that moved on to another
 * mission since is left alone: that mission's next process gets the folder.
 *
 * A gesture of a person only: a browser session or a paired device. The daemon
 * token (CLI, scripts) and a mission token are refused, whatever they hold: an
 * agent never opens a folder to itself, and nobody answers a card in its name.
 * Allowing also takes the rights of the agent's folder list
 * (`agents:manage` and `agents:privileged-config`, as on the agent's page).
 *
 * Nothing of the stored event is trusted by itself: the refusal must be one of
 * this mission's, still carry an offer, and the folder passes every check of
 * `normalizeExtraDirs` again — never the Timon home, an ancestor of it, a home
 * folder, a disk's root or a folder of credentials.
 */
import type { IRouter, Request, Response } from 'express';
import { resolve } from 'node:path';
import { z } from 'zod';
import { apiError } from '../../api-error.js';
import { publishAgentUpdated, restartMissionProcess } from '../../agent.js';
import { agentExtraDirs, ExtraDirError, normalizeExtraDirs, setAgentExtraDirs, type AgentExtraDir } from '../../agent-extra-dirs.js';
import { dbApi, type MissionRow, type TaskRow } from '../../db.js';
import type { DbViewer } from '../../users/owned.js';
import {
  fenceGrantTurn, findFenceRefusal, recordFenceGrant,
  type FenceGrantOffer, type FenceGrantResolution, type FenceGrantScope, type StoredFenceRefusal,
} from '../../fence-grant.js';
import { ensureProjectRow, projectExtraDirs, setProjectExtraDirs } from '../../project-extra-dirs.js';
import { listProjects } from '../../projects.js';
import { auditRequest } from '../../users/audit-actor.js';
import { isPersonAuth, rejectIfDenied, requestHasPermission, viewerFromRequest } from '../../users/identity.js';
import { PRIVILEGED_CONFIG_PERMISSION, rejectOverride } from '../../users/privileged-overrides.js';
import { scopedDb } from '../../users/scoped-db.js';
import { sendMissionTurn } from './routes.js';

const BodySchema = z.object({ decision: z.enum(['allow', 'refuse']), scope: z.enum(['agent', 'project']).optional() }).strict();
const RefusalId = z.string().min(1).max(64).regex(/^[A-Za-z0-9-]+$/);

/** Relaunches `mission` with `text` once its folder is open; true when the turn was delivered. */
export type FenceGrantRelaunch = (mission: MissionRow, text: string) => Promise<boolean>;

export async function relaunchAfterGrant(mission: MissionRow, text: string): Promise<boolean> {
  await restartMissionProcess(mission.id);
  // The route already checked that the person may see this mission; this only re-reads its row after the restart.
  const fresh = scopedDb(null).getMission(mission.id) ?? mission;
  try {
    const outcome = await sendMissionTurn(fresh, { input: text }, null);
    if (outcome.status >= 300) {
      console.warn(`[fence] mission ${mission.id.slice(0, 8)} not relaunched after the accord: ${String(outcome.body.error ?? outcome.status)}`);
    }
    return outcome.status < 300;
  } catch (err) {
    console.warn(`[fence] mission ${mission.id.slice(0, 8)} not relaunched after the accord: ${(err as Error).message}`);
    return false;
  }
}

/** The Kanban task `mission` was started for: linked once it ran, named in its source when its launch was refused first. */
export function taskOfMission(mission: Pick<MissionRow, 'task_id' | 'source_meta'>, viewer: DbViewer | null): TaskRow | null {
  let id = mission.task_id;
  if (!id && mission.source_meta) {
    try {
      const meta = JSON.parse(mission.source_meta) as { task_id?: unknown };
      if (typeof meta.task_id === 'string') id = meta.task_id;
    } catch { /* a source with no task */ }
  }
  return id ? scopedDb(viewer).getTask(id) ?? null : null;
}

/**
 * What the accord does next for `mission`: put back the task it blocked,
 * leave a task that moved on to another mission, or relaunch the mission.
 */
export function afterGrantStep(mission: Pick<MissionRow, 'id' | 'task_id' | 'source_meta'>, viewer: DbViewer | null): { kind: 'requeue'; task: TaskRow } | { kind: 'none' } | { kind: 'relaunch' } {
  const task = taskOfMission(mission, viewer);
  if (!task) return { kind: 'relaunch' };
  const ours = task.mission_id === null || task.mission_id === mission.id;
  if (task.status === 'BLOCKED' && ours) return { kind: 'requeue', task };
  if (!ours && task.status !== 'DONE') return { kind: 'none' };
  return { kind: 'relaunch' };
}

/** A person's requeue of a blocked task, as the board's: PENDING, its requeue budget reset. */
function requeueTask(task: TaskRow, viewer: DbViewer | null): boolean {
  dbApi.updateTaskStatus(task.id, 'PENDING');
  dbApi.resetTaskRequeues(task.id);
  return scopedDb(viewer).getTask(task.id)?.status === 'PENDING';
}

/** The person answering, or null after the refusal was sent. */
function personOf(req: Request, res: Response): string | null {
  if (!req.auth) {
    res.status(401).json({ error: 'unauthorized' });
    return null;
  }
  if (!isPersonAuth(req.auth) || !req.auth.user) {
    res.status(403).json(apiError('fence_grant_session_required', 'a fence card is answered by a person, from the app'));
    return null;
  }
  return req.auth.user.id;
}

/** A list of folders with `offer` in it: added, or widened to its mode in place. */
function withOffer(current: readonly AgentExtraDir[], offer: FenceGrantOffer): AgentExtraDir[] {
  const key = resolve(offer.path);
  const held = current.find((dir) => resolve(dir.path) === key);
  if (!held) return [...current, { path: offer.path, mode: offer.mode }];
  if (held.mode === 'write' || offer.mode === 'read') return [...current];
  return current.map((dir) => (resolve(dir.path) === key ? { path: dir.path, mode: offer.mode } : dir));
}

export function registerFenceGrantRoutes(app: IRouter, deps: { relaunch?: FenceGrantRelaunch } = {}): void {
  const relaunch = deps.relaunch ?? relaunchAfterGrant;

  app.post('/api/missions/:id/fence-grants/:refusalId', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const userId = personOf(req, res);
    if (!userId) return;
    const mission = scopedDb(viewerFromRequest(req)).getMission(String(req.params.id ?? ''));
    if (!mission) {
      res.status(404).json(apiError('mission_not_found', 'mission not found'));
      return;
    }
    const refusalId = RefusalId.safeParse(req.params.refusalId);
    const body = BodySchema.safeParse(req.body ?? {});
    if (!refusalId.success || !body.success) {
      res.status(400).json(apiError('fence_grant_invalid', 'expected { decision: "allow" | "refuse" }'));
      return;
    }
    const found = findFenceRefusal(mission.id, refusalId.data);
    const refusal: StoredFenceRefusal | undefined = found?.refusal;
    const offer = refusal && refusal.grantable && !refusal.timonHome && refusal.agent ? refusal.grant ?? null : null;
    if (!found || !refusal || !offer || !refusal.agent) {
      res.status(404).json(apiError('fence_refusal_not_found', 'this mission holds no fence refusal a person may answer with that id'));
      return;
    }
    if (found.resolution) {
      res.status(409).json({ ...apiError('fence_grant_settled', 'this card was already answered'), resolution: found.resolution });
      return;
    }
    const agent = refusal.agent;
    const scope: FenceGrantScope = body.data.scope ?? 'agent';
    const project = scope === 'project' ? offer.project ?? null : null;
    if (scope === 'project' && (!project || !listProjects().includes(project))) {
      res.status(404).json(apiError('fence_grant_no_project', 'this card offers no project to open the folder to'));
      return;
    }

    if (body.data.decision === 'refuse') {
      const resolution: FenceGrantResolution = { id: refusalId.data, status: 'refused', path: null, mode: null, resolvedAt: Date.now() };
      recordFenceGrant(mission.id, resolution);
      auditRequest(req, 'mission.fence_grant.refuse', `mission:${mission.id} ${offer.path}`);
      res.json({ ok: true, resolution, relaunched: false });
      return;
    }

    // The rights of the folder list it joins, as on the agent's page or the project's settings.
    if (rejectIfDenied(req, res, project ? 'projects:manage' : 'agents:manage')) return;
    if (!requestHasPermission(req, PRIVILEGED_CONFIG_PERMISSION)) {
      rejectOverride(req, res, project ? 'project.extra_dirs_denied' : 'agent.extra_dirs_denied', project ? `project:${project}` : `agent:${agent}`,
        `opening a folder to ${project ? 'a project' : 'an agent'} needs the ${PRIVILEGED_CONFIG_PERMISSION} permission`);
      return;
    }
    const before = project ? projectExtraDirs(project) : agentExtraDirs(agent);
    let stored;
    try {
      const next = normalizeExtraDirs(withOffer(before, offer), before);
      if (project) {
        ensureProjectRow(project);
        stored = setProjectExtraDirs(project, next);
      } else {
        stored = setAgentExtraDirs(agent, next);
      }
    } catch (err) {
      if (err instanceof ExtraDirError) {
        res.status(400).json(apiError('extra_dir_refused', err.message, err.path ? { path: err.path } : undefined));
        return;
      }
      if (err instanceof Error && /^agent not found/.test(err.message)) {
        res.status(404).json(apiError('agent_not_found', `agent not found: ${agent}`));
        return;
      }
      throw err;
    }
    if (!project && JSON.stringify(before) !== JSON.stringify(stored)) publishAgentUpdated(agent, ['extra_dirs']);
    // The requeue runs before the answer is recorded, with no await between them, so the
    // recorded answer says whether the task went back to the queue: a reload replays it.
    const step = afterGrantStep(mission, viewerFromRequest(req));
    const requeued = step.kind === 'requeue' ? requeueTask(step.task, viewerFromRequest(req)) : false;
    const resolution: FenceGrantResolution = {
      id: refusalId.data, status: 'allowed', path: offer.path, mode: offer.mode, scope, project,
      ...(requeued ? { requeued: true } : {}), resolvedAt: Date.now(),
    };
    recordFenceGrant(mission.id, resolution);
    auditRequest(req, 'mission.fence_grant.allow', `${project ? `project:${project}` : `agent:${agent}`} ${offer.mode} ${offer.path}`);
    if (step.kind === 'requeue') {
      res.json({ ok: true, resolution, relaunched: false, requeued, taskId: step.task.id });
      return;
    }
    const relaunched = step.kind === 'relaunch' ? await relaunch(mission, fenceGrantTurn(refusal, offer, scope)) : false;
    res.json({ ok: true, resolution, relaunched, requeued: false, ...(step.kind === 'none' ? { taskMovedOn: true } : {}) });
  });
}
