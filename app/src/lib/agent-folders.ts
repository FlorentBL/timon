/**
 * An agent's extra folders (`extra_dirs`): the folders outside its working
 * directory its missions may read, or read and write. Read and written
 * through `/api/ui/agents/:name/extra-dirs`, the daemon's one door for them:
 * the config route strips the key, and only a person (or a holder of
 * `agents:privileged-config`) changes it.
 *
 * Every function here is the API a surface reuses — the agent's page, the
 * project's settings, a card of the chat that offers a refused folder.
 *
 * A project has a list of its own (`/api/ui/projects/:slug/extra-dirs`,
 * TODO #1168): every mission of the project gets it, beside its agent's.
 * Only a person writes it, from the app.
 */
import { apiErrorMessage } from '@/lib/api-error';

export type AgentFolderMode = 'read' | 'write';
export type AgentFolder = { path: string; mode: AgentFolderMode };

/** Whose list: one agent's, or a whole project's. */
export type FolderOwner = { kind: 'agent'; name: string } | { kind: 'project'; slug: string };

/** A stable key of `owner`, for React lists and lookups. */
export function folderOwnerKey(owner: FolderOwner): string {
  return owner.kind === 'agent' ? `agent:${owner.name}` : `project:${owner.slug}`;
}

export type AgentFolders = {
  owner: FolderOwner;
  /** The agent's name; empty for a project's list. */
  agent: string;
  folders: AgentFolder[];
  /** Stored folders a launch leaves out now, with the daemon's reason (in English). */
  dropped: Array<{ path: string; reason: string }>;
  /** Processes of the agent running now, with the folders they were launched with. */
  running: number;
  /** Processes a write stopped (`restart: true`). */
  restarted: number;
};

export class AgentFoldersError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'AgentFoldersError';
  }
}

const endpoint = (owner: FolderOwner): string => (owner.kind === 'agent'
  ? `/api/ui/agents/${encodeURIComponent(owner.name)}/extra-dirs`
  : `/api/ui/projects/${encodeURIComponent(owner.slug)}/extra-dirs`);

function parse(body: unknown, owner: FolderOwner): AgentFolders {
  const raw = (body ?? {}) as Record<string, unknown>;
  const folders = Array.isArray(raw.extra_dirs)
    ? raw.extra_dirs.flatMap((entry): AgentFolder[] => {
      const e = entry as { path?: unknown; mode?: unknown };
      return typeof e.path === 'string' && (e.mode === 'read' || e.mode === 'write') ? [{ path: e.path, mode: e.mode }] : [];
    })
    : [];
  const dropped = Array.isArray(raw.dropped)
    ? raw.dropped.flatMap((entry): AgentFolders['dropped'] => {
      const e = entry as { path?: unknown; reason?: unknown };
      return typeof e.path === 'string' && typeof e.reason === 'string' ? [{ path: e.path, reason: e.reason }] : [];
    })
    : [];
  return {
    owner,
    agent: owner.kind === 'agent' ? (typeof raw.agent === 'string' ? raw.agent : owner.name) : '',
    folders,
    dropped,
    running: typeof raw.running === 'number' ? raw.running : 0,
    restarted: typeof raw.restarted === 'number' ? raw.restarted : 0,
  };
}

async function send(owner: FolderOwner, method: string, body?: unknown): Promise<AgentFolders> {
  const res = await fetch(endpoint(owner), {
    method,
    cache: 'no-store',
    ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
  const json: unknown = await res.json().catch(() => null);
  if (!res.ok) throw new AgentFoldersError(res.status, apiErrorMessage(json, { status: res.status }));
  return parse(json, owner);
}

export function fetchFolders(owner: FolderOwner): Promise<AgentFolders> {
  return send(owner, 'GET');
}

/** Adds `path`, or changes its mode when the list already has it. */
export function addFolder(owner: FolderOwner, folder: AgentFolder): Promise<AgentFolders> {
  return send(owner, 'POST', { path: folder.path, mode: folder.mode });
}

export function removeFolder(owner: FolderOwner, path: string): Promise<AgentFolders> {
  return send(owner, 'DELETE', { path });
}

export function fetchAgentFolders(agent: string): Promise<AgentFolders> {
  return fetchFolders({ kind: 'agent', name: agent });
}

/** Adds `path`, or changes its mode when the agent already has it. `restart` stops the agent's running processes. */
export function addAgentFolder(agent: string, folder: AgentFolder, options: { restart?: boolean } = {}): Promise<AgentFolders> {
  return send({ kind: 'agent', name: agent }, 'POST', { path: folder.path, mode: folder.mode, ...(options.restart ? { restart: true } : {}) });
}

export function removeAgentFolder(agent: string, path: string, options: { restart?: boolean } = {}): Promise<AgentFolders> {
  return send({ kind: 'agent', name: agent }, 'DELETE', { path, ...(options.restart ? { restart: true } : {}) });
}

/** What a folder path is, client side, before the daemon checks it: absolute on any of the three systems. */
export function isAbsoluteFolder(path: string): boolean {
  const p = path.trim();
  return p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('\\\\');
}

/** The last segment of a path, for a row title; the whole path goes in its status line. */
export function folderName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '');
  const last = trimmed.split(/[\\/]/).pop();
  return last && last.length > 0 ? last : path;
}
