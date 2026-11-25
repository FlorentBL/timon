/**
 * The tags of the idea a task card carries out follow the job that lands it:
 * the board reads them again when the daemon announces that a job moved
 * (`integration_changed`), not only when the board's set of ideas changes.
 * Same harness as `lib/kanban-client-cards.test.ts`, with a stream.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { waitUntil } from '../../lib/test-wait';
import { LANDING_COALESCE_MS, LANDING_EVENT, type LandingChange } from './landing-events';

test('a task card\'s idea tags are read again when a job lands, not when only its checks move', async () => {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/kanban' });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  install('window', dom.window);
  install('self', dom.window);
  for (const key of ['document', 'navigator', 'HTMLElement', 'Element', 'Node', 'DocumentFragment', 'MutationObserver', 'NodeFilter', 'HTMLInputElement', 'SVGElement', 'Event', 'CustomEvent', 'FocusEvent', 'MouseEvent', 'KeyboardEvent', 'getComputedStyle']) {
    install(key, (dom.window as unknown as Record<string, unknown>)[key]);
  }
  install('IS_REACT_ACT_ENVIRONMENT', true);
  const sources: Source[] = [];
  class Source extends EventTarget {
    static CLOSED = 2;
    readyState = 1;
    constructor(readonly url: string) { super(); sources.push(this); }
    close() { this.readyState = Source.CLOSED; }
  }
  install('EventSource', Source);

  const now = Date.now();
  const tasks = [{
    id: 'next-bbbbbb', title: 'Follow-up', agent_name: 'demo.coder', status: 'DONE', priority: 3, deps: '[]',
    created_at: now, updated_at: now, type: 'code', effective_backend: 'claude', effective_model: 'opus', todo_id: 42,
  }];
  let progress = 'partial';
  let todoReads = 0;
  install('fetch', async (input: string | URL | Request) => {
    const url = String(input);
    if (url.startsWith('/api/ui/tasks?')) return Response.json({ tasks, view: 'board', done_total: 1 });
    if (url.startsWith('/api/ui/project-todo')) {
      todoReads += 1;
      return Response.json({ items: [{ id: 42, text: 'An idea', status: 'promoted', urgency: 'bug', progress }] });
    }
    return Response.json({ agents: [], projects: [] });
  });

  const React = await import('react');
  install('React', React);
  const { createRoot } = await import('react-dom/client');
  const { AppRouterContext } = await import('next/dist/shared/lib/app-router-context.shared-runtime');
  const { resetSlotsForTests } = await import('../../lib/plugin-host/slots');
  resetSlotsForTests();
  const { KanbanClient } = await import('./kanban-page');

  const router = { back() {}, forward() {}, refresh() {}, prefetch() {}, push() {}, replace() {} };
  const root = createRoot(document.getElementById('root')!);
  const until = (condition: () => boolean, what: string) => waitUntil(React.act, condition, what);
  const text = () => document.querySelector('[data-task-card="next-bbbbbb"]')?.textContent ?? '';
  const settle = () => React.act(async () => { await new Promise((r) => setTimeout(r, LANDING_COALESCE_MS + 100)); });
  const announce = (changed: LandingChange['changed']) => {
    const body: LandingChange = { integrationId: 'job-1', project: null, seriesId: null, state: 'merged', changed };
    for (const s of sources) s.dispatchEvent(new MessageEvent(LANDING_EVENT, { data: JSON.stringify(body) }));
  };

  await React.act(async () => {
    root.render(React.createElement(AppRouterContext.Provider, { value: router }, React.createElement(KanbanClient)));
  });
  try {
    await until(() => /Partial/i.test(text()), 'the idea tags');
    assert.equal(todoReads, 1);

    // The forge read the checks again: no tag of the idea shows them.
    announce(['checks']);
    await settle();
    assert.equal(todoReads, 1);

    // The job's pull request merged and landed: the idea is done.
    progress = 'done';
    announce(['state']);
    announce(['landed']);
    await until(() => /Done/.test(text()) && !/Partial/i.test(text()), 'the fresh tags');
    await settle();
    assert.equal(todoReads, 2, 'one read for the burst');
  } finally {
    await React.act(async () => { root.unmount(); });
    await React.act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
    resetSlotsForTests();
    dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
  }
});
