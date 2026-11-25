/**
 * An agent's extra folders (`extra_dirs` of its config file, TODO #505): the
 * folders outside its working directory a person lets its missions read, or
 * read and write. The fence grants them (`host/isolation.ts`, `extraDirs` of
 * the target) and the backends are told (`BuildSpawnOpts.extraDirs`: Claude's
 * and Copilot's `--add-dir`, Codex's `writable_roots`).
 *
 * A protected key of the config (`agent-config.ts`): no agent write, no
 * import and no prompt rewrite sets it. `setAgentExtraDirs` is its one door,
 * behind the routes of `plugins-bundled/agents/extra-dirs-routes.ts`, which
 * take a person or a holder of `agents:privileged-config`, never the agent
 * itself. Every path is checked twice: when it is stored, and again at each
 * launch, since the config file can be edited by hand.
 */
import { existsSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import { loadConfig, validName, type AgentConfig } from './agent-config.js';
import { config as timonConfig } from './config/load.js';
import { extraDirFenceProblem, type FenceExtraDir } from './host/isolation.js';
import { agentConfig, agentDir, TIMON_HOME } from './paths.js';

export type ExtraDirMode = FenceExtraDir['mode'];
export type AgentExtraDir = FenceExtraDir;

/** More would only feed a launch line no CLI reads to the end. */
export const MAX_EXTRA_DIRS = 32;

export const extraDirSchema = z.object({
  path: z.string().trim().min(1).max(4096),
  mode: z.enum(['read', 'write']),
}).strict();

export const extraDirsSchema = z.array(extraDirSchema).max(MAX_EXTRA_DIRS);

/** Why `path` may not be an extra folder, or `null`. Checks the disk: it must be an existing folder. */
export function extraDirProblem(path: string, checks: { timonHome?: string; home?: string } = {}): string | null {
  if (!isAbsolute(path)) return 'the path must be absolute';
  const normalized = resolve(path);
  try {
    if (!existsSync(normalized)) return 'the folder does not exist';
    if (!statSync(normalized).isDirectory()) return 'the path is not a folder';
  } catch {
    return 'the folder cannot be read';
  }
  return extraDirFenceProblem(timonConfig(), normalized, {
    timonHome: checks.timonHome ?? TIMON_HOME,
    ...(checks.home ? { home: checks.home } : {}),
  });
}

/**
 * The list as it is stored: paths normalised, one entry per folder (the last
 * mode given wins). Every entry that grants more than `current` (a new
 * folder, `read` to `write`) is checked; one already held passes as it is, so
 * a folder removed from the disk since never blocks removing another one, and
 * the launch checks it anyway. Throws `ExtraDirError` on the first refusal,
 * naming the folder.
 */
export function normalizeExtraDirs(
  input: unknown,
  current: readonly AgentExtraDir[] = [],
  checks?: { timonHome?: string; home?: string },
): AgentExtraDir[] {
  const parsed = extraDirsSchema.safeParse(input);
  if (!parsed.success) {
    throw new ExtraDirError(`extra_dirs must be a list of at most ${MAX_EXTRA_DIRS} { path, mode: "read" | "write" } entries`);
  }
  const byPath = new Map<string, ExtraDirMode>();
  for (const entry of parsed.data) {
    if (!isAbsolute(entry.path)) throw new ExtraDirError(`${entry.path}: the path must be absolute`, entry.path);
    byPath.set(resolve(entry.path), entry.mode);
  }
  const dirs = [...byPath].map(([path, mode]) => ({ path, mode }));
  for (const entry of extraDirsWidening(dirs, current)) {
    const problem = extraDirProblem(entry.path, checks);
    if (problem) throw new ExtraDirError(`${entry.path}: ${problem}`, entry.path);
  }
  return dirs;
}

export class ExtraDirError extends Error {
  constructor(message: string, readonly path?: string) {
    super(message);
    this.name = 'ExtraDirError';
  }
}

/** What the agent's config file holds, well-formed entries only; never checked against the disk. */
export function storedExtraDirs(cfg: Pick<AgentConfig, 'extra_dirs'>): AgentExtraDir[] {
  const parsed = extraDirsSchema.safeParse(cfg.extra_dirs ?? []);
  return parsed.success ? parsed.data : [];
}

/** The agent's extra folders, as stored. An unknown agent has none. */
export function agentExtraDirs(name: string): AgentExtraDir[] {
  try {
    return storedExtraDirs(loadConfig(name));
  } catch {
    return [];
  }
}

/**
 * The extra folders a launch of `name` hands the fence and the backend: the
 * stored ones that still pass every check. One dropped is reported to `warn`
 * and left out, never turned into a refusal of the mission.
 */
export function launchExtraDirs(name: string, warn: (message: string) => void = () => {}): AgentExtraDir[] {
  const out: AgentExtraDir[] = [];
  for (const dir of agentExtraDirs(name)) {
    const problem = extraDirProblem(dir.path);
    if (problem) {
      warn(`extra folder ${dir.path} of agent ${name} left out: ${problem}`);
      continue;
    }
    out.push({ path: resolve(dir.path), mode: dir.mode });
  }
  return out;
}

/**
 * The entries of `next` that grant more than `current`: a folder not there
 * before, or one going from `read` to `write`. Removing, or narrowing to
 * `read`, grants nothing.
 */
export function extraDirsWidening(next: readonly AgentExtraDir[], current: readonly AgentExtraDir[]): AgentExtraDir[] {
  const held = new Map(current.map((d) => [resolve(d.path), d.mode]));
  return next.filter((d) => {
    const before = held.get(resolve(d.path));
    return before === undefined || (before === 'read' && d.mode === 'write');
  });
}

/**
 * Writes the whole list (already normalised by `normalizeExtraDirs`); an
 * empty list removes the key. Returns what the file holds now.
 */
export function setAgentExtraDirs(name: string, dirs: readonly AgentExtraDir[]): AgentExtraDir[] {
  validName(name);
  if (!existsSync(agentDir(name))) throw new Error(`agent not found: ${name}`);
  const current = loadConfig(name);
  const next: AgentConfig = { ...current };
  if (dirs.length === 0) delete next.extra_dirs;
  else next.extra_dirs = dirs.map((d) => ({ path: d.path, mode: d.mode }));
  writeFileSync(agentConfig(name), JSON.stringify(next, null, 2));
  return storedExtraDirs(next);
}
