/**
 * Whether a file the daemon is about to EXECUTE from a folder it did not
 * install could have been put there by another account (#1102, security
 * review). The roots of the version managers `node` is searched under
 * (`FNM_DIR`, `VOLTA_HOME`, mise, asdf) come from the daemon's environment,
 * and a service may point one at a shared folder: a `node` another account
 * replaced there would then run as the daemon, and outside any fence for the
 * provider sign-in.
 *
 * Kept only when the file, every folder from it up to the manager's root
 * (both the path as written and the one its links resolve to), belongs to the
 * daemon's account or to root, and none of them is writable by the group or by
 * others, but for a sticky folder owned by root (`/tmp`), whose entries only
 * their owner may rename or remove. A link that leads out of the root is
 * followed up to the filesystem root: nothing else bounds what it reaches.
 *
 * What a fenced mission can write is a separate question, answered by
 * `mission-writable.ts`: a folder of the daemon's own account passes here.
 */
import { realpathSync, statSync } from 'node:fs';
import { posix } from 'node:path';

export type TrustStat = { uid: number; mode: number; isDirectory: boolean };

export type TrustedTreeDeps = {
  platform?: NodeJS.Platform;
  /** The daemon's account; `process.getuid()` by default. */
  uid?: number;
  realpath?: (path: string) => string;
  stat?: (path: string) => TrustStat;
};

const GROUP_OR_OTHER_WRITE = 0o022;
const STICKY = 0o1000;

function diskStat(path: string): TrustStat {
  const stat = statSync(path);
  return { uid: stat.uid, mode: stat.mode, isDirectory: stat.isDirectory() };
}

function within(parent: string, child: string): boolean {
  const rel = posix.relative(parent, child);
  return rel === '' || (!rel.startsWith('../') && rel !== '..' && !posix.isAbsolute(rel));
}

/** `from`'s folder and each one above it, up to `stop` when it lies beneath it, else to `/`. */
function foldersUp(from: string, stop: string): string[] {
  const bound = within(stop, from) ? stop : posix.parse(from).root;
  const out: string[] = [];
  for (let dir = posix.dirname(from); ; dir = posix.dirname(dir)) {
    out.push(dir);
    if (dir === bound || dir === posix.dirname(dir)) break;
  }
  return out;
}

/**
 * Why `file`, found under the version manager root `root`, may come from
 * another account, or null when it may not. Both paths are absolute.
 */
export function untrustedTreeProblem(file: string, root: string, deps: TrustedTreeDeps = {}): string | null {
  const platform = deps.platform ?? process.platform;
  // portability: Windows has no POSIX owner or mode bits and its ACLs are not read here; binary-path.ts keeps a manager root outside the user's profile instead.
  if (platform === 'win32') return null;
  const uid = deps.uid ?? (typeof process.getuid === 'function' ? process.getuid() : undefined);
  if (uid === undefined) return 'no account to compare owners with';
  const realpath = deps.realpath ?? realpathSync;
  const stat = deps.stat ?? diskStat;
  let realFile: string;
  let realRoot: string;
  try {
    realFile = realpath(file);
    realRoot = realpath(root);
  } catch {
    return 'cannot be resolved';
  }
  // The folders the path is written through hold its links: whoever writes one can swap them.
  const folders = new Set([...foldersUp(file, root), ...foldersUp(realFile, realRoot)]);
  const checks: Array<{ path: string; folder: boolean }> = [
    { path: realFile, folder: false },
    ...[...folders].map((path) => ({ path, folder: true })),
  ];
  for (const { path, folder } of checks) {
    let info: TrustStat;
    try { info = stat(path); } catch { return `${path} cannot be read`; }
    if (folder !== info.isDirectory) return `${path} is not a ${folder ? 'folder' : 'file'}`;
    if (info.uid !== uid && info.uid !== 0) return `${path} belongs to another account`;
    if ((info.mode & GROUP_OR_OTHER_WRITE) === 0) continue;
    if (folder && info.uid === 0 && (info.mode & STICKY) !== 0) continue;
    return `${path} is writable by its group or by others`;
  }
  return null;
}
