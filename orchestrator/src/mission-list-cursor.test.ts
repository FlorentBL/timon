/**
 * `GET /api/missions`: bounded page, cursor and task filter (TIM-0161).
 *
 * What we protect: the list used to clamp `limit` at 1000 in silence (a
 * caller read "1000 missions" when there were more), had no way to read the
 * next page and no task filter. Now an out-of-range or malformed query is a
 * 400, every page says whether another follows and how to reach it, the pages
 * chain without a duplicate or a gap even when missions share a start time,
 * `?task_id=` keeps the owner scope, and an anonymous caller is refused.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import express from 'express';
import type { RequestAuth } from './users/identity.js';

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-mission-list-cursor-test-'));

const { db, dbApi } = await import('./db.js');
const { registerRoutes, MISSION_LIST_MAX } = await import('./plugins-bundled/missions/routes.js');

type ListBody = {
  missions?: { id: string; task_id: string | null; started_at: number }[];
  has_more?: boolean;
  next_cursor?: string | null;
  code?: string;
  issues?: string[];
};

const ROOT: RequestAuth = { kind: 'api-token', user: null, isSuperadmin: true, permissions: ['*'] };
const asUser = (id: string): RequestAuth => ({ kind: 'api-token', user: null, isSuperadmin: false, actorId: id, permissions: ['missions:read'] });

async function list(path: string, auth: RequestAuth | null = ROOT): Promise<{ status: number; body: ListBody }> {
  const app = express();
  app.use((req, _res, next) => {
    if (auth) req.auth = auth;
    next();
  });
  registerRoutes(app);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  try {
    const r = await fetch(`http://127.0.0.1:${port}${path}`);
    return { status: r.status, body: await r.json() as ListBody };
  } finally {
    server.close();
  }
}

const setStarted = db.prepare(`UPDATE missions SET started_at = ? WHERE id = ?`);
const setTask = db.prepare(`UPDATE missions SET task_id = ? WHERE id = ?`);

function mission(agent: string, startedAt: number, owner: string | null = null): string {
  const id = randomUUID();
  dbApi.createMission(id, agent, 'brief', undefined, owner);
  setStarted.run(startedAt, id);
  return id;
}

/** Every page of `base`, followed through `next_cursor`. */
async function walk(base: string, auth: RequestAuth = ROOT): Promise<{ ids: string[]; pages: number }> {
  const ids: string[] = [];
  let cursor: string | null = null;
  let pages = 0;
  do {
    const sep = base.includes('?') ? '&' : '?';
    const r = await list(cursor ? `${base}${sep}before=${encodeURIComponent(cursor)}` : base, auth);
    assert.equal(r.status, 200);
    ids.push(...(r.body.missions ?? []).map((m) => m.id));
    assert.equal(r.body.has_more, r.body.next_cursor !== null);
    cursor = r.body.next_cursor ?? null;
    pages++;
    assert.ok(pages < 100, 'the cursor never ends');
  } while (cursor);
  return { ids, pages };
}

test('an anonymous caller is refused', async () => {
  mission('anon.main', 1_000);
  const r = await list('/api/missions?agent=anon.main', null);
  assert.equal(r.status, 401);
  assert.equal(r.body.missions, undefined);
});

test('a malformed or out-of-range query is a 400, not a silent clamp', async () => {
  for (const query of ['limit=abc', 'limit=0', 'limit=-3', 'limit=1.5', `limit=${MISSION_LIST_MAX + 1}`, 'limit=',
    'before=nope', 'before=12', 'before=12,', 'before=,abc', 'task_id=']) {
    const r = await list(`/api/missions?${query}`);
    assert.equal(r.status, 400, query);
    assert.equal(r.body.code, 'invalid_query', query);
    assert.ok((r.body.issues ?? []).length > 0, query);
    assert.equal(r.body.missions, undefined, query);
  }
  assert.equal((await list(`/api/missions?limit=${MISSION_LIST_MAX}`)).status, 200);
});

test('a page that reaches its limit says so, and the last page says it is the last', async () => {
  const total = MISSION_LIST_MAX + 5;
  const insert = db.transaction(() => {
    for (let i = 0; i < total; i++) mission('cap.main', 100_000 + i);
  });
  insert();
  const first = await list(`/api/missions?agent=cap.main&limit=${MISSION_LIST_MAX}`);
  assert.equal(first.status, 200);
  assert.equal(first.body.missions?.length, MISSION_LIST_MAX);
  assert.equal(first.body.has_more, true);
  assert.ok(first.body.next_cursor);
  const rest = await list(`/api/missions?agent=cap.main&limit=${MISSION_LIST_MAX}&before=${encodeURIComponent(first.body.next_cursor ?? '')}`);
  assert.equal(rest.body.missions?.length, 5);
  assert.equal(rest.body.has_more, false);
  assert.equal(rest.body.next_cursor, null);
  // Exactly a page's worth: no phantom next page.
  const exact = await list('/api/missions?agent=cap.main&limit=5&before=' + encodeURIComponent(first.body.next_cursor ?? ''));
  assert.equal(exact.body.missions?.length, 5);
  assert.equal(exact.body.has_more, false);
});

test('pages chain without a duplicate or a gap, ties on started_at included', async () => {
  const ids = new Set<string>();
  for (let i = 0; i < 7; i++) ids.add(mission('tie.main', 5_000));
  for (let i = 0; i < 6; i++) ids.add(mission('tie.main', 4_000 + i * 100));
  for (let i = 0; i < 4; i++) ids.add(mission('tie.main', 6_000));

  const whole = await list('/api/missions?agent=tie.main&limit=100');
  assert.equal(whole.body.has_more, false);
  const ordered = (whole.body.missions ?? []).map((m) => m.id);
  assert.equal(ordered.length, ids.size);

  for (const size of [1, 2, 3, 5, 16]) {
    const { ids: walked, pages } = await walk(`/api/missions?agent=tie.main&limit=${size}`);
    assert.deepEqual(walked, ordered, `page size ${size}`);
    assert.equal(new Set(walked).size, walked.length, `duplicate at page size ${size}`);
    assert.equal(pages, Math.ceil(ids.size / size), `page size ${size}`);
  }
});

test('?task_id= keeps the missions of that task only, within the owner scope', async () => {
  const taskId = randomUUID();
  dbApi.createTask(taskId, 'cursor task', 'task.main');
  const mine = [mission('task.main', 20_000, 'user-a'), mission('task.coder', 21_000, 'user-a')];
  const theirs = mission('task.main', 22_000, 'user-b');
  for (const id of [...mine, theirs]) setTask.run(taskId, id);
  mission('task.main', 23_000, 'user-a');

  const root = await list(`/api/missions?task_id=${taskId}`);
  assert.equal(root.status, 200);
  assert.deepEqual(new Set(root.body.missions?.map((m) => m.id)), new Set([...mine, theirs]));
  assert.ok(root.body.missions?.every((m) => m.task_id === taskId));

  const scoped = await list(`/api/missions?task_id=${taskId}`, asUser('user-a'));
  assert.deepEqual(scoped.body.missions?.map((m) => m.id), [mine[1], mine[0]]);

  // Combined with an agent filter and a cursor.
  const { ids } = await walk(`/api/missions?task_id=${taskId}&agent=task.main&limit=1`);
  assert.deepEqual(ids, [theirs, mine[0]]);

  const none = await list(`/api/missions?task_id=${randomUUID()}`);
  assert.deepEqual(none.body.missions, []);
  assert.equal(none.body.has_more, false);
});
