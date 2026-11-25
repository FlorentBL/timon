/**
 * Whether a file the daemon is about to EXECUTE from a folder it did not
 * install could have been put there by another account (#1102, security
 * review). The roots of the version managers `node` is searched under
 * (`FNM_DIR`, `VOLTA_HOME`, mise, asdf) come from the daemon's environment,
 * and a service may point one at a shared folder: a `node` another account
 * replaced there would then run as the daemon, and outside any fence for the
 * provider sign-in.
 *
 * The path is walked the way the kernel resolves it, one component at a time
 * from `/`: every component must belong to the daemon's account or to root,
 * and none may be writable by the group or by others, but for a sticky folder
 * owned by root (`/tmp`), whose entries only their owner may rename or remove.
 * A link is read with `lstat`, and its target walked the same way from its own
 * start, so each step of a chain of links is checked: `realpath` alone keeps
 * only the end of it, and whoever can write a folder above the manager's root,
 * or a folder a link passes through, can swap the whole tree below.
 *
 * What a fenced mission can write is a separate question, answered by
 * `mission-writable.ts`: a folder of the daemon's own account passes here.
 */
import { lstatSync, readlinkSync } from 'node:fs';
import { posix } from 'node:path';

export type TrustKind = 'file' | 'directory' | 'link' | 'other';

export type TrustStat = { uid: number; mode: number; kind: TrustKind };

export type TrustedTreeDeps = {
  platform?: NodeJS.Platform;
  /** The daemon's account; `process.getuid()` by default. */
  uid?: number;
  /** What the path itself is, links not followed. */
  lstat?: (path: string) => TrustStat;
  readlink?: (path: string) => string;
};

const GROUP_OR_OTHER_WRITE = 0o022;
const STICKY = 0o1000;
/** Linux's own limit (`MAXSYMLINKS`): a longer chain is a loop or a trap. */
const MAX_LINKS = 40;

/** One path as the disk reports it, links not followed. */
export function diskTrustStat(path: string): TrustStat {
  const stat = lstatSync(path);
  const kind: TrustKind = stat.isSymbolicLink() ? 'link' : stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'other';
  return { uid: stat.uid, mode: stat.mode, kind };
}

type Walk = {
  uid: number;
  lstat: (path: string) => TrustStat;
  readlink: (path: string) => string;
  links: number;
};

type Reached = { real: string; kind: TrustKind } | { problem: string };

/** Why the entry at `path` could be swapped by another account, or null. Its links are judged by their owner only: nobody can rewrite one in place. */
function entryProblem(path: string, info: TrustStat, uid: number): string | null {
  if (info.uid !== uid && info.uid !== 0) return `${path} belongs to another account`;
  if (info.kind === 'link' || (info.mode & GROUP_OR_OTHER_WRITE) === 0) return null;
  if (info.kind === 'directory' && info.uid === 0 && (info.mode & STICKY) !== 0) return null;
  return `${path} is writable by its group or by others`;
}

function look(path: string, walk: Walk): TrustStat | string {
  try { return walk.lstat(path); } catch { return `${path} cannot be read`; }
}

/**
 * Walks absolute `path` from `/`, checking every component and following every
 * link through a walk of its own. `..` steps back from the folder reached so
 * far, as the kernel does, never lexically from the path as written.
 */
function reach(path: string, walk: Walk): Reached {
  const top = look('/', walk);
  if (typeof top === 'string') return { problem: top };
  const rootProblem = entryProblem('/', top, walk.uid);
  if (rootProblem) return { problem: rootProblem };
  let current = '/';
  let kind: TrustKind = top.kind;
  const parts = path.split('/').filter((part) => part !== '' && part !== '.');
  for (let i = 0; i < parts.length; i++) {
    const name = parts[i]!;
    if (kind !== 'directory') return { problem: `${current} is not a folder` };
    if (name === '..') {
      // Every folder above `current` was walked to reach it.
      current = posix.dirname(current);
      continue;
    }
    const next = current === '/' ? `/${name}` : `${current}/${name}`;
    const info = look(next, walk);
    if (typeof info === 'string') return { problem: info };
    const problem = entryProblem(next, info, walk.uid);
    if (problem) return { problem };
    if (info.kind !== 'link') {
      current = next;
      kind = info.kind;
      continue;
    }
    if (++walk.links > MAX_LINKS) return { problem: `${path} goes through too many links` };
    let target: string;
    try { target = walk.readlink(next); } catch { return { problem: `${next} cannot be read` }; }
    // Joined as text, not with `posix.join`: a `..` in the target is resolved by the walk, after the links before it.
    const followed = reach(target.startsWith('/') ? target : `${current}/${target}`, walk);
    if ('problem' in followed) return followed;
    current = followed.real;
    kind = followed.kind;
  }
  return { real: current, kind };
}

/**
 * Why the file at absolute `file` may come from another account, or null when
 * it may not. Every component of the path as written, and of each link it goes
 * through, is checked up to `/`.
 */
export function untrustedPathProblem(file: string, deps: TrustedTreeDeps = {}): string | null {
  const platform = deps.platform ?? process.platform;
  // portability: Windows has no POSIX owner or mode bits and its ACLs are not read here; binary-path.ts keeps a manager root outside the user's profile instead.
  if (platform === 'win32') return null;
  const uid = deps.uid ?? (typeof process.getuid === 'function' ? process.getuid() : undefined);
  if (uid === undefined) return 'no account to compare owners with';
  if (!posix.isAbsolute(file)) return `${file} is not an absolute path`;
  const reached = reach(file, {
    uid,
    lstat: deps.lstat ?? diskTrustStat,
    readlink: deps.readlink ?? ((path) => readlinkSync(path)),
    links: 0,
  });
  if ('problem' in reached) return reached.problem;
  if (reached.kind !== 'file') return `${reached.real} is not a file`;
  return null;
}
