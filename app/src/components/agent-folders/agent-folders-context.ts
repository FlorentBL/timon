'use client';

/**
 * What an occupant of the agent folders section is painted for: the extra
 * folders of one agent (its page, Workspace tab) or of a project and every
 * agent in it (the project's settings).
 *
 * The slot passes no props, so each host (`AgentFoldersSection`) puts its
 * lists here and the occupant reads them with `useAgentFolders()`. The host
 * owns the reads and the writes (`lib/agent-folders.ts`), the "saved" notice
 * and the folder browser: an occupant only paints and calls the gestures.
 */
import { createContext, useContext } from 'react';
import type { AgentFolderMode, FolderOwner } from '@/lib/agent-folders';

/** One folder of the section: whose list holds it, where, and how it may be reached. */
export type AgentFolderRow = {
  owner: FolderOwner;
  /** The folder's full path, as stored. */
  path: string;
  /** Its last segment, the name a row shows. */
  name: string;
  mode: AgentFolderMode;
  /** Why a launch leaves this stored folder out now (the daemon's reason, in English); `null` when it is applied. */
  dropped: string | null;
};

/** The answer of a gesture: recorded, or refused with the daemon's message. */
export type AgentFoldersResult = { ok: true } | { ok: false; message: string };

export type AgentFoldersValue = {
  /** The agents whose folders are listed: one on an agent's page, every agent of a project on its settings. */
  agents: readonly string[];
  /** The project whose own folders are listed first, on its settings; `null` on an agent's page. */
  project: string | null;
  /** Name the owner on each row: the project's list mixes several. */
  showAgent: boolean;
  /** The surface's own words for an empty list; `null` for the default. */
  emptyStatus: string | null;
  /** To put on the occupant's root. */
  className: string | undefined;
  /** `loading` until the first read; `error` when it failed (`reload` tries again). */
  status: 'loading' | 'ready' | 'error';
  /** Every folder, the project's first, in each list's order. */
  rows: readonly AgentFolderRow[];
  /** Whose lists a folder may be added to; empty while nothing is loaded. */
  owners: readonly FolderOwner[];
  /** A gesture is running. */
  busy: boolean;
  reload(): Promise<void>;
  /** Adds a folder to `owner`'s list, or changes its access when the path is already there. */
  add(owner: FolderOwner, folder: { path: string; mode: AgentFolderMode }): Promise<AgentFoldersResult>;
  /** Changes the access of a folder of `owner`'s list. */
  setMode(owner: FolderOwner, path: string, mode: AgentFolderMode): Promise<AgentFoldersResult>;
  /** Takes a folder out of `owner`'s list. */
  remove(owner: FolderOwner, path: string): Promise<AgentFoldersResult>;
  /**
   * Opens the folder browser of the active machine at `current`, and resolves
   * the folder chosen, or `null` when it was closed (the host already said why
   * when the browser could not open).
   */
  browse(current: string): Promise<string | null>;
};

const AgentFoldersContext = createContext<AgentFoldersValue | null>(null);

export const AgentFoldersProvider = AgentFoldersContext.Provider;

/** Readable by an occupant of the agent folders section; `null` outside one. */
export function useAgentFolders(): AgentFoldersValue | null {
  return useContext(AgentFoldersContext);
}
