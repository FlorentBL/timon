/**
 * `/api/projects/:slug/extra-dirs`: the folders outside their working
 * directories every mission of a project may read or write
 * (`project-extra-dirs.ts`, TODO #1168).
 *
 *   GET    → { project, extra_dirs, dropped }
 *   PUT    { extra_dirs: [{ path, mode }] }  the whole list
 *   POST   { path, mode }                     adds a folder, or changes its mode
 *   DELETE { path }                           removes a folder
 *
 * A write answers like GET. It applies from each mission's next process: the
 * fence is fixed when a process starts.
 *
 * Who writes: a person, from the app (a browser session or a paired device),
 * holding `projects:manage` and `agents:privileged-config`. The daemon token
 * and a mission token are refused whatever they hold: a folder opened to a
 * whole project reaches every agent in it, and no agent opens one to itself
 * or to its teammates. Reading takes `projects:read`, never anonymously. Each
 * path must be an existing folder that `extraDirFenceProblem` accepts: never
 * the Timon home nor one of its ancestors, never a folder of credentials.
 */
import type express from 'express';
import type { Request, Response } from 'express';
import { resolve } from 'node:path';
import { z } from 'zod';
import { apiError } from '../../api-error.js';
import {
  ExtraDirError, extraDirProblem, extraDirSchema, extraDirsSchema, normalizeExtraDirs, type AgentExtraDir,
} from '../../agent-extra-dirs.js';
import { ensureProjectRow, projectExtraDirs, setProjectExtraDirs } from '../../project-extra-dirs.js';
import { listProjects } from '../../projects.js';
import { auditRequest } from '../../users/audit-actor.js';
import { isPersonAuth, rejectIfDenied, rejectUnlessAny, requestHasPermission } from '../../users/identity.js';
import { PRIVILEGED_CONFIG_PERMISSION, rejectOverride } from '../../users/privileged-overrides.js';

const putSchema = z.object({ extra_dirs: extraDirsSchema }).strict();
const postSchema = extraDirSchema.strict();
const deleteSchema = z.object({ path: z.string().trim().min(1).max(4096) }).strict();
const SlugSchema = z.string().regex(/^[A-Za-z0-9._-]{1,64}$/);

/** The project the route names, or null after a 404 was sent. */
function targetProject(req: Request, res: Response): string | null {
  const raw = String(req.params.slug ?? '');
  const slug = SlugSchema.safeParse(raw);
  if (!slug.success || !listProjects().includes(slug.data)) {
    res.status(404).json(apiError('project_not_found', `project not found: ${raw}`));
    return null;
  }
  return slug.data;
}

function rejectAnonymous(req: Request, res: Response): boolean {
  if (req.auth) return false;
  res.status(401).json({ error: 'unauthorized' });
  return true;
}

/**
 * Why `req` may not change the folders of a project, after the response was
 * sent; `false` when it may. Removing takes the same rights as adding: the
 * list is one setting, and its writer one kind of caller.
 */
export function rejectProjectFoldersWriter(req: Request, res: Response, project: string): boolean {
  if (rejectAnonymous(req, res)) return true;
  if (!isPersonAuth(req.auth)) {
    return rejectOverride(req, res, 'project.extra_dirs_denied', `project:${project}`,
      'the folders a project may reach are set by a person, from the project\'s settings in the app');
  }
  if (rejectIfDenied(req, res, 'projects:manage')) return true;
  if (!requestHasPermission(req, PRIVILEGED_CONFIG_PERMISSION)) {
    return rejectOverride(req, res, 'project.extra_dirs_denied', `project:${project}`,
      `opening a folder to a project needs the ${PRIVILEGED_CONFIG_PERMISSION} permission`);
  }
  return false;
}

/** The stored folders that a launch would leave out now, with the reason. */
function droppedDirs(dirs: readonly AgentExtraDir[]): Array<{ path: string; reason: string }> {
  return dirs.flatMap((dir) => {
    const reason = extraDirProblem(dir.path);
    return reason ? [{ path: dir.path, reason }] : [];
  });
}

function view(project: string, dirs: readonly AgentExtraDir[]): Record<string, unknown> {
  return { project, extra_dirs: dirs, dropped: droppedDirs(dirs) };
}

export function registerProjectExtraDirsRoutes(app: express.IRouter): void {
  app.get('/api/projects/:slug/extra-dirs', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (rejectAnonymous(req, res)) return;
    if (rejectUnlessAny(req, res, ['projects:read', 'projects:manage'])) return;
    const project = targetProject(req, res);
    if (!project) return;
    res.json(view(project, projectExtraDirs(project)));
  });

  const write = (req: Request, res: Response, next: (current: AgentExtraDir[]) => unknown): void => {
    res.setHeader('Cache-Control', 'no-store');
    const project = targetProject(req, res);
    if (!project) return;
    if (rejectProjectFoldersWriter(req, res, project)) return;
    const before = projectExtraDirs(project);
    let dirs: AgentExtraDir[];
    try {
      dirs = normalizeExtraDirs(next(before), before);
    } catch (err) {
      if (err instanceof ExtraDirError) {
        res.status(400).json(apiError('extra_dir_refused', err.message, err.path ? { path: err.path } : undefined));
        return;
      }
      throw err;
    }
    ensureProjectRow(project);
    const stored = setProjectExtraDirs(project, dirs);
    if (JSON.stringify(before) !== JSON.stringify(stored)) {
      auditRequest(req, 'project.extra_dirs', `project:${project} ${stored.map((d) => `${d.mode} ${d.path}`).join(', ') || '(none)'}`);
    }
    res.json(view(project, stored));
  };

  app.put('/api/projects/:slug/extra-dirs', (req, res) => {
    if (rejectAnonymous(req, res)) return;
    const body = putSchema.safeParse(req.body ?? {});
    if (!body.success) {
      res.status(400).json(apiError('extra_dirs_invalid', 'expected { extra_dirs: [{ path, mode: "read" | "write" }] }'));
      return;
    }
    write(req, res, () => body.data.extra_dirs);
  });

  app.post('/api/projects/:slug/extra-dirs', (req, res) => {
    if (rejectAnonymous(req, res)) return;
    const body = postSchema.safeParse(req.body ?? {});
    if (!body.success) {
      res.status(400).json(apiError('extra_dirs_invalid', 'expected { path, mode: "read" | "write" }'));
      return;
    }
    const { path, mode } = body.data;
    write(req, res, (current) => {
      // A folder already listed changes mode in place: the list keeps its order.
      const key = resolve(path);
      return current.some((d) => resolve(d.path) === key)
        ? current.map((d) => (resolve(d.path) === key ? { path: d.path, mode } : d))
        : [...current, { path, mode }];
    });
  });

  app.delete('/api/projects/:slug/extra-dirs', (req, res) => {
    if (rejectAnonymous(req, res)) return;
    const body = deleteSchema.safeParse(req.body ?? {});
    if (!body.success) {
      res.status(400).json(apiError('extra_dirs_invalid', 'expected { path }'));
      return;
    }
    const key = resolve(body.data.path);
    write(req, res, (current) => current.filter((d) => resolve(d.path) !== key));
  });
}
