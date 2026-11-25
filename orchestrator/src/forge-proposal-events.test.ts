/**
 * `forge_proposals_changed`: each gesture on a proposed forge write (its
 * creation, an edit, a publication's claim and outcome, a discard, an
 * interrupted publication recovered) publishes, and the browser stream relays
 * it only to a viewer who may read the proposals (`projects:manage`).
 */
import './test-home.js';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import type { Request, Response } from 'express';
import { bus, type BusEvent } from './bus.js';
import { db, dbApi } from './db.js';
import {
  discardForgeProposal, editForgeProposal, proposeForgeWrite, publishForgeProposal, recoverInterruptedPublications,
} from './forge-proposals.js';
import type { ForgeCommentWriter } from './host/forge.js';
import { sseHandler } from './sse.js';
import type { RequestAuth } from './users/identity.js';

type Change = Extract<BusEvent, { kind: 'forge_proposals_changed' }>;

const seen: Change[] = [];
const listen = (ev: BusEvent) => { if (ev.kind === 'forge_proposals_changed') seen.push(ev); };
bus.on('event', listen);
after(() => { bus.off('event', listen); });

async function published(fn: () => unknown): Promise<Change[]> {
  const from = seen.length;
  await fn();
  return seen.slice(from);
}

const home = realpathSync(mkdtempSync(join(tmpdir(), 'timon-forge-proposal-events-')));
const ghFolder = join(home, 'gh');
mkdirSync(ghFolder, { recursive: true });
const PROJECT = 'proposal-events';
dbApi.upsertProject(PROJECT, { cwd: join(home, 'code') });
dbApi.setProjectIntegration(PROJECT, JSON.stringify({
  mode: 'pr', remote: 'origin', target: 'main', forge: 'github', account: 'ai-bot',
  gh_config_dir: ghFolder, branch_prefix: 'feat/', remote_url: 'git@github.com:acme/widgets.git',
}));

const forge: ForgeCommentWriter = {
  login: async () => ({ ok: true, login: 'ai-bot' }),
  findIssueComment: async () => ({ ok: true, comment: null }),
  postIssueComment: async () => ({ ok: true, comment: { id: 1, url: 'https://github.com/acme/widgets/issues/3#issuecomment-1' } }),
};
const deps = { forge: () => forge };

function propose(number: number): string {
  const out = proposeForgeWrite({
    project: PROJECT, kind: 'comment', target: { type: 'issue', number }, body: 'Fixed in #51.', trigger: 'person', createdBy: 'u-1',
  });
  assert.ok(out.ok);
  return out.proposal.id;
}

test('every gesture on a proposal publishes its project and id; a refused one publishes nothing', async () => {
  let id = '';
  const created = await published(() => { id = propose(3); });
  assert.deepEqual(created, [{ kind: 'forge_proposals_changed', project: PROJECT, proposalId: id }]);
  assert.equal((await published(() => editForgeProposal(PROJECT, id, 'Fixed in #52.', 'u-1'))).length, 1);
  // Claimed, then published.
  assert.equal((await published(() => publishForgeProposal(PROJECT, id, 'u-1', undefined, deps))).length, 2);
  assert.deepEqual(await published(() => editForgeProposal(PROJECT, id, 'late', 'u-1')), [], 'a published proposal is closed');

  const other = propose(4);
  assert.deepEqual((await published(() => discardForgeProposal(PROJECT, other, 'u-1'))).map((e) => e.proposalId), [other]);

  const stuck = propose(5);
  db.prepare(`UPDATE forge_proposals SET state = 'publishing' WHERE id = ?`).run(stuck);
  assert.deepEqual((await published(() => recoverInterruptedPublications())).map((e) => e.proposalId), [stuck]);
});

function stream(auth: RequestAuth | null, missionId = ''): { frames: () => string; close: () => void } {
  const chunks: string[] = [];
  const res = new EventEmitter() as unknown as Response & EventEmitter;
  Object.assign(res, {
    set: () => res,
    flushHeaders: () => {},
    write: (s: string) => { chunks.push(s); return true; },
    status() { return res; },
    json() { return res; },
  });
  const req = new EventEmitter() as unknown as Request & EventEmitter;
  Object.assign(req, { params: { id: missionId }, query: {}, ...(auth ? { auth } : {}) });
  sseHandler(req, res);
  return { frames: () => chunks.join(''), close: () => { (req as unknown as EventEmitter).emit('close'); } };
}

const token = (permissions: string[]): RequestAuth => ({ kind: 'api-token', user: null, isSuperadmin: false, actorId: 'acct', permissions });

test('the stream relays a proposal\'s change to whoever may read proposals, ids only, and to no one else', () => {
  const manager = stream(token(['projects:manage']));
  const reader = stream(token(['kanban:read']));
  const admin = stream({ kind: 'daemon-token', user: null, isSuperadmin: true });
  const anonymous = stream(null);
  try {
    const id = propose(6);
    const frames = manager.frames().split('\n\n').filter((f) => f.startsWith('event: forge_proposals_changed'));
    assert.equal(frames.length, 1);
    assert.deepEqual(JSON.parse(frames[0]!.split('\ndata: ')[1]!), { kind: 'forge_proposals_changed', project: PROJECT, proposalId: id });
    assert.ok(!manager.frames().includes('Fixed in'), 'the text stays behind the route');
    assert.ok(admin.frames().includes(`"proposalId":"${id}"`));
    assert.ok(!reader.frames().includes('forge_proposals_changed'), 'without projects:manage, nothing');
    assert.ok(!anonymous.frames().includes('forge_proposals_changed'), 'an anonymous stream hears nothing');
  } finally {
    for (const s of [manager, reader, admin, anonymous]) s.close();
  }
});
