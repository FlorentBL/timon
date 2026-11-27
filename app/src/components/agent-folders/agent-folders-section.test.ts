/**
 * An agent's or a project's extra folders and their slot `agent.folders`: the
 * host (`AgentFoldersSection`) reads the lists and runs the gestures, the
 * product's section paints them from `useAgentFolders()`, a plugin that takes
 * the slot replaces it on every host and calls the same gestures, and a person
 * who may not read the agents gets nothing painted.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ComponentType } from 'react';
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
  const slots = await import('@/lib/plugin-host/slots');
  slots.resetSlotsForTests();
  const section = await import('./agent-folders-section');
  const context = await import('./agent-folders-context');
  // The product's section, registered the way the bundled half of `@timon/agents` mounts it.
  slots.register({ slot: slots.AGENT_FOLDERS_SLOT, pluginId: '@timon/agents', fallback: true }, section.ProductAgentFolders);

  const root = createRoot(document.getElementById('root')!);
  const render = async (element: React.ReactElement) => {
    await React.act(async () => { root.render(element); });
  };
  const until = (condition: () => boolean, what: string) => waitUntil(React.act, condition, what);
  const unmount = async () => {
    await React.act(async () => { root.unmount(); });
    slots.resetSlotsForTests();
    setLocale(previousLocale);
    dom.window.close();
    for (const [k, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, k, descriptor);
      else delete (globalThis as Record<string, unknown>)[k];
    }
  };
  return { React, slots, section, context, render, until, unmount };
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

test('a plugin that takes `agent.folders` replaces the section, reads its host and writes through it; removed, the product section is back', async () => {
  const fake = daemon({ 'projects:acme': [], 'agents:acme.coder': [{ path: '/home/me/notes', mode: 'read' }] });
  const m = await mount(fake.fetch);
  try {
    const { React, slots, section, context } = m;
    let host: ReturnType<typeof context.useAgentFolders> = null;
    const off = slots.register({ slot: slots.AGENT_FOLDERS_SLOT, pluginId: 'acme-folders' }, function FolderList() {
      host = context.useAgentFolders();
      if (!host || host.status !== 'ready') return null;
      return React.createElement('ul', { 'data-plugin-folders': '', className: host.className },
        host.rows.map((row) => React.createElement('li', { key: `${row.owner.kind}:${row.path}` }, `${row.name}:${row.mode}`)));
    });
    await m.render(React.createElement(section.AgentFoldersSection, { agents: ['acme.coder'], project: 'acme', showAgent: true, className: 'mt-4' }));
    await m.until(() => document.querySelector('[data-plugin-folders] li') !== null, 'the plugin list');
    assert.ok(!document.querySelector('[data-agent-folder]'), 'the product section steps aside');
    assert.equal(document.querySelector('[data-plugin-folders]')?.className, 'mt-4');
    const ready = () => host!;
    assert.deepEqual(ready().agents, ['acme.coder']);
    assert.equal(ready().project, 'acme');
    assert.equal(ready().showAgent, true);
    assert.equal(ready().emptyStatus, null);
    assert.deepEqual(ready().owners, [{ kind: 'project', slug: 'acme' }, { kind: 'agent', name: 'acme.coder' }]);
    assert.deepEqual(ready().rows, [{ owner: { kind: 'agent', name: 'acme.coder' }, path: '/home/me/notes', name: 'notes', mode: 'read', dropped: null }]);

    // The gestures go to the daemon's one door, and the host's lists follow.
    let result = await React.act(async () => ready().setMode({ kind: 'agent', name: 'acme.coder' }, '/home/me/notes', 'write'));
    assert.deepEqual(result, { ok: true });
    await m.until(() => document.querySelector('[data-plugin-folders] li')?.textContent === 'notes:write', 'the new access');
    result = await React.act(async () => ready().add({ kind: 'project', slug: 'acme' }, { path: '/srv/shared', mode: 'read' }));
    assert.deepEqual(result, { ok: true });
    await m.until(() => ready().rows.length === 2 && ready().rows[0]!.owner.kind === 'project', 'the project\'s folder first');
    result = await React.act(async () => ready().remove({ kind: 'agent', name: 'acme.coder' }, '/home/me/notes'));
    assert.deepEqual(result, { ok: true });
    await m.until(() => ready().rows.length === 1, 'the folder gone');
    assert.deepEqual(fake.calls.filter((c) => c.method !== 'GET').map((c) => `${c.method} ${c.url} ${JSON.stringify(c.body)}`), [
      'POST /api/ui/agents/acme.coder/extra-dirs {"path":"/home/me/notes","mode":"write"}',
      'POST /api/ui/projects/acme/extra-dirs {"path":"/srv/shared","mode":"read"}',
      'DELETE /api/ui/agents/acme.coder/extra-dirs {"path":"/home/me/notes"}',
    ]);

    await React.act(async () => { off(); });
    await m.until(() => document.querySelector('[data-agent-folder="/srv/shared"]') !== null, 'the product section again');
    assert.ok(!document.querySelector('[data-plugin-folders]'));
  } finally {
    await m.unmount();
  }
});

test('a refused gesture comes back to the occupant with the daemon\'s message, and nothing changes', async () => {
  const fake = daemon({ 'agents:solo': [{ path: '/home/me/notes', mode: 'read' }] }, { refuse: 'This folder holds credentials.' });
  const m = await mount(fake.fetch);
  try {
    const { React, slots, section, context } = m;
    let host: ReturnType<typeof context.useAgentFolders> = null;
    slots.register({ slot: slots.AGENT_FOLDERS_SLOT, pluginId: 'acme-folders' }, function Probe() {
      host = context.useAgentFolders();
      return null;
    });
    await m.render(React.createElement(section.AgentFoldersSection, { agents: ['solo'] }));
    await m.until(() => host?.status === 'ready', 'the lists read');
    const result = await React.act(async () => host!.add({ kind: 'agent', name: 'solo' }, { path: '/home/me/.ssh', mode: 'read' }));
    assert.equal(result.ok, false);
    assert.match(result.ok ? '' : result.message, /credentials/);
    assert.equal(host!.busy, false);
    assert.deepEqual(host!.rows.map((r) => r.path), ['/home/me/notes']);
  } finally {
    await m.unmount();
  }
});

/**
 * `examples/plugin-agent-folders`, loaded as the platform loads it: plain ESM
 * whose `react` and `@timon/ui` imports are the platform's own.
 */
async function loadExample(): Promise<{ apply: (ctx: unknown) => void; cleanup: () => void }> {
  const source = readFileSync(resolve(process.cwd(), '..', 'examples', 'plugin-agent-folders', 'lib', 'client.js'), 'utf8');
  const platform = source
    .replace(/import React from 'react'\n/, 'const React = globalThis.__foldersTestReact\n')
    .replace(/import \{([^}]*)\} from '@timon\/ui'\n/, 'const {$1} = globalThis.__foldersTestUi\n');
  assert.notEqual(platform, source, 'the client still imports react and @timon/ui');
  const React = await import('react');
  const { UI_KIT } = await import('@/lib/plugin-host/ui-kit');
  Object.assign(globalThis, { __foldersTestReact: React, __foldersTestUi: UI_KIT });
  const dir = mkdtempSync(join(tmpdir(), 'agent-folders-example-'));
  const file = join(dir, 'client.mjs');
  writeFileSync(file, platform);
  const mod = await import(pathToFileURL(file).href) as { apply: (ctx: unknown) => void };
  return { apply: mod.apply, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('the examples/plugin-agent-folders template groups the folders by owner and switches their access with the SDK alone', async () => {
  const fake = daemon({
    'projects:acme': [{ path: '/srv/shared', mode: 'read' }],
    'agents:acme.coder': [{ path: '/home/me/notes', mode: 'read' }],
  });
  const m = await mount(fake.fetch);
  const example = await loadExample();
  try {
    const { React, slots, section } = m;
    example.apply({
      id: 'example-agent-folders',
      slots: { register: (options: { slot: string }, Component: ComponentType) => slots.register({ ...options, pluginId: 'example-agent-folders' }, Component) },
    });
    await m.render(React.createElement(section.AgentFoldersSection, { agents: ['acme.coder'], project: 'acme', showAgent: true }));
    await m.until(() => document.querySelectorAll('[data-example-folder]').length === 2, 'the template\'s rows');
    assert.ok(!document.querySelector('[data-agent-folder]'), 'the product section steps aside');
    const text = document.querySelector('[data-example-agent-folders]')?.textContent ?? '';
    assert.ok(text.indexOf('Project acme') < text.indexOf('acme.coder'), 'the project\'s group first');

    const toggle = document.querySelector<HTMLButtonElement>('[data-example-folder="/home/me/notes"] button[aria-pressed]');
    assert.equal(toggle?.getAttribute('aria-pressed'), 'false');
    await React.act(async () => { toggle!.click(); });
    await m.until(() => document.querySelector('[data-example-folder="/home/me/notes"] button[aria-pressed]')?.getAttribute('aria-pressed') === 'true', 'the folder writable');
    assert.deepEqual(fake.calls.filter((c) => c.method === 'POST').map((c) => c.body), [{ path: '/home/me/notes', mode: 'write' }]);
  } finally {
    example.cleanup();
    await m.unmount();
  }
});
