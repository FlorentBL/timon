/**
 * The provider cards (TODO #251) and their slot `providers.cli`: the product's
 * cards are the fallback, a plugin loaded through the real client loader takes
 * their place on every host at once and reads the host's context, its removal
 * gives the product's back. And the cards do what they promise: an install
 * starts on a click, its console shows while it runs, and the cards are read
 * again when it ends.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ComponentType } from 'react';
import { waitUntil } from '../../lib/test-wait';
import type { InstallJob, ProviderCli } from '@/lib/provider-clis';

const ACME = { id: 'acme-cards', state: 'active', client: { url: '/x', rev: '1', slots: ['providers.cli'] } };

function cli(name: string, over: Partial<ProviderCli> = {}): ProviderCli {
  return {
    name, label: name, brand: null, path: null, bundled: false, signedIn: null, installable: true,
    installCommand: `curl -fsSL https://${name}.invalid/install | bash`, installDocs: null, signInCommand: `${name} login`,
    signInThen: null, seedsMainAgent: true, version: null, latest: null, updateAvailable: false, unsupportedVersion: false, ...over,
  };
}

type Server = { list: ProviderCli[]; job: InstallJob | null; posts: string[] };

async function mount(server: Server, plugins: unknown[] = []) {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  for (const key of ['window', 'self', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLButtonElement', 'Element', 'Node',
    'MutationObserver', 'CustomEvent', 'Event', 'KeyboardEvent', 'MouseEvent', 'FocusEvent', 'DocumentFragment'] as const) {
    install(key, (dom.window as unknown as Record<string, unknown>)[key]);
  }
  install('getComputedStyle', dom.window.getComputedStyle.bind(dom.window));
  install('IS_REACT_ACT_ENVIRONMENT', true);
  install('fetch', async (input: string, init?: { method?: string }) => {
    const url = String(input);
    if (url === '/api/ui/plugins') return Response.json({ plugins });
    if (url === '/api/ui/backends/provider-clis') {
      return Response.json({ backends: server.list, jobs: server.job ? { [server.job.name]: server.job } : {}, updateCheck: true });
    }
    const match = /^\/api\/ui\/backends\/provider-clis\/([^/]+)\/install$/.exec(url);
    if (match) {
      if (init?.method === 'POST') {
        server.posts.push(decodeURIComponent(match[1]!));
        server.job = { name: match[1]!, command: 'curl -fsSL https://claude.invalid/install | bash', state: 'running', startedAt: 1, finishedAt: null, lines: [], dropped: 0, result: null };
        return Response.json({ job: server.job }, { status: 202 });
      }
      return server.job ? Response.json({ job: server.job }) : Response.json({ error: 'no_job' }, { status: 404 });
    }
    return new Response(null, { status: 404 });
  });

  const React = await import('react');
  install('React', React);
  const { createRoot } = await import('react-dom/client');
  const { setLocale, getLocale } = await import('@/lib/i18n');
  const previousLocale = getLocale();
  setLocale('en');
  const slots = await import('@/lib/plugin-host/slots');
  slots.resetSlotsForTests();
  const loader = await import('@/lib/plugin-host/loader');
  loader.resetClientPluginsForTests();
  const cards = await import('./provider-cli-cards');
  const context = await import('./provider-cli-context');

  const root = createRoot(document.getElementById('root')!);
  const render = async (element: React.ReactElement) => {
    await React.act(async () => { root.render(element); });
  };
  const until = (condition: () => boolean, what: string, timeoutMs?: number) => waitUntil(React.act, condition, what, timeoutMs);
  const click = async (el: Element | null | undefined) => {
    assert.ok(el, 'element to click');
    await React.act(async () => { (el as HTMLElement).click(); });
  };
  const cardCount = () => document.querySelectorAll('section[aria-label]').length;
  const occupants = () => slots.slotEntries('providers.cli').map((e) => e.pluginId);

  /** The product's cards, registered the way the bundled half of `@timon/backends` mounts them. */
  const mountProduct = async () => {
    const { coreBackendsClient } = await import('@/plugins-client/backends');
    const disposers: Array<() => void> = [];
    coreBackendsClient.apply({
      id: '@timon/backends',
      realtime: { subscribe: () => () => {} } as never,
      caps: null,
      zoneVisible: () => true,
      options: {},
      register: (options, Component) => {
        if (options.slot !== 'providers.cli') return () => {};
        const dispose = slots.register({ ...options, pluginId: '@timon/backends' }, Component);
        disposers.push(dispose);
        return dispose;
      },
      onDispose: (fn) => { disposers.push(fn); },
    });
    return () => { for (const d of disposers.splice(0).reverse()) d(); };
  };

  const unmount = async () => {
    await React.act(async () => { root.unmount(); });
    loader.setLoadClientModuleForTests(null);
    loader.resetClientPluginsForTests();
    slots.resetSlotsForTests();
    await new Promise((r) => setTimeout(r, 0));
    setLocale(previousLocale);
    dom.window.close();
    for (const [k, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, k, descriptor);
      else delete (globalThis as Record<string, unknown>)[k];
    }
  };
  return { React, cards, context, slots, loader, render, until, click, cardCount, occupants, mountProduct, unmount };
}

type Mounted = Awaited<ReturnType<typeof mount>>;

function acmeCards(m: Mounted, seen: Array<unknown>): ComponentType {
  const { React, context } = m;
  return function AcmeCards() {
    const host = context.useProviderCliCards();
    seen.push(host);
    if (!host?.backends) return null;
    return React.createElement('ul', { 'data-acme': host.mode }, host.backends.map((b) =>
      React.createElement('li', { key: b.name }, React.createElement('button', { type: 'button', 'data-acme-install': b.name, onClick: () => void host.install(b.name) }, b.label))));
  };
}

test('the slot is declared at boot, the product cards are its fallback, and an empty slot still paints them', async () => {
  const server: Server = { list: [cli('claude'), cli('hermes-acp', { installable: false, installCommand: null, installDocs: 'https://hermes.invalid/docs' })], job: null, posts: [] };
  const m = await mount(server);
  try {
    assert.equal(m.slots.slotKind('providers.cli'), 'single', 'declared before any host mounts');
    // Empty slot: the host paints the product's cards itself.
    await m.render(m.React.createElement(m.cards.ProviderCliCards, { mode: 'onboarding' }));
    await m.until(() => m.cardCount() === 2, 'the product cards');
    const docs = document.querySelector('a[href="https://hermes.invalid/docs"]');
    assert.ok(docs, 'a CLI without an installer links to its vendor page');
    assert.ok(!document.querySelector('section[aria-label="hermes-acp"] button'), 'and offers no Install');

    // The host is already painted: registering its occupant re-renders it, so under act().
    let dispose: () => void = () => {};
    await m.React.act(async () => { dispose = await m.mountProduct(); });
    assert.deepEqual(m.occupants(), ['@timon/backends']);
    assert.equal(m.slots.slotEntries('providers.cli')[0]?.fallback, true);
    await m.until(() => m.cardCount() === 2, 'the product cards through the slot');
    await m.React.act(async () => { dispose(); });
    // Outside a host, the product occupant has nothing to paint.
    await m.render(m.React.createElement(m.cards.ProductProviderCliCards));
    assert.equal(m.cardCount(), 0);
  } finally {
    await m.unmount();
  }
});

test('Install starts the job, its console shows while it runs, and the cards are read again when it ends', async () => {
  const server: Server = { list: [cli('claude')], job: null, posts: [] };
  const m = await mount(server);
  const lists: Array<ProviderCli[] | null> = [];
  try {
    await m.render(m.React.createElement(m.cards.ProviderCliCards, { mode: 'settings', onBackends: (b: ProviderCli[] | null) => lists.push(b) }));
    await m.until(() => m.cardCount() === 1, 'the card');
    const button = Array.from(document.querySelectorAll('section[aria-label="claude"] button')).find((b) => b.textContent === 'Install');
    await m.click(button);
    assert.deepEqual(server.posts, ['claude']);
    await m.until(() => document.body.textContent?.includes('curl -fsSL https://claude.invalid/install | bash') === true, 'the command being run');

    server.job = { ...server.job!, lines: ['Downloading Claude Code', ' 100%'] };
    await m.until(() => document.querySelector('pre')?.textContent?.includes(' 100%') === true, 'the console', 5_000);

    server.list = [cli('claude', { path: '/home/ann/.local/bin/claude', signedIn: true, version: '2.1.312' })];
    server.job = { ...server.job, state: 'succeeded', finishedAt: 2, result: { ok: true, command: null, reason: null } };
    await m.until(() => document.body.textContent?.includes('Ready') === true, 'the card read again', 5_000);
    assert.ok(!document.querySelector('pre'), 'the console goes once the install succeeded');
    assert.ok(document.body.textContent?.includes('v2.1.312'));
    assert.ok(lists.length >= 2);
  } finally {
    await m.unmount();
  }
});

test('an update offered by the daemon is one click on the official installer', async () => {
  const server: Server = {
    list: [cli('codex', { path: '/home/ann/.local/bin/codex', signedIn: true, version: '0.159.0', latest: '0.165.0', updateAvailable: true })],
    job: null, posts: [],
  };
  const m = await mount(server);
  try {
    await m.render(m.React.createElement(m.cards.ProviderCliCards, { mode: 'settings' }));
    await m.until(() => document.body.textContent?.includes('Update available: 0.165.0') === true, 'the update badge');
    const update = Array.from(document.querySelectorAll('section[aria-label="codex"] button')).find((b) => b.textContent === 'Update');
    await m.click(update);
    assert.deepEqual(server.posts, ['codex']);
  } finally {
    await m.unmount();
  }
});

test('Sign in types the command in Timon\'s terminal when the view has one, and copies it otherwise', async () => {
  const signInCommand = '/home/ann/.local/bin/claude';
  const server: Server = { list: [cli('claude', { label: 'Claude', path: signInCommand, signedIn: null, signInCommand, signInThen: '/login' })], job: null, posts: [] };
  const m = await mount(server);
  const typed: string[] = [];
  // What the root's `TerminalOpener` does when the view has a workspace: it takes the request.
  const terminal = (event: Event) => {
    const detail = (event as CustomEvent<{ insert?: string; accepted?: boolean }>).detail;
    typed.push(detail.insert ?? '');
    detail.accepted = true;
  };
  const copied: string[] = [];
  Object.defineProperty(window.navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => { copied.push(text); } } });
  const signIn = () => Array.from(document.querySelectorAll('section[aria-label="Claude"] button')).find((b) => b.textContent === 'Sign in');
  try {
    await m.render(m.React.createElement(m.cards.ProviderCliCards, { mode: 'onboarding' }));
    await m.until(() => signIn() !== undefined, 'the Sign in button of an installed CLI');
    window.addEventListener('timon:terminal-open', terminal);
    await m.click(signIn());
    await m.until(() => document.body.textContent?.includes("Typed in Timon's terminal") === true, 'the terminal outcome');
    assert.deepEqual(typed, [signInCommand], 'the command the daemon resolved, typed without Enter');
    assert.ok(document.body.textContent?.includes('/login'), 'what to type once it runs');
    assert.deepEqual(copied, []);

    // No terminal on this view (the onboarding has no island workspace): a copy instead.
    window.removeEventListener('timon:terminal-open', terminal);
    await m.click(signIn());
    await m.until(() => document.body.textContent?.includes('Command copied') === true, 'the copy outcome');
    assert.deepEqual(copied, [signInCommand]);
    assert.equal(typed.length, 1);
  } finally {
    window.removeEventListener('timon:terminal-open', terminal);
    await m.unmount();
  }
});

test('onboarding: one click installs, then starts the sign-in by itself, without a path, a version or a console', async () => {
  const path = '/home/ann/.local/bin/claude';
  const server: Server = { list: [cli('claude', { label: 'Claude' })], job: null, posts: [] };
  const m = await mount(server);
  const typed: string[] = [];
  const terminal = (event: Event) => {
    const detail = (event as CustomEvent<{ insert?: string; accepted?: boolean }>).detail;
    typed.push(detail.insert ?? '');
    detail.accepted = true;
  };
  const row = () => document.querySelector('section[aria-label="Claude"]');
  try {
    window.addEventListener('timon:terminal-open', terminal);
    await m.render(m.React.createElement(m.cards.ProviderCliCards, { mode: 'onboarding' }));
    await m.until(() => row()?.querySelector('[data-provider-row]') !== null && row() !== null, 'the shared provider row');
    assert.equal(row()?.querySelector('[data-provider-status]')?.getAttribute('data-provider-status'), 'not-installed');
    const buttons = () => Array.from(row()?.querySelectorAll('button') ?? []);
    assert.deepEqual(buttons().map((b) => b.textContent), ['Install and sign in'], 'one gesture, nothing else');
    await m.click(buttons()[0]);
    assert.deepEqual(server.posts, ['claude']);
    await m.until(() => row()?.getAttribute('data-state') === 'installing', 'the install running');
    server.job = { ...server.job!, lines: ['Downloading Claude Code'] };
    assert.ok(!document.querySelector('pre'), 'no console on the onboarding');
    assert.deepEqual(typed, [], 'no sign-in before the program is there');

    server.list = [cli('claude', { label: 'Claude', path, signedIn: false, version: '2.1.312', signInCommand: `${path} auth login` })];
    server.job = { ...server.job, state: 'succeeded', finishedAt: 2, result: { ok: true, command: null, reason: null } };
    await m.until(() => typed.length === 1, 'the sign-in started by itself', 5_000);
    assert.deepEqual(typed, [`${path} auth login`]);
    await m.until(() => document.body.textContent?.includes("Typed in Timon's terminal") === true, 'what comes next');
    assert.equal(row()?.querySelector('[data-provider-status]')?.getAttribute('data-provider-status'), 'not-connected');
    assert.equal(document.body.textContent?.includes(path), false, 'no path shown');
    assert.equal(document.body.textContent?.includes('2.1.312'), false, 'no version shown');

    // Signed in: the row says so, and offers nothing more.
    server.list = [cli('claude', { label: 'Claude', path, signedIn: true })];
    const retry = Array.from(document.querySelectorAll('button')).find((b) => b.textContent === 'Try again');
    await m.click(retry);
    await m.until(() => row()?.querySelector('[data-provider-status]')?.getAttribute('data-provider-status') === 'connected', 'connected');
    assert.equal(buttons().length, 0);
    assert.equal(typed.length, 1, 'the sign-in is not started twice');
  } finally {
    window.removeEventListener('timon:terminal-open', terminal);
    await m.unmount();
  }
});

test('onboarding: a failed install ends the chain, and shows the reason and the command to run by hand', async () => {
  const server: Server = { list: [cli('codex', { label: 'Codex' })], job: null, posts: [] };
  const m = await mount(server);
  const typed: string[] = [];
  const terminal = (event: Event) => {
    typed.push((event as CustomEvent<{ insert?: string }>).detail.insert ?? '');
  };
  try {
    window.addEventListener('timon:terminal-open', terminal);
    await m.render(m.React.createElement(m.cards.ProviderCliCards, { mode: 'onboarding' }));
    await m.until(() => document.querySelector('section[aria-label="Codex"] button') !== null, 'the row');
    await m.click(document.querySelector('section[aria-label="Codex"] button'));
    server.job = { ...server.job!, state: 'failed', finishedAt: 2, result: { ok: false, command: 'npm i -g @openai/codex', reason: 'npm not found' } };
    await m.until(() => document.querySelector('section[aria-label="Codex"] [role="alert"]')?.textContent === 'npm not found', 'the reason', 5_000);
    assert.ok(document.body.textContent?.includes('npm i -g @openai/codex'), 'the command to run by hand');
    assert.deepEqual(typed, [], 'no sign-in after a failed install');
    assert.equal(document.querySelector('section[aria-label="Codex"] button')?.textContent, 'Install and sign in', 'it can be tried again');
  } finally {
    window.removeEventListener('timon:terminal-open', terminal);
    await m.unmount();
  }
});

test('onboarding: an install that succeeded but left no program to find gives the row its button back, with why', async () => {
  // Windows: the installer ended well, but the daemon's PATH was not refreshed, so the program stays unfound.
  const server: Server = { list: [cli('claude', { label: 'Claude' })], job: null, posts: [] };
  const m = await mount(server);
  const typed: string[] = [];
  const terminal = (event: Event) => {
    typed.push((event as CustomEvent<{ insert?: string }>).detail.insert ?? '');
  };
  const row = () => document.querySelector('section[aria-label="Claude"]');
  try {
    window.addEventListener('timon:terminal-open', terminal);
    await m.render(m.React.createElement(m.cards.ProviderCliCards, { mode: 'onboarding' }));
    await m.until(() => row()?.querySelector('button') !== null, 'the row');
    await m.click(row()?.querySelector('button'));
    await m.until(() => row()?.getAttribute('data-state') === 'installing', 'the install running');

    server.job = { ...server.job!, state: 'succeeded', finishedAt: 2, result: { ok: true, command: null, reason: null } };
    await m.until(() => row()?.querySelector('button')?.textContent === 'Install and sign in', 'the button back', 5_000);
    assert.doesNotMatch(row()?.textContent ?? '', /Installing/, 'no spinner left');
    assert.match(row()?.textContent ?? '', /Installed, but Timon cannot find the program/);
    assert.deepEqual(typed, [], 'no sign-in without a program');

    // The program shows up on a later read: the reason goes, the sign-in is the next gesture.
    server.list = [cli('claude', { label: 'Claude', path: 'C:\\Users\\ann\\.local\\bin\\claude.exe', signedIn: false })];
    const retry = Array.from(document.querySelectorAll('button')).find((b) => b.textContent === 'Try again');
    await m.click(retry);
    await m.until(() => row()?.querySelector('button')?.textContent === 'Sign in', 'sign in offered');
    assert.doesNotMatch(row()?.textContent ?? '', /cannot find the program/);
  } finally {
    window.removeEventListener('timon:terminal-open', terminal);
    await m.unmount();
  }
});

test('opencode 2 found: the card says why it is left alone, and offers no button that would replace it', async () => {
  const server: Server = {
    // What the daemon answers for a 2.x: not installable, no update, even with a newer 1.x published.
    list: [cli('opencode', {
      label: 'opencode', path: '/home/ann/.opencode/bin/opencode', signedIn: true, version: '2.0.0', latest: '1.14.29',
      installable: false, installCommand: null, installDocs: 'https://opencode.ai/docs/', unsupportedVersion: true,
    })],
    job: null, posts: [],
  };
  const m = await mount(server);
  try {
    await m.render(m.React.createElement(m.cards.ProviderCliCards, { mode: 'settings' }));
    await m.until(() => document.body.textContent?.includes('opencode 2.0.0 found') === true, 'the unsupported notice');
    // The "…" stays, for where the program lives (TODO #1198): no action besides it.
    assert.equal(document.querySelectorAll('section[aria-label="opencode"] button:not([data-row-menu])').length, 0, 'no Install, no Update');
    assert.ok(!document.body.textContent?.includes('Found at'), 'no path in permanence');
    assert.ok(!document.body.textContent?.includes('Update available'));
    assert.ok(document.querySelector('section[aria-label="opencode"] a[href="https://opencode.ai/docs/"]'), 'the vendor page instead');
  } finally {
    await m.unmount();
  }
});

test('a plugin takes the slot on every host, reads the host, and its removal gives the product cards back', async () => {
  const server: Server = { list: [cli('claude'), cli('grok')], job: null, posts: [] };
  const m = await mount(server, [ACME]);
  const seen: unknown[] = [];
  try {
    const dispose = await m.mountProduct();
    m.loader.setLoadClientModuleForTests(async () => ({
      apply(ctx) { ctx.slots.register({ slot: 'providers.cli' }, acmeCards(m, seen)); },
    }));
    await m.loader.syncClientPlugins();
    assert.equal(m.occupants()[0], 'acme-cards', 'the replacement wins over the fallback');
    await m.render(m.React.createElement('div', null,
      m.React.createElement(m.cards.ProviderCliCards, { mode: 'onboarding' }),
      m.React.createElement(m.cards.ProviderCliCards, { mode: 'settings' })));
    await m.until(() => document.querySelectorAll('[data-acme]').length === 2, 'the replacement on both hosts');
    assert.deepEqual(Array.from(document.querySelectorAll('[data-acme]')).map((el) => el.getAttribute('data-acme')), ['onboarding', 'settings']);
    assert.equal(m.cardCount(), 0, 'the product cards are not painted under it');
    await m.click(document.querySelector('[data-acme-install="grok"]'));
    assert.deepEqual(server.posts, ['grok'], 'the host runs the gesture the replacement asked for');

    m.loader.setLoadClientModuleForTests(null);
    await m.React.act(async () => { m.loader.resetClientPluginsForTests(); });
    await m.until(() => m.cardCount() === 4, 'the product cards back on both hosts');
    await m.React.act(async () => { dispose(); });
  } finally {
    await m.unmount();
  }
});

/**
 * `examples/plugin-provider-cards`, loaded as the platform loads it: plain ESM
 * whose `react` and `@timon/ui` imports are the platform's own.
 */
async function loadExample(): Promise<{ apply: (ctx: unknown) => void; cleanup: () => void }> {
  const source = readFileSync(resolve(process.cwd(), '..', 'examples', 'plugin-provider-cards', 'lib', 'client.js'), 'utf8');
  const platform = source
    .replace(/import React from 'react'\n/, 'const React = globalThis.__cardsTestReact\n')
    .replace(/import \{([^}]*)\} from '@timon\/ui'\n/, 'const {$1} = globalThis.__cardsTestUi\n');
  assert.notEqual(platform, source, 'the client still imports react and @timon/ui');
  const React = await import('react');
  const { UI_KIT } = await import('@/lib/plugin-host/ui-kit');
  Object.assign(globalThis, { __cardsTestReact: React, __cardsTestUi: UI_KIT });
  const dir = mkdtempSync(join(tmpdir(), 'provider-cards-example-'));
  const file = join(dir, 'client.mjs');
  writeFileSync(file, platform);
  const mod = await import(pathToFileURL(file).href) as { apply: (ctx: unknown) => void };
  return { apply: mod.apply, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('the examples/plugin-provider-cards template replaces the cards with the SDK alone', async () => {
  const server: Server = {
    list: [
      cli('claude', { label: 'Claude Code' }),
      cli('codex', { label: 'Codex', path: '/a/codex', signedIn: true, version: '0.159.0', latest: '0.165.0', updateAvailable: true }),
      cli('pi', { label: 'Pi', installable: false, installCommand: null, installDocs: 'https://pi.invalid' }),
    ],
    job: null, posts: [],
  };
  const m = await mount(server);
  const example = await loadExample();
  try {
    const disposeProduct = await m.mountProduct();
    const disposers: Array<() => void> = [];
    example.apply({
      id: 'example-provider-cards',
      slots: { register: (options: { slot: string }, Component: ComponentType) => {
        const dispose = m.slots.register({ ...options, pluginId: 'example-provider-cards' }, Component);
        disposers.push(dispose);
        return dispose;
      } },
    });
    assert.equal(m.occupants()[0], 'example-provider-cards');
    await m.render(m.React.createElement(m.cards.ProviderCliCards, { mode: 'onboarding' }));
    const rows = () => Array.from(document.querySelectorAll('li'));
    await m.until(() => rows().length === 3, 'the compact list');
    assert.equal(m.cardCount(), 0, 'the product cards step aside');
    assert.ok(document.querySelector('a[href="https://pi.invalid"]'), 'no installer: the vendor page');
    const update = Array.from(document.querySelectorAll('button')).find((b) => b.textContent === 'Update to 0.165.0');
    await m.click(update);
    assert.deepEqual(server.posts, ['codex']);
    await m.React.act(async () => { for (const d of disposers.splice(0)) d(); });
    await m.until(() => m.cardCount() === 3, 'the product cards back');
    await m.React.act(async () => { disposeProduct(); });
  } finally {
    example.cleanup();
    await m.unmount();
  }
});
