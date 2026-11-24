import assert from 'node:assert/strict';
import test from 'node:test';
import { missionGone } from './mission-gone';

const reply = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('only mission_not_found lets the chat start over', async () => {
  assert.equal(await missionGone(reply(404, { error: 'mission not found', code: 'mission_not_found' })), true);
});

test('a mission caught while its process is replaced is not gone (TIM-0167)', async () => {
  assert.equal(await missionGone(reply(404, { error: 'no running agent for that mission', code: 'mission_not_running' })), false);
});

test('a 404 without a code, or another failure, is not a reason for a new mission', async () => {
  assert.equal(await missionGone(reply(404, { error: 'not found' })), false);
  assert.equal(await missionGone(new Response('<html>', { status: 404 })), false);
  assert.equal(await missionGone(reply(500, { error: 'boom', code: 'mission_not_found' })), false);
});

test('the caller can still read the body afterwards', async () => {
  const res = reply(404, { error: 'mission not found', code: 'mission_not_found' });
  await missionGone(res);
  assert.equal(((await res.json()) as { code: string }).code, 'mission_not_found');
});
