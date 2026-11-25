/**
 * "Allow for this agent" / "Allow for the project": the answer a person gives,
 * from the mission's thread, to a path the mission fence refused (TODO #1162,
 * #1168).
 *
 * WHY. A refusal the fence is sure of (`fence-refusal.ts`) names a folder an
 * agent could be given (`extra_dirs`, `agent-extra-dirs.ts`). Sending the
 * person to the agent's page, then back to the thread to say "try again", is
 * three gestures for one decision. The refusal now carries an offer: the
 * folder an accord would add and the access it would give. The person's
 * answer is recorded once, as a `fence_grant_resolved` event, so a replay of
 * the thread rebuilds the card in its final state.
 *
 * What is never offered: a path of the Timon home, a folder of credentials or
 * one listed in `host.isolation.deny` (`grantable` is false), and any folder
 * `extraDirProblem` refuses (a whole home folder, a disk's root, an ancestor
 * of the Timon home). Those refusals keep the notice alone, with no card.
 * The offer is checked again when the person answers: nothing in the event
 * is trusted to open a folder by itself.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { loadConfig } from './agent-config.js';
import { agentExtraDirs, extraDirProblem, type AgentExtraDir, type ExtraDirMode } from './agent-extra-dirs.js';
import { bus } from './bus.js';
import { dbApi } from './db.js';
import type { FenceRefusal } from './fence-refusal.js';
import { projectExtraDirs } from './project-extra-dirs.js';
import { listProjects } from './projects.js';
import { projectFromCwd } from './task-project.js';

/** The event that settles an offer; its `id` is the refusal's. */
export const FENCE_GRANT_EVENT = 'fence_grant_resolved';

/** What an accord would add to the agent's, or its project's, extra folders. */
export type FenceGrantOffer = {
  /** Absolute folder: the refused path when it is a folder, else its nearest existing parent folder. */
  path: string;
  /** The same folder with the user's home folded to `~`, for display. */
  display: string;
  mode: ExtraDirMode;
  /** The agent's project, which "Allow for the project" adds the folder to; null (or absent, on a refusal recorded before #1168) offers the agent alone. */
  project?: string | null;
};

export type FenceGrantStatus = 'allowed' | 'refused';
/** Whose extra folders an accord adds the folder to. */
export type FenceGrantScope = 'agent' | 'project';

export type FenceGrantResolution = {
  /** The refusal this answers (`FenceRefusal.id`). */
  id: string;
  status: FenceGrantStatus;
  /** The folder added, when allowed. */
  path: string | null;
  mode: ExtraDirMode | null;
  /** Whose list the folder joined, when allowed. */
  scope?: FenceGrantScope | null;
  /** The project it joined, when `scope` is `project`. */
  project?: string | null;
  resolvedAt: number;
};

/** The project an agent belongs to, as its launches read it, when that project exists; null otherwise. */
export function agentProjectOf(agent: string): string | null {
  try {
    const cfg = loadConfig(agent);
    const slug = cfg.project ?? projectFromCwd(cfg.cwd);
    return slug && listProjects().includes(slug) ? slug : null;
  } catch {
    return null;
  }
}

function contains(parent: string, child: string): boolean {
  if (parent === child) return true;
  const rel = relative(parent, child);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function isFolder(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The folder an accord gives for `path`: the path itself when it is a folder,
 * else the nearest existing folder above it — a file's folder, or the first
 * folder that exists above one the CLI meant to create.
 */
export function grantFolderOf(path: string, folder: (p: string) => boolean = isFolder): string | null {
  let current = resolve(path);
  for (;;) {
    if (folder(current)) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/** Whether `held` already gives `mode` on exactly `path`: then an accord would change nothing.
 *  `held` is the agent's folders and its project's: a mission gets both. */
function alreadyHeld(held: readonly AgentExtraDir[], path: string, mode: ExtraDirMode): boolean {
  return held.some((dir) => resolve(dir.path) === path && (dir.mode === 'write' || mode === 'read'));
}

/**
 * The offer a refusal carries, or null when none may be made: a path the fence
 * always keeps from missions, a mission with no agent, a folder an agent may
 * not be given, or one the agent already holds with that access (the fence
 * refused it for another reason, which no accord fixes).
 */
export function fenceGrantOffer(
  refusal: Pick<FenceRefusal, 'path' | 'access' | 'grantable' | 'timonHome' | 'agent'>,
  options: {
    held?: readonly AgentExtraDir[];
    /** The agent's project; read from its config when absent. */
    project?: string | null;
    home?: string;
    timonHome?: string;
    folder?: (p: string) => boolean;
    problem?: (path: string) => string | null;
  } = {},
): FenceGrantOffer | null {
  if (!refusal.grantable || refusal.timonHome || !refusal.agent) return null;
  const path = grantFolderOf(refusal.path, options.folder);
  if (!path) return null;
  const problem = options.problem
    ?? ((p: string) => extraDirProblem(p, {
      ...(options.timonHome ? { timonHome: options.timonHome } : {}),
      ...(options.home ? { home: options.home } : {}),
    }));
  if (problem(path)) return null;
  const mode: ExtraDirMode = refusal.access === 'write' ? 'write' : 'read';
  const project = options.project === undefined ? agentProjectOf(refusal.agent) : options.project;
  const held = options.held ?? [...agentExtraDirs(refusal.agent), ...projectExtraDirs(project)];
  if (alreadyHeld(held, path, mode)) return null;
  const userHome = resolve(options.home ?? homedir());
  const display = contains(userHome, path) && path !== userHome ? join('~', relative(userHome, path)) : path;
  return { path, display, mode, project };
}

/**
 * The refusal as the thread will store it: an id of its own, and the offer
 * when one may be made. Mutates and returns `refusal`, so the launch error
 * that carries the same object carries them too.
 */
export function withFenceGrantOffer(refusal: FenceRefusal, offer: (r: FenceRefusal) => FenceGrantOffer | null = fenceGrantOffer): FenceRefusal {
  refusal.id ??= randomUUID();
  try {
    refusal.grant = offer(refusal);
  } catch (err) {
    // A config file that cannot be read offers nothing; the notice still says what to do.
    console.warn(`[fence] no access card for ${refusal.display}: ${(err as Error).message}`);
    refusal.grant = null;
  }
  return refusal;
}

const storedRefusalSchema = z.object({
  id: z.string().min(1),
  path: z.string().min(1),
  display: z.string(),
  access: z.enum(['read', 'write']),
  agent: z.string().min(1).nullable(),
  timonHome: z.boolean(),
  grantable: z.boolean(),
  grant: z.object({
    path: z.string().min(1),
    display: z.string(),
    mode: z.enum(['read', 'write']),
    project: z.string().min(1).nullable().optional(),
  }).nullable().optional(),
}).passthrough();

export type StoredFenceRefusal = z.infer<typeof storedRefusalSchema>;

const resolutionSchema = z.object({
  id: z.string().min(1),
  status: z.enum(['allowed', 'refused']),
  path: z.string().nullable(),
  mode: z.enum(['read', 'write']).nullable(),
  scope: z.enum(['agent', 'project']).nullable().optional(),
  project: z.string().nullable().optional(),
  resolvedAt: z.number(),
}).passthrough();

function parsed<T>(schema: z.ZodType<T>, payload: string): T | null {
  try {
    const out = schema.safeParse(JSON.parse(payload));
    return out.success ? out.data : null;
  } catch {
    return null;
  }
}

/** The refusal `id` of `missionId`, with its answer when it has one; null when the mission holds no such refusal. */
export function findFenceRefusal(missionId: string, id: string): { refusal: StoredFenceRefusal; resolution: FenceGrantResolution | null } | null {
  const rows = dbApi.scanMissionEvents(missionId, {
    where: `type IN ('fence_refused', '${FENCE_GRANT_EVENT}') AND json_extract(payload, '$.id') = ?`,
    params: [id],
    order: 'ASC',
  }) as Array<{ type: string; payload: string }>;
  let refusal: StoredFenceRefusal | null = null;
  let resolution: FenceGrantResolution | null = null;
  for (const row of rows) {
    if (row.type === 'fence_refused') refusal ??= parsed(storedRefusalSchema, row.payload);
    else resolution ??= parsed(resolutionSchema, row.payload);
  }
  return refusal ? { refusal, resolution } : null;
}

/** Records the person's answer in the thread, where a replay finds it. */
export function recordFenceGrant(missionId: string, resolution: FenceGrantResolution): void {
  const body = { type: FENCE_GRANT_EVENT, ...resolution };
  const row = dbApi.insertEvent(missionId, FENCE_GRANT_EVENT, body);
  bus.publish({ kind: 'event', missionId, type: FENCE_GRANT_EVENT, timestamp: row.timestamp, payload: body });
}

/**
 * The turn that relaunches the mission once the folder is open, in English:
 * it is read by the agent. A person's click sent it, and the thread says so.
 */
export function fenceGrantTurn(refusal: Pick<StoredFenceRefusal, 'display'>, offer: FenceGrantOffer, scope: FenceGrantScope = 'agent'): string {
  const access = offer.mode === 'write' ? 'read and write' : 'read';
  const whose = scope === 'project' && offer.project ? `the missions of project ${offer.project}` : 'this agent\'s missions';
  return `Access granted: ${whose} may now ${access} ${offer.display}. `
    + `The mission fence refused ${refusal.display} before; try again what failed, then carry on.`;
}
