/**
 * An agent's or a project's extra folders: the host (`AgentFoldersSection`)
 * reads the lists and runs the gestures, the product's section paints them
 * from `useAgentFolders()`, and a person who may not read the agents gets
 * nothing painted.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { waitUntil } from '../../lib/test-wait';

type Stored = { path: string; mode: 'read' | 'write' };
type Call = { method: string; url: string; body: unknown };

/** A daemon of extra folders in memory: one list per agent or project, a status per endpoint. */
function daemon(lists: Record<string, Stored[]>, options: { status?: Record<string, number>; dropped?: Record<string, Array<{ path: string; reason: string }>>; refuse?: string } = {}) {
  const calls: Call[] = [];
  const fetch = (async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    const body: unknown = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ method, url, body });
    const key = decodeURIComponent(url.replace(/^\/api\/ui\/(agents|projects)\//, '$1:').replace(/\/extra-dirs$/, ''));
    const status = options.status?.[key] ?? 200;
    if (status !== 200) return new Response(JSON.stringify({ error: 'forbidden' }), { status });
    if (method !== 'GET' && options.refuse) return new Response(JSON.stringify({ error: options.refuse }), { status: 400 });
    const list = lists[key] ?? [];
    const sent = body as Stored | undefined;
    if (method === 'POST' && sent) lists[key] = [...list.filter((f) => f.path !== sent.path), { path: sent.path, mode: sent.mode }];
    if (method === 'DELETE' && sent) lists[key] = list.filter((f) => f.path !== sent.path);
    return new Response(JSON.stringify({ extra_dirs: lists[key] ?? [], dropped: options.dropped?.[key] ?? [], running: 0 }), { status: 200 });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

async function mount(fake: typeof globalThis.fetch) {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  for (const key of ['window', 'self', 'document', 'navigator', 'HTMLElement', 'HTMLButtonElement', 'Element', 'Node',
    'MutationObserver', 'CustomEvent', 'Event', 'MouseEvent', 'DocumentFragment'] as const) {
    install(key, (dom.window as unknown as Record<string, unknown>)[key]);
  }
  install('getComputedStyle', dom.window.getComputedStyle.bind(dom.window));
  install('IS_REACT_ACT_ENVIRONMENT', true);
  install('fetch', fake);

  const React = await import('react');
  install('React', React);
  const { createRoot } = await import('react-dom/client');
  const { setLocale, getLocale } = await import('@/lib/i18n');
  const previousLocale = getLocale();
  setLocale('en');
  const section = await import('./agent-folders-section');
  const context = await import('./agent-folders-context');

  const root = createRoot(document.getElementById('root')!);
  const render = async (element: React.ReactElement) => {
    await React.act(async () => { root.render(element); });
  };
  const until = (condition: () => boolean, what: string) => waitUntil(React.act, condition, what);
  const unmount = async () => {
    await React.act(async () => { root.unmount(); });
    setLocale(previousLocale);
    dom.window.close();
    for (const [k, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, k, descriptor);
      else delete (globalThis as Record<string, unknown>)[k];
    }
  };
  return { React, section, context, render, until, unmount };
}

const rowTexts = (): string[] => Array.from(document.querySelectorAll('[data-agent-folder]')).map((row) => row.textContent ?? '');

test('the product section paints the project\'s folders first, then each agent\'s, with their owner and access', async () => {
  const fake = daemon({
    'projects:acme': [{ path: '/srv/shared', mode: 'read' }],
    'agents:acme.coder': [{ path: '/home/me/notes', mode: 'write' }, { path: '/mnt/gone', mode: 'read' }],
    'agents:acme.reviewer': [],
  }, { dropped: { 'agents:acme.coder': [{ path: '/mnt/gone', reason: 'The folder does not exist.' }] } });
  const m = await mount(fake.fetch);
  try {
    await m.render(m.React.createElement(m.section.AgentFoldersSection, { agents: ['acme.coder', 'acme.reviewer'], project: 'acme', showAgent: true }));
    await m.until(() => rowTexts().length === 3, 'three rows');
    const rows = rowTexts();
    assert.match(rows[0]!, /^shared/);
    assert.match(rows[0]!, /Read only/i);
    assert.match(rows[1]!, /^notes/);
    assert.match(rows[1]!, /acme\.coder/);
    assert.match(rows[2]!, /^gone/);
    assert.equal(document.querySelectorAll('[data-agent-folder] [title*="The folder does not exist."]').length, 1, 'the dropped folder says why');
    assert.ok(document.querySelector('[data-agent-folders-add]'), 'a folder can be added');
  } finally {
    await m.unmount();
  }
});

test('an agent without folders gets the surface\'s empty line, or the default one', async () => {
  const m = await mount(daemon({ 'agents:solo': [] }).fetch);
  try {
    await m.render(m.React.createElement(m.section.AgentFoldersSection, { agents: ['solo'] }));
    await m.until(() => document.querySelector('[data-agent-folders-empty]') !== null, 'the empty row');
    const fallback = document.querySelector('[data-agent-folders-empty]')?.textContent ?? '';
    await m.render(m.React.createElement(m.section.AgentFoldersSection, { agents: ['solo'], emptyStatus: 'Nothing for this project yet.' }));
    await m.until(() => /Nothing for this project yet\./.test(document.querySelector('[data-agent-folders-empty]')?.textContent ?? ''), 'the surface\'s words');
    assert.doesNotMatch(fallback, /Nothing for this project yet\./);
  } finally {
    await m.unmount();
  }
});

test('a person who may not read the agent\'s folders gets nothing painted', async () => {
  const fake = daemon({}, { status: { 'agents:secret': 403 } });
  const m = await mount(fake.fetch);
  try {
    await m.render(m.React.createElement(m.section.AgentFoldersSection, { agents: ['secret'] }));
    await m.until(() => fake.calls.length > 0 && document.querySelector('section[aria-busy]') === null, 'the read refused');
    assert.equal(document.getElementById('root')?.innerHTML, '');
  } finally {
    await m.unmount();
  }
});
