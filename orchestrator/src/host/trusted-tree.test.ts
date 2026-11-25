import { test } from 'node:test';
import assert from 'node:assert/strict';
import { untrustedPathProblem, type TrustKind, type TrustStat, type TrustedTreeDeps } from './trusted-tree.js';

/**
 * A whole filesystem in a table: nothing here reads the machine's own folders,
 * whose owners and modes differ from one runner to the next (a CI sandbox
 * reports `/tmp` under uid 65534).
 */
const UID = 1000;
const OTHER = 1001;

type Entry = { kind: TrustKind; uid?: number; mode?: number; target?: string };

function tree(entries: Record<string, Entry>): TrustedTreeDeps {
  const table: Record<string, Entry> = { '/': { kind: 'directory' }, ...entries };
  const lstat = (path: string): TrustStat => {
    const entry = table[path];
    if (!entry) throw new Error(`ENOENT ${path}`);
    const owner = entry.uid ?? (entry.kind === 'directory' ? 0 : UID);
    const mode = entry.mode ?? (entry.kind === 'directory' ? 0o755 : entry.kind === 'link' ? 0o777 : 0o755);
    return { uid: owner, mode, kind: entry.kind };
  };
  const readlink = (path: string): string => {
    const target = table[path]?.target;
    if (target === undefined) throw new Error(`EINVAL ${path}`);
    return target;
  };
  return { platform: 'linux', uid: UID, lstat, readlink };
}

/** fnm's layout under a user's home, every folder as a 022 umask leaves it. */
const fnmHome: Record<string, Entry> = {
  '/home': { kind: 'directory' },
  '/home/sam': { kind: 'directory', uid: UID, mode: 0o750 },
  '/home/sam/.fnm': { kind: 'directory', uid: UID },
  '/home/sam/.fnm/node-versions': { kind: 'directory', uid: UID },
  '/home/sam/.fnm/node-versions/v22': { kind: 'directory', uid: UID },
  '/home/sam/.fnm/node-versions/v22/bin': { kind: 'directory', uid: UID },
  '/home/sam/.fnm/node-versions/v22/bin/node': { kind: 'file' },
};
const fnmNode = '/home/sam/.fnm/node-versions/v22/bin/node';

test('#1102 review: a node whose every folder up to / is the daemon\'s or root\'s is kept', () => {
  assert.equal(untrustedPathProblem(fnmNode, tree(fnmHome)), null);
  // The file itself, writable by others or owned by them.
  assert.match(untrustedPathProblem(fnmNode, tree({ ...fnmHome, [fnmNode]: { kind: 'file', mode: 0o775 } })) ?? '', /node is writable by its group/);
  assert.match(untrustedPathProblem(fnmNode, tree({ ...fnmHome, [fnmNode]: { kind: 'file', uid: OTHER } })) ?? '', /node belongs to another account/);
});

test('#1102 review: a sound manager root under a parent another account can write is refused', () => {
  // The parent above the root, then `/` itself: whoever writes one can swap the root whole.
  for (const parent of ['/home', '/home/sam', '/']) {
    const writable = tree({ ...fnmHome, [parent]: { kind: 'directory', uid: parent === '/home/sam' ? UID : 0, mode: 0o777 } });
    assert.equal(untrustedPathProblem(fnmNode, writable), `${parent} is writable by its group or by others`);
    const theirs = tree({ ...fnmHome, [parent]: { kind: 'directory', uid: OTHER } });
    assert.equal(untrustedPathProblem(fnmNode, theirs), `${parent} belongs to another account`);
  }
  // A sticky folder of root's (`/tmp`) lets nobody rename what others own in it; a sticky one of another account does not count.
  assert.equal(untrustedPathProblem(fnmNode, tree({ ...fnmHome, '/home': { kind: 'directory', mode: 0o1777 } })), null);
  assert.match(untrustedPathProblem(fnmNode, tree({ ...fnmHome, '/home/sam': { kind: 'directory', uid: UID, mode: 0o1777 } })) ?? '', /writable/);
  // A missing component is a refusal, not a pass.
  const { '/home/sam/.fnm': _gone, ...partial } = fnmHome;
  assert.match(untrustedPathProblem(fnmNode, tree(partial)) ?? '', /\/home\/sam\/\.fnm cannot be read/);
});

test('#1102 review: each link of a chain is read where it stands, and its target walked from /', () => {
  // `aliases/default` -> `../node-versions/v22` (relative), and `node-versions` -> `/opt/shared/versions` (absolute).
  const chain = (shared: Entry, extra: Record<string, Entry> = {}): TrustedTreeDeps => tree({
    '/home': { kind: 'directory' },
    '/home/sam': { kind: 'directory', uid: UID },
    '/home/sam/.fnm': { kind: 'directory', uid: UID },
    '/home/sam/.fnm/aliases': { kind: 'directory', uid: UID },
    '/home/sam/.fnm/aliases/default': { kind: 'link', target: '../node-versions/v22' },
    '/home/sam/.fnm/node-versions': { kind: 'link', target: '/opt/shared/versions' },
    '/opt': { kind: 'directory' },
    '/opt/shared': shared,
    '/opt/shared/versions': { kind: 'directory', uid: UID },
    '/opt/shared/versions/v22': { kind: 'directory', uid: UID },
    '/opt/shared/versions/v22/bin': { kind: 'directory', uid: UID },
    '/opt/shared/versions/v22/bin/node': { kind: 'file' },
    ...extra,
  });
  const node = '/home/sam/.fnm/aliases/default/bin/node';
  assert.equal(untrustedPathProblem(node, chain({ kind: 'directory' })), null);
  // A folder only the second link passes through: realpath would keep `/opt/shared` but not say it came from a link.
  assert.equal(untrustedPathProblem(node, chain({ kind: 'directory', mode: 0o777 })), '/opt/shared is writable by its group or by others');
  // A folder only the path as written passes through.
  assert.equal(
    untrustedPathProblem(node, chain({ kind: 'directory' }, { '/home/sam/.fnm/aliases': { kind: 'directory', uid: UID, mode: 0o777 } })),
    '/home/sam/.fnm/aliases is writable by its group or by others',
  );
  // A link of another account's: in a sticky folder, its owner may replace it.
  assert.equal(
    untrustedPathProblem(node, chain({ kind: 'directory' }, { '/home/sam/.fnm/node-versions': { kind: 'link', uid: OTHER, target: '/opt/shared/versions' } })),
    '/home/sam/.fnm/node-versions belongs to another account',
  );
});

test('#1102 review: `..` after a link steps back from its target, as the kernel does', () => {
  const deps = tree({
    '/a': { kind: 'directory' },
    '/a/link': { kind: 'link', target: '/x/y' },
    '/a/node': { kind: 'file' },
    '/x': { kind: 'directory' },
    '/x/y': { kind: 'directory' },
    '/x/node': { kind: 'file', uid: OTHER },
  });
  // Read lexically, `/a/link/../node` would be `/a/node`, a sound file: the kernel opens `/x/node`.
  assert.equal(untrustedPathProblem('/a/link/../node', deps), '/x/node belongs to another account');
});

test('#1102 review: loops, folders and files out of place are refused', () => {
  const loop = tree({
    '/a': { kind: 'directory' },
    '/a/one': { kind: 'link', target: '/a/two' },
    '/a/two': { kind: 'link', target: 'one' },
  });
  assert.match(untrustedPathProblem('/a/one/node', loop) ?? '', /too many links/);
  const shapes = tree({ '/a': { kind: 'directory' }, '/a/file': { kind: 'file' }, '/a/dir': { kind: 'directory' } });
  assert.equal(untrustedPathProblem('/a/file/node', shapes), '/a/file is not a folder');
  assert.equal(untrustedPathProblem('/a/dir', shapes), '/a/dir is not a file');
  assert.match(untrustedPathProblem('a/file', shapes) ?? '', /not an absolute path/);
  // portability: Windows ACLs are not read here, binary-path.ts keeps its manager roots inside the profile instead.
  assert.equal(untrustedPathProblem('C:\\fnm\\node.exe', { ...shapes, platform: 'win32' }), null);
});
