/**
 * The landing lock (`landing-lock.ts`) as the task API takes it: a DONE task
 * reopened on a branch the cleanup after a landing is deleting waits for the
 * deletion to finish (TODO #1210, race 2). Nothing else waits.
 */
import { createTestAccount } from '../tests/helpers/accounts.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import express from 'express';

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-landing-lock-'));
await import('../tests/helpers/paid-license.js');
process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';

const { db, dbApi } = await import('./db.js');
const { agentDir } = await import('./paths.js');
const { createDaemonAuthMiddleware } = await import('./plugins-bundled/http/auth.js');
const { registerRoutes: kanban } = await import('./plugins-bundled/kanban/routes.js');
const { landingBranchLocked, withLandingBranchLock } = await import('./landing-lock.js');

const OPERATOR = 'landing-lock-operator-token';
mkdirSync(agentDir('worker'), { recursive: true });
writeFileSync(join(agentDir('worker'), 'system-prompt.md'), 'test');
writeFileSync(join(agentDir('worker'), 'config.json'), JSON.stringify({ cwd: process.env.TIMON_HOME }));
const owner = createTestAccount(dbApi, { email: 'owner@example.test', name: 'Owner', passwordHash: 'x', isSuperadmin: true });

const app = express();
app.use(createDaemonAuthMiddleware({ token: OPERATOR, required: true }));
app.use(express.json());
kanban(app);
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
test.after(() => { server.closeAllConnections(); server.close(); });

function put(id: string, body: Record<string, unknown>): Promise<Response> {
  return fetch(`${base}/api/tasks/${id}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${OPERATOR}` },
    body: JSON.stringify(body),
  });
}

function doneTask(baseBranch: string | null): string {
  const id = randomUUID();
  dbApi.createTask(id, `task ${id.slice(0, 8)}`, 'worker', {
    type: 'chore', ownerUserId: owner.id, ...(baseBranch ? { baseBranch } : {}),
  });
  db.prepare(`UPDATE tasks SET status = 'DONE' WHERE id = ?`).run(id);
  return id;
}

/** Holds the lock of `branch` until the returned function is called. */
function hold(branch: string): { release: () => void; done: Promise<void> } {
  let release: () => void = () => undefined;
  const done = withLandingBranchLock(branch, () => new Promise<void>((r) => { release = r; }));
  return { release: () => release(), done };
}

const tick = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

test('a task reopened on a branch being cleaned up waits for the cleanup, then reopens', async () => {
  const id = doneTask('feat/landing-lock');
  const lock = hold('feat/landing-lock');
  await tick(10);
  const answer = put(id, { status: 'PENDING' });
  await tick(300);
  assert.equal(dbApi.getTask(id)?.status, 'DONE', 'the reopening waits for the lock');
  lock.release();
  await lock.done;
  const res = await answer;
  assert.equal(res.status, 200);
  assert.equal(dbApi.getTask(id)?.status, 'PENDING');
  assert.equal(landingBranchLocked('feat/landing-lock'), false, 'the lock leaves nothing behind');
});

test('nothing else waits: another branch, no branch, or an edit that does not reopen', async () => {
  const lock = hold('feat/busy');
  await tick(10);
  try {
    const other = doneTask('feat/elsewhere');
    assert.equal((await put(other, { status: 'PENDING' })).status, 200);
    assert.equal(dbApi.getTask(other)?.status, 'PENDING');
    const none = doneTask(null);
    assert.equal((await put(none, { status: 'PENDING' })).status, 200);
    const same = doneTask('feat/busy');
    assert.equal((await put(same, { title: 'renamed' })).status, 200);
    assert.equal(dbApi.getTask(same)?.title, 'renamed');
    assert.equal(dbApi.getTask(same)?.status, 'DONE');
  } finally {
    lock.release();
    await lock.done;
  }
});

test('holders of one branch run one after the other, in order', async () => {
  const order: string[] = [];
  const a = withLandingBranchLock('feat/order', async () => { order.push('a:start'); await tick(50); order.push('a:end'); });
  const b = withLandingBranchLock('feat/order', () => { order.push('b'); });
  const failing = withLandingBranchLock('feat/order', () => { throw new Error('boom'); });
  const c = withLandingBranchLock('feat/order', () => { order.push('c'); });
  await Promise.all([a, b, failing.catch(() => undefined), c]);
  assert.deepEqual(order, ['a:start', 'a:end', 'b', 'c'], 'a failing holder releases the lock too');
  assert.equal(landingBranchLocked('feat/order'), false);
});
