/**
 * The "Allow for this agent" card of a path the mission fence refused (TODO
 * #1162): it names the refused path, the folder and the access, answers once
 * through the person's session, shows the answer, and a plugin that takes
 * `chat.fence` gets the same card and the same two gestures. A refusal with no
 * offer, or of the Timon home, is no card.
 */
import assert from 'node:assert/strict';
import { waitUntil } from '../../lib/test-wait';
import test, { type TestContext } from 'node:test';
import { applyFenceGrantResolution, parseFenceGrant, parseFenceGrantResolution, type FenceGrantView } from '@/lib/fence-grant';

const payload = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  type: 'fence_refused', id: 'refusal-1', path: '/home/u/.cache/tool/state.db', display: '~/.cache/tool/state.db',
  access: 'write', mechanism: 'landlock', stage: 'run', missionId: 'm1', agent: 'lib.coder', backend: 'claude',
  timonHome: false, grantable: true, dropped: null, setting: { category: 'system', tab: 'security' },
  grant: { path: '/home/u/.cache/tool', display: '~/.cache/tool', mode: 'write' }, ...over,
});
const view = (over: Record<string, unknown> = {}): FenceGrantView => parseFenceGrant(payload(over))!;

test('a card only for a refusal that offers a folder, never the Timon home nor a credential folder', () => {
  assert.equal(view().folder.display, '~/.cache/tool');
  assert.equal(parseFenceGrant(payload({ grant: null })), null);
  assert.equal(parseFenceGrant(payload({ timonHome: true })), null);
  assert.equal(parseFenceGrant(payload({ grantable: false })), null);
  assert.equal(parseFenceGrant(payload({ id: undefined })), null);
  assert.equal(parseFenceGrant(payload({ agent: 'lib coder' })), null, 'a control character is a forged card');
});

test('an answer settles the card once', () => {
  const allowed = applyFenceGrantResolution(view(), parseFenceGrantResolution({ id: 'refusal-1', status: 'allowed' })!);
  assert.equal(allowed.status, 'allowed');
  assert.equal(applyFenceGrantResolution(allowed, { id: 'refusal-1', status: 'refused' }).status, 'allowed');
  assert.equal(applyFenceGrantResolution(view(), { id: 'other', status: 'refused' }).status, 'pending');
  assert.equal(parseFenceGrantResolution({ id: 'refusal-1', status: 'pending' }), null);
});

type Call = { method: string; url: string; body?: unknown };

async function mount(ctx: TestContext, answer: { status?: number; body?: Record<string, unknown> } = {}) {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/chat', pretendToBeVisual: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    if (!saved.has(key)) saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event', 'CustomEvent', 'MouseEvent']) {
    install(key, key === 'window' ? dom.window : Reflect.get(dom.window, key));
  }
  const calls: Call[] = [];
  install('fetch', async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) as { decision?: string } : undefined;
    calls.push({ method, url, ...(body ? { body } : {}) });
    const status = body?.decision === 'allow' ? 'allowed' : 'refused';
    return new Response(JSON.stringify(answer.body ?? { ok: true, resolution: { id: 'refusal-1', status }, relaunched: true }), { status: answer.status ?? 200 });
  });
  install('IS_REACT_ACT_ENVIRONMENT', true);
  const React = await import('react');
  install('React', React);
  const { createRoot } = await import('react-dom/client');
  const slots = await import('@/lib/plugin-host/slots');
  slots.resetSlotsForTests();
  const card = await import('./fence-grant-card');
  const undo = [slots.register({ slot: slots.CHAT_FENCE_GRANT_SLOT, pluginId: '@timon/missions', fallback: true }, card.FenceGrantCard)];
  const root = createRoot(document.getElementById('root')!);
  const act = (fn: () => void | Promise<void>) => React.act(async () => { await fn(); });
  const render = (grant: FenceGrantView) => act(() => {
    root.render(React.createElement(card.ChatFenceGrantSlot, { grant }));
  });
  ctx.after(async () => {
    await act(() => root.unmount());
    for (const u of undo) u();
    slots.resetSlotsForTests();
    dom.window.close();
    for (const [key, d] of saved) { if (d) Object.defineProperty(globalThis, key, d); else Reflect.deleteProperty(globalThis, key); }
  });
  const click = (selector: string) => act(() => { document.querySelector<HTMLButtonElement>(selector)!.click(); });
  const until = (condition: () => boolean, what: string) => waitUntil(React.act, condition, what);
  return { render, click, until, calls, React, slots, card };
}

test('the card names the refused path, the folder and the access, with the two answers', async (t) => {
  const w = await mount(t);
  await w.render(view());
  const text = document.body.textContent ?? '';
  assert.match(text, /Landlock/);
  assert.match(text, /write to ~\/\.cache\/tool\/state\.db/);
  assert.match(text, /Allow lib\.coder to read and write ~\/\.cache\/tool\?/);
  assert.ok(document.querySelector('[data-decision="allow"]'));
  assert.ok(document.querySelector('[data-decision="refuse"]'));
  assert.doesNotMatch(text, /fenceGrant\./, 'unresolved i18n key');
});

test('allowing posts the decision for this refusal of this mission, then shows the folder open', async (t) => {
  const w = await mount(t);
  await w.render(view());
  await w.click('[data-decision="allow"]');
  await w.until(() => Boolean(document.querySelector('[data-fence-grant-state="allowed"]')), 'the card to show the accord');
  assert.deepEqual(w.calls, [{ method: 'POST', url: '/api/ui/missions/m1/fence-grants/refusal-1', body: { decision: 'allow' } }]);
  assert.ok(!document.querySelector('[data-decision="allow"]'), 'an answered card offers no answer');
  assert.match(document.body.textContent ?? '', /~\/\.cache\/tool is open to lib\.coder/);
});

test('a card already answered elsewhere comes back answered', async (t) => {
  const settled = await mount(t, { status: 409, body: { error: 'fence_grant_settled', resolution: { id: 'refusal-1', status: 'refused' } } });
  await settled.render(view());
  await settled.click('[data-decision="allow"]');
  await settled.until(() => Boolean(document.querySelector('[data-fence-grant-state="refused"]')), 'the answer given elsewhere');
});

test('a plugin that takes the slot reads the same card and answers through the host', async (t) => {
  const w = await mount(t);
  function Replacement() {
    const ctx = w.card.useFenceGrant();
    return w.React.createElement('button', { 'data-replacement': ctx?.grant.folder.path, onClick: () => void ctx?.refuse() }, 'custom');
  }
  const undo = w.slots.register({ slot: w.slots.CHAT_FENCE_GRANT_SLOT, pluginId: 'acme' }, Replacement);
  t.after(undo);
  await w.render(view());
  assert.ok(!document.querySelector('[data-decision="allow"]'), 'the product card gave way');
  await w.click('[data-replacement="/home/u/.cache/tool"]');
  await w.until(() => w.calls.length === 1, 'the replacement to answer');
  assert.deepEqual(w.calls[0]!.body, { decision: 'refuse' });
});

const projectView = (): FenceGrantView => view({ grant: { path: '/home/u/.cache/tool', display: '~/.cache/tool', mode: 'write', project: 'lib' } });

test('a card offers the project only when the daemon names a well-formed one', () => {
  assert.equal(view().project, null);
  assert.equal(projectView().project, 'lib');
  assert.equal(view({ grant: { path: '/x', display: '/x', mode: 'read', project: '../etc' } })!.project, null);
  const allowed = applyFenceGrantResolution(projectView(), parseFenceGrantResolution({ id: 'refusal-1', status: 'allowed', scope: 'project', project: 'lib' })!);
  assert.equal(allowed.scope, 'project');
  assert.equal(applyFenceGrantResolution(view(), parseFenceGrantResolution({ id: 'refusal-1', status: 'allowed' })!).scope, 'agent');
});

test('no project in the offer: no "Allow for the project"', async (t) => {
  const w = await mount(t);
  await w.render(view());
  assert.ok(!document.querySelector('[data-decision="allow-project"]'));
});

test('"Allow for the project" posts the scope, then says the project\'s agents get the folder', async (t) => {
  const w = await mount(t, { body: { ok: true, resolution: { id: 'refusal-1', status: 'allowed', scope: 'project', project: 'lib' }, relaunched: true, requeued: false } });
  await w.render(projectView());
  assert.match(document.body.textContent ?? '', /every agent of lib gets it/);
  await w.click('[data-decision="allow-project"]');
  await w.until(() => Boolean(document.querySelector('[data-fence-grant-state="allowed"]')), 'the card to show the accord');
  assert.deepEqual(w.calls, [{ method: 'POST', url: '/api/ui/missions/m1/fence-grants/refusal-1', body: { decision: 'allow', scope: 'project' } }]);
  assert.match(document.body.textContent ?? '', /~\/\.cache\/tool is open to the agents of lib/);
  assert.doesNotMatch(document.body.textContent ?? '', /fenceGrant\./, 'unresolved i18n key');
});

test('an accord that put a blocked Kanban task back in the queue says so', async (t) => {
  const w = await mount(t, { body: { ok: true, resolution: { id: 'refusal-1', status: 'allowed', scope: 'agent' }, relaunched: false, requeued: true, taskId: 't1' } });
  await w.render(view());
  await w.click('[data-decision="allow"]');
  await w.until(() => Boolean(document.querySelector('[data-fence-grant-requeued]')), 'the requeue to show');
  assert.match(document.body.textContent ?? '', /The task is back in the queue/);
});

test('a reload replays "the task is back in the queue" from the recorded answer (TODO #1189)', async (t) => {
  // What the thread does on a reload: the stored `fence_refused`, then the stored
  // `fence_grant_resolved`, through the same parsers as the live events.
  const recorded = { type: 'fence_grant_resolved', id: 'refusal-1', status: 'allowed', path: '/home/u/.cache/tool', mode: 'write', scope: 'agent', project: null, requeued: true, resolvedAt: 1 };
  const replayed = applyFenceGrantResolution(view(), parseFenceGrantResolution(recorded)!);
  assert.equal(replayed.requeued, true);
  const w = await mount(t);
  await w.render(replayed);
  assert.ok(document.querySelector('[data-fence-grant-state="allowed"]'));
  assert.match(document.body.textContent ?? '', /The task is back in the queue/);
  // An answer recorded before the requeue was kept says nothing about the task.
  const older = applyFenceGrantResolution(view(), parseFenceGrantResolution({ ...recorded, requeued: undefined })!);
  assert.equal(older.requeued, null);
  await w.render(older);
  assert.ok(!document.querySelector('[data-fence-grant-requeued]'));
  // A refusal never says it, whatever the payload claims.
  assert.equal(applyFenceGrantResolution(view(), parseFenceGrantResolution({ ...recorded, status: 'refused' })!).requeued, null);
});
