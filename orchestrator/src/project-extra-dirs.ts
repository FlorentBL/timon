/**
 * A project's extra folders (`projects.extra_dirs`, TODO #1168): the folders
 * outside their working directories that every mission of the project may
 * read, or read and write — the project-wide twin of an agent's
 * `extra_dirs` (`agent-extra-dirs.ts`), for a folder several agents of one
 * project need (a second repository, a shared data folder).
 *
 * Same list, same checks: an existing absolute folder that
 * `extraDirFenceProblem` accepts, never the Timon home nor one of its
 * ancestors, a whole home folder, a disk's root or a folder of credentials.
 * Checked when it is stored and again at each launch, where the project's
 * folders join the agent's (`missionExtraDirs`).
 *
 * The column is written through `setProjectExtraDirs` alone, behind
 * `plugins-bundled/projects/extra-dirs-routes.ts` and the fence card's
 * "Allow for the project": a person's gesture, never an agent's.
 */
import { resolve } from 'node:path';
import {
  extraDirProblem, extraDirsSchema, launchExtraDirs, type AgentExtraDir, type ExtraDirMode,
} from './agent-extra-dirs.js';
import { dbApi } from './db.js';
import { readMetaFile, writeMeta } from './projects.js';

/** What the project row holds, well-formed entries only; never checked against the disk. */
export function storedProjectExtraDirs(json: string | null | undefined): AgentExtraDir[] {
  if (!json) return [];
  try {
    const parsed = extraDirsSchema.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

/** The project's extra folders, as stored. An unknown project, or none, has none. */
export function projectExtraDirs(slug: string | null | undefined): AgentExtraDir[] {
  if (!slug) return [];
  try {
    return storedProjectExtraDirs(dbApi.getProjectRow(slug)?.extra_dirs);
  } catch {
    return [];
  }
}

/** A project known only by its folder gets its row, where the list is stored. */
export function ensureProjectRow(slug: string): void {
  if (dbApi.getProjectRow(slug)) return;
  writeMeta(slug, readMetaFile(slug) ?? {});
}

/**
 * Writes the whole list (already normalised by `normalizeExtraDirs`); an
 * empty list clears the column. Returns what the row holds now. Throws when
 * the project does not exist.
 */
export function setProjectExtraDirs(slug: string, dirs: readonly AgentExtraDir[]): AgentExtraDir[] {
  const json = dirs.length === 0 ? null : JSON.stringify(dirs.map((d) => ({ path: d.path, mode: d.mode })));
  if (!dbApi.setProjectExtraDirs(slug, json)) throw new Error(`project not found: ${slug}`);
  return storedProjectExtraDirs(json);
}

/**
 * The project's folders a launch hands the fence and the backend: the stored
 * ones that still pass every check. One dropped is reported to `warn` and
 * left out, never turned into a refusal of the mission.
 */
export function launchProjectExtraDirs(slug: string | null | undefined, warn: (message: string) => void = () => {}): AgentExtraDir[] {
  const out: AgentExtraDir[] = [];
  for (const dir of projectExtraDirs(slug)) {
    const problem = extraDirProblem(dir.path);
    if (problem) {
      warn(`extra folder ${dir.path} of project ${slug} left out: ${problem}`);
      continue;
    }
    out.push({ path: resolve(dir.path), mode: dir.mode });
  }
  return out;
}

/** One entry per folder, the wider access kept: `write` from either list wins. */
export function mergeExtraDirs(...lists: ReadonlyArray<readonly AgentExtraDir[]>): AgentExtraDir[] {
  const byPath = new Map<string, ExtraDirMode>();
  for (const list of lists) {
    for (const dir of list) {
      const key = resolve(dir.path);
      if (byPath.get(key) !== 'write') byPath.set(key, dir.mode);
    }
  }
  return [...byPath].map(([path, mode]) => ({ path, mode }));
}

/** The folders a mission of `agent` in `project` gets: the agent's, then the project's. */
export function missionExtraDirs(agent: string, project: string | null | undefined, warn: (message: string) => void = () => {}): AgentExtraDir[] {
  return mergeExtraDirs(launchExtraDirs(agent, warn), launchProjectExtraDirs(project, warn));
}
