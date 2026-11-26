import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PENDING_PERMISSION_EVENTS,
  missionOfPermissionEvent,
  subscribeMissionsPermissionChanges,
  subscribePendingPermissionChanges,
} from './pending-permission-events';

/** A stand-in for the global stream: `emit` delivers a named frame. */
function fakeStream() {
  const listeners = new Map<string, Set<(event: MessageEvent) => void>>();
  const on = (type: string, fn: (event: MessageEvent) => void) => {
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type)!.add(fn);
    return () => { listeners.get(type)?.delete(fn); };
  };
  const emit = (type: string, data: string) => {
    for (const fn of listeners.get(type) ?? []) fn({ data } as MessageEvent);
  };
  const count = () => [...listeners.values()].reduce((n, set) => n + set.size, 0);
  return { on, emit, count };
}

const frame = (missionId: string) => JSON.stringify({ kind: 'permission_request', missionId });

test('the mission is read off the alias body; anything else names none', () => {
  assert.equal(missionOfPermissionEvent(frame('m-1')), 'm-1');
  assert.equal(missionOfPermissionEvent('{"missionId":""}'), null);
  assert.equal(missionOfPermissionEvent('not json'), null);
  assert.equal(missionOfPermissionEvent(undefined), null);
});

test('every card event is heard, the lengthened delay included, and the unsubscription drops them all', () => {
  const stream = fakeStream();
  const heard: string[] = [];
  const stop = subscribePendingPermissionChanges((id) => heard.push(id), stream.on);
  assert.ok(PENDING_PERMISSION_EVENTS.includes('permission_timeout_adapted'));
  for (const type of PENDING_PERMISSION_EVENTS) stream.emit(type, frame(type));
  stream.emit('mission_complete', frame('other'));
  assert.deepEqual(heard, [...PENDING_PERMISSION_EVENTS]);
  stop();
  assert.equal(stream.count(), 0);
});

test('a burst on a watched mission reloads once; another mission\'s cards reload nothing', async () => {
  const stream = fakeStream();
  let reloads = 0;
  const watched = new Set(['task-mission']);
  const stop = subscribeMissionsPermissionChanges(() => watched, () => { reloads += 1; }, { on: stream.on, delayMs: 5 });
  stream.emit('permission_resolved', frame('task-mission'));
  stream.emit('permission_request', frame('task-mission'));
  stream.emit('permission_request', frame('chat-mission'));
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(reloads, 1);
  // A reload still waiting is dropped with the subscription.
  stream.emit('permission_expired', frame('task-mission'));
  stop();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(reloads, 1);
});
