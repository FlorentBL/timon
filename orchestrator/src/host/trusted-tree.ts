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
 * One write bit is tolerated (#1202): the group's, on an entry of the
 * daemon's own account whose group is that account's private group, as a 002
 * umask leaves fnm's folders on Ubuntu. Only that account can join such a
 * group, so the bit lets nobody else in (`privateGroupOf`).
 *
 * What a fenced mission can write is a separate question, answered by
 * `mission-writable.ts`: a folder of the daemon's own account passes here.
 */
import { lstatSync, readFileSync, readlinkSync } from 'node:fs';
import { posix } from 'node:path';

export type TrustKind = 'file' | 'directory' | 'link' | 'other';

/** `gid` unknown: a group write bit is never tolerated. */
export type TrustStat = { uid: number; gid?: number; mode: number; kind: TrustKind };

export type TrustedTreeDeps = {
  platform?: NodeJS.Platform;
  /** The daemon's account; `process.getuid()` by default. */
  uid?: number;
  /** What the path itself is, links not followed. */
  lstat?: (path: string) => TrustStat;
  readlink?: (path: string) => string;
  /**
   * The daemon's private group (`privateGroupOf`), `null` when it has none.
   * Read from the account files by default, but only for the daemon's own
   * account: an injected `uid` has no private group unless one is injected too.
   */
  privateGroup?: () => number | null;
};

const GROUP_OR_OTHER_WRITE = 0o022;
const OTHER_WRITE = 0o002;
const STICKY = 0o1000;
/** Linux's own limit (`MAXSYMLINKS`): a longer chain is a loop or a trap. */
const MAX_LINKS = 40;

/** One path as the disk reports it, links not followed. */
export function diskTrustStat(path: string): TrustStat {
  const stat = lstatSync(path);
  const kind: TrustKind = stat.isSymbolicLink() ? 'link' : stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'other';
  return { uid: stat.uid, gid: stat.gid, mode: stat.mode, kind };
}

/** The account files `privateGroupOf` reads, as text. */
export type AccountFiles = { passwd: string; group: string };

function fields(text: string): string[][] {
  return text.split(/\r?\n/).filter((line) => line.trim() !== '' && !line.startsWith('#')).map((line) => line.split(':'));
}

/**
 * The gid of `uid`'s private group, or null when it has none: its primary
 * group in `passwd`, named after it, listed once in `group` with no member
 * but itself, and the primary group of no other account. Only what the local
 * files say counts: an account or a group from a directory service (LDAP,
 * NIS, macOS's Directory Services, `+` lines) is never one, so its folders
 * keep needing `chmod g-w`.
 */
export function privateGroupOf(uid: number, files: AccountFiles): number | null {
  const passwd = fields(files.passwd);
  const group = fields(files.group);
  // A compat line imports a directory service's entries, whose members these files do not show.
  if ([...passwd, ...group].some((entry) => /^[+-]/.test(entry[0] ?? ''))) return null;
  const own = passwd.find((entry) => entry.length >= 4 && Number(entry[2]) === uid);
  if (!own) return null;
  const name = own[0]!;
  const gid = Number(own[3]);
  if (!name || !Number.isInteger(gid) || gid <= 0) return null;
  // A second account with that primary group is a member the group line does not list.
  if (passwd.some((entry) => entry.length >= 4 && Number(entry[3]) === gid && Number(entry[2]) !== uid)) return null;
  const lines = group.filter((entry) => entry.length >= 3 && Number(entry[2]) === gid);
  if (lines.length !== 1) return null;
  const [groupName, , , members = ''] = lines[0]!;
  if (groupName !== name) return null;
  return members.split(',').map((member) => member.trim()).every((member) => member === '' || member === name) ? gid : null;
}

function diskPrivateGroup(uid: number): number | null {
  try {
    // portability: POSIX account files, read only on Linux and macOS (Windows returns before any walk).
    return privateGroupOf(uid, { passwd: readFileSync('/etc/passwd', 'utf8'), group: readFileSync('/etc/group', 'utf8') });
  } catch {
    return null;
  }
}

type Walk = {
  uid: number;
  privateGroup: () => number | null;
  lstat: (path: string) => TrustStat;
  readlink: (path: string) => string;
  links: number;
};

type Reached = { real: string; kind: TrustKind } | { problem: string };

/** Why the entry at `path` could be swapped by another account, or null. Its links are judged by their owner only: nobody can rewrite one in place. */
function entryProblem(path: string, info: TrustStat, walk: Walk): string | null {
  const { uid } = walk;
  if (info.uid !== uid && info.uid !== 0) return `${path} belongs to another account`;
  if (info.kind === 'link' || (info.mode & GROUP_OR_OTHER_WRITE) === 0) return null;
  if (info.kind === 'directory' && info.uid === 0 && (info.mode & STICKY) !== 0) return null;
  // Root's entries keep refusing a group bit: the private group is a matter of the daemon's own folders.
  if ((info.mode & OTHER_WRITE) === 0 && info.uid === uid && info.gid !== undefined && info.gid === walk.privateGroup()) return null;
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
  const rootProblem = entryProblem('/', top, walk);
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
    const problem = entryProblem(next, info, walk);
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
    const followed = reach(target.startsWith('/') ? target : `${current}/${target}`, walk); // portability: POSIX paths only, Windows returns before any walk
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
  let privateGroup: number | null | undefined;
  const findPrivateGroup = deps.privateGroup ?? (deps.uid === undefined ? () => diskPrivateGroup(uid) : () => null);
  const reached = reach(file, {
    uid,
    // Read once, and only when an entry carries a group write bit.
    privateGroup: () => (privateGroup === undefined ? (privateGroup = findPrivateGroup()) : privateGroup),
    lstat: deps.lstat ?? diskTrustStat,
    readlink: deps.readlink ?? ((path) => readlinkSync(path)),
    links: 0,
  });
  if ('problem' in reached) return reached.problem;
  if (reached.kind !== 'file') return `${reached.real} is not a file`;
  return null;
}
