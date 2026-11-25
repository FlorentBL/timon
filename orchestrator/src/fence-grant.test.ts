/**
 * The offer a fence refusal carries (TODO #1162): which folder "Allow for this
 * agent" would add, and when no card may be offered at all.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-fence-grant-'));
const { fenceGrantOffer, fenceGrantTurn, grantFolderOf, withFenceGrantOffer } = await import('./fence-grant.js');
type Refusal = Parameters<typeof withFenceGrantOffer>[0];

const root = mkdtempSync(join(tmpdir(), 'timon-fence-grant-disk-'));
const home = join(root, 'home');
const cache = join(home, '.cache', 'tool');
mkdirSync(cache, { recursive: true });
writeFileSync(join(cache, 'state.db'), '');
const noProblem = (): null => null;
const base = { access: 'write' as const, grantable: true, timonHome: false, agent: 'lib.coder' };

test('the folder of an accord: the folder itself, a file\'s folder, the first existing one above a path not made yet', () => {
  assert.equal(grantFolderOf(cache), cache);
  assert.equal(grantFolderOf(join(cache, 'state.db')), cache);
  assert.equal(grantFolderOf(join(cache, 'sub', 'deeper', 'new.lock')), cache);
});

test('an offer names the folder, its display and the access the refusal lacked', () => {
  const offer = fenceGrantOffer({ ...base, path: join(cache, 'state.db') }, { held: [], home, problem: noProblem });
  assert.deepEqual(offer, { path: cache, display: join('~', '.cache', 'tool'), mode: 'write', project: null });
  const read = fenceGrantOffer({ ...base, access: 'read', path: cache }, { held: [], home, problem: noProblem });
  assert.equal(read?.mode, 'read');
});

test('no offer for the Timon home, a credential folder, a mission without agent, or a folder the checks refuse', () => {
  assert.equal(fenceGrantOffer({ ...base, path: cache, timonHome: true, grantable: false }, { held: [], home, problem: noProblem }), null);
  assert.equal(fenceGrantOffer({ ...base, path: cache, grantable: false }, { held: [], home, problem: noProblem }), null);
  assert.equal(fenceGrantOffer({ ...base, path: cache, agent: null }, { held: [], home, problem: noProblem }), null);
  // A file at the root of the home folder: its folder is the whole home, which is too wide.
  assert.equal(fenceGrantOffer({ ...base, path: join(home, '.bashrc') }, { held: [], home, problem: (p) => (p === home ? 'too wide' : null) }), null);
});

test('the real checks refuse the Timon home even when a refusal claims it may be opened', () => {
  const inTimonHome = join(process.env.TIMON_HOME!, 'agents');
  mkdirSync(inTimonHome, { recursive: true });
  assert.equal(fenceGrantOffer({ ...base, path: inTimonHome }, { held: [] }), null);
});

test('no offer when the agent already holds the folder with that access; a read folder may still be widened', () => {
  assert.equal(fenceGrantOffer({ ...base, path: cache }, { held: [{ path: cache, mode: 'write' }], home, problem: noProblem }), null);
  assert.equal(fenceGrantOffer({ ...base, access: 'read', path: cache }, { held: [{ path: cache, mode: 'read' }], home, problem: noProblem }), null);
  assert.equal(fenceGrantOffer({ ...base, path: cache }, { held: [{ path: cache, mode: 'read' }], home, problem: noProblem })?.mode, 'write');
});

test('an offer names the agent\'s project, which "Allow for the project" adds to; held by the project, no offer', () => {
  const offer = fenceGrantOffer({ ...base, path: cache }, { held: [], project: 'lib', home, problem: noProblem });
  assert.equal(offer?.project, 'lib');
  // A mission gets the agent's folders and its project's: either holding it, an accord changes nothing.
  assert.equal(fenceGrantOffer({ ...base, path: cache }, { held: [{ path: cache, mode: 'write' }], project: 'lib', home, problem: noProblem }), null);
});

test('the relaunch turn of a project accord names the project', () => {
  const text = fenceGrantTurn({ display: '~/x' }, { path: cache, display: '~/.cache/tool', mode: 'read', project: 'lib' }, 'project');
  assert.match(text, /the missions of project lib may now read ~\/\.cache\/tool/);
});

test('a recorded refusal gets an id and its offer; a failing offer leaves the card out, never the notice', () => {
  const refusal = { path: cache, display: '~/.cache/tool', access: 'write', grantable: true, timonHome: false, agent: 'lib.coder' } as Refusal;
  const recorded = withFenceGrantOffer(refusal, () => ({ path: cache, display: '~/.cache/tool', mode: 'write' }));
  assert.match(recorded.id ?? '', /^[0-9a-f-]{36}$/);
  assert.equal(recorded.grant?.path, cache);
  const broken = withFenceGrantOffer({ ...refusal, id: undefined } as Refusal, () => { throw new Error('config unreadable'); });
  assert.equal(broken.grant, null);
  assert.ok(broken.id);
});

test('the relaunch turn says what was opened and what to retry', () => {
  const text = fenceGrantTurn({ display: '~/.cache/tool/state.db' }, { path: cache, display: '~/.cache/tool', mode: 'write' });
  assert.match(text, /may now read and write ~\/\.cache\/tool/);
  assert.match(text, /refused ~\/\.cache\/tool\/state\.db/);
});
