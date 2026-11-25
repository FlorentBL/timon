import assert from 'node:assert/strict';
import test from 'node:test';
import {
  addAgentFolder, addFolder, AgentFoldersError, fetchAgentFolders, fetchFolders, folderName, folderOwnerKey, isAbsoluteFolder, removeAgentFolder, removeFolder,
} from './agent-folders';

test('a folder path is absolute on any of the three systems, never relative', () => {
  for (const path of ['/srv/notes', 'C:\\Users\\me\\notes', 'd:/work', '\\\\nas\\share']) assert.equal(isAbsoluteFolder(path), true, path);
  for (const path of ['', 'notes', './notes', '~/notes', 'C:notes']) assert.equal(isAbsoluteFolder(path), false, path);
});

test('a row is titled by the folder\'s last segment', () => {
  assert.equal(folderName('/srv/notes/'), 'notes');
  assert.equal(folderName('C:\\Users\\me\\Library'), 'Library');
  assert.equal(folderName('/'), '/');
});

test('the client speaks to the daemon\'s one door, and keeps only well-formed entries', async () => {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, method: init.method ?? 'GET', body: init.body ? JSON.parse(String(init.body)) : undefined });
    if (init.method === 'DELETE') return new Response(JSON.stringify({ error: 'nope', code: 'extra_dir_refused' }), { status: 400 });
    return new Response(JSON.stringify({
      agent: 'lib.reader',
      extra_dirs: [{ path: '/srv/notes', mode: 'write' }, { path: 42, mode: 'read' }, { path: '/x', mode: 'admin' }],
      dropped: [{ path: '/gone', reason: 'the folder does not exist' }],
      running: 1,
    }), { status: 200 });
  }) as typeof fetch;
  try {
    const read = await fetchAgentFolders('lib reader');
    assert.deepEqual(read.folders, [{ path: '/srv/notes', mode: 'write' }]);
    assert.deepEqual(read.dropped, [{ path: '/gone', reason: 'the folder does not exist' }]);
    assert.equal(read.running, 1);
    await addAgentFolder('lib.reader', { path: '/srv/notes', mode: 'read' }, { restart: true });
    await assert.rejects(removeAgentFolder('lib.reader', '/srv/notes'), AgentFoldersError);
    assert.equal(calls[0]!.url, '/api/ui/agents/lib%20reader/extra-dirs');
    assert.deepEqual(calls[1], { url: '/api/ui/agents/lib.reader/extra-dirs', method: 'POST', body: { path: '/srv/notes', mode: 'read', restart: true } });
    assert.deepEqual(calls[2], { url: '/api/ui/agents/lib.reader/extra-dirs', method: 'DELETE', body: { path: '/srv/notes' } });
  } finally {
    globalThis.fetch = original;
  }
});

test('a project\'s folders go through the project\'s door, with no restart', async () => {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, method: init.method ?? 'GET', body: init.body ? JSON.parse(String(init.body)) : undefined });
    return new Response(JSON.stringify({ project: 'lib', extra_dirs: [{ path: '/srv/shared', mode: 'read' }], dropped: [] }), { status: 200 });
  }) as typeof fetch;
  try {
    const owner = { kind: 'project', slug: 'lib' } as const;
    const read = await fetchFolders(owner);
    assert.deepEqual(read.owner, owner);
    assert.equal(read.agent, '');
    assert.deepEqual(read.folders, [{ path: '/srv/shared', mode: 'read' }]);
    await addFolder(owner, { path: '/srv/shared', mode: 'write' });
    await removeFolder(owner, '/srv/shared');
    assert.deepEqual(calls.map((c) => `${c.method} ${c.url}`), [
      'GET /api/ui/projects/lib/extra-dirs', 'POST /api/ui/projects/lib/extra-dirs', 'DELETE /api/ui/projects/lib/extra-dirs',
    ]);
    assert.deepEqual(calls[1]!.body, { path: '/srv/shared', mode: 'write' });
    assert.notEqual(folderOwnerKey(owner), folderOwnerKey({ kind: 'agent', name: 'lib' }));
  } finally {
    globalThis.fetch = original;
  }
});
