'use client';

/**
 * What the occupant of a project's window reads (`project-edit-dialog.tsx`):
 * the project, and the gestures the host keeps. The occupant draws the window
 * and holds the draft; the host reads the record, writes it, deletes the
 * project and settles the fate of its agents, so a replacement never needs a
 * route of the daemon.
 *
 * Internal for now: the slot `project.edit.dialog` is reserved, not declared,
 * and this hook is not exported by `@timon/ui`. Both reach the SDK with the
 * next client API (docs/SDK-COMPAT.md), which also fixes this shape for
 * plugins: until then it may still change.
 */

import { createContext, useContext } from 'react';

/** A project as the window edits it; empty strings for unset fields. */
export type ProjectEditFields = {
  slug: string;
  name: string;
  color: string;
  icon: string;
  workspace: string;
  cwd: string;
  speech: string;
};

/** The agents a deletion was refused for, and where they could go. */
export type ProjectAgentsFate = { agents: string[]; others: string[] };

/** What happens to those agents: `move` needs `to`, one of `others`. */
export type ProjectAgentsChoice = { mode: 'delete' | 'detach' } | { mode: 'move'; to: string };

export type ProjectEditDialogValue = {
  /** `null` = creation; otherwise the slug of the project being edited. */
  slug: string | null;
  /** The stored record once read (edit only); `null` while it is read, on creation, or when it cannot be read. */
  project: ProjectEditFields | null;
  /** The gesture under way: the occupant greys its buttons. */
  busy: 'save' | 'delete' | null;
  /**
   * Creates or updates the project from `fields`; empty fields are left out.
   * The host says how it went (a refused slug, the daemon's refusal, a
   * working directory it cannot use), closes the window and resolves `true`
   * once written.
   */
  save: (fields: ProjectEditFields) => Promise<boolean>;
  /**
   * Deletes the project after asking for confirmation (edit only, `null` on
   * creation). When agents are left in it, the daemon refuses and `fate`
   * lists them: the occupant offers the choice and calls `settleFate`.
   */
  remove: (() => Promise<boolean>) | null;
  fate: ProjectAgentsFate | null;
  /** Deletes again with the chosen fate, or drops the question with `null`. */
  settleFate: (choice: ProjectAgentsChoice | null) => Promise<boolean>;
  close: () => void;
};

export const ProjectEditDialogContext = createContext<ProjectEditDialogValue | null>(null);

/** The project the window paints, and its gestures. */
export function useProjectEditDialog(): ProjectEditDialogValue | null {
  return useContext(ProjectEditDialogContext);
}
