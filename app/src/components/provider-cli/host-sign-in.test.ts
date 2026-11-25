/**
 * The host's own sign-in done in the app (TODO #426), on the screens that offer it: the
 * onboarding's provider rows and the row of the providers list. Without a session, "Sign in"
 * opens the page-and-code dialog instead of typing a command in a terminal; with a terminal
 * session and no long-lived token, the row offers one; once both are there, nothing. The
 * dialog follows the daemon's flow to its verdict and cancels it when closed early. The
 * daemon's refusals (anonymous, mission, daemon token) are `host-sign-in-routes.test.ts`'s.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { waitUntil } from '../../lib/test-wait';
import type { HostSignInView } from '@/lib/host-sign-in';
import type { ProviderCli } from '@/lib/provider-clis';

const AUTHORIZE = 'https://claude.com/cai/oauth/authorize?code=true&state=abc';

function view(over: Partial<HostSignInView> = {}): HostSignInView {
  return { backend: 'claude', kept: false, identity: null, browser: true, token: { stored: false }, signedIn: false, ...over };
}

function cli(over: Partial<ProviderCli> = {}): ProviderCli {
  return {
    name: 'claude', label: 'Claude', brand: null, path: '/usr/bin/claude', bundled: false, signedIn: false, installable: true,
    installCommand: null, installDocs: null, signInCommand: '/usr/bin/claude', signInThen: '/login', seedsMainAgent: true,
    version: '2.1.322', latest: null, updateAvailable: false, unsupportedVersion: false, host: view(), ...over,
  };
}

type Flow = { state: string; prompt: { kind: 'paste-code'; url: string } | null; codeSent: boolean; identity: string | null; failure: string | null };
type Server = { list: ProviderCli[]; flows: Record<string, Flow>; calls: string[]; codes: string[] };

async function mount(server: Server) {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  for (const key of ['window', 'self', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLButtonElement', 'HTMLFormElement',
    'Element', 'Node', 'MutationObserver', 'CustomEvent', 'Event', 'KeyboardEvent', 'MouseEvent', 'FocusEvent', 'PointerEvent',
    'SubmitEvent', 'DocumentFragment', 'NodeFilter', 'requestAnimationFrame', 'cancelAnimationFrame'] as const) {
    install(key, (dom.window as unknown as Record<string, unknown>)[key]);
  }
  install('getComputedStyle', dom.window.getComputedStyle.bind(dom.window));
  install('IS_REACT_ACT_ENVIRONMENT', true);
  // A terminal would take the command: none must be asked for when the app signs in.
  const typed: string[] = [];
  dom.window.addEventListener('timon:terminal-open', (event) => {
    const detail = (event as CustomEvent<{ insert?: string; accepted?: boolean }>).detail;
    typed.push(detail.insert ?? '');
    detail.accepted = true;
  });
  install('fetch', async (input: string, init?: { method?: string; body?: string }) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (url === '/api/ui/plugins') return Response.json({ plugins: [] });
    if (url === '/api/ui/backends/provider-clis') return Response.json({ backends: server.list, jobs: {}, updateCheck: true });
    const match = /^\/api\/ui\/backends\/host-sign-in\/claude\/(login|token)(\/code)?$/.exec(url);
    if (match) {
      const kind = match[1]!;
      server.calls.push(`${method} ${kind}${match[2] ?? ''}`);
      const flow = (): Flow => server.flows[kind]!;
      if (match[2]) {
        server.codes.push((JSON.parse(init!.body!) as { code: string }).code);
        server.flows[kind] = { ...flow(), codeSent: true, state: 'verifying' };
        return Response.json({ login: flow() });
      }
      if (method === 'POST') {
        server.flows[kind] = { state: 'waiting', prompt: { kind: 'paste-code', url: AUTHORIZE }, codeSent: false, identity: null, failure: null };
        return Response.json({ login: flow() }, { status: 202 });
      }
      if (method === 'DELETE') {
        server.flows[kind] = { ...flow(), state: 'failed', failure: 'cancelled' };
        return Response.json({ login: flow() });
      }
      return server.flows[kind] ? Response.json({ login: flow() }) : Response.json({ error: 'none' }, { status: 404 });
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
  const root = createRoot(document.getElementById('root')!);
  const render = async (element: React.ReactElement) => { await React.act(async () => { root.render(element); }); };
  const until = (condition: () => boolean, what: string) => waitUntil(React.act, condition, what);
  const click = async (el: Element | null | undefined) => {
    assert.ok(el, 'element to click');
    await React.act(async () => { (el as HTMLElement).click(); });
  };
  const type = async (input: HTMLInputElement, value: string) => {
    await React.act(async () => {
      const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input, value);
      input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    });
  };
  const unmount = async () => {
    await React.act(async () => { root.unmount(); });
    slots.resetSlotsForTests();
    await new Promise((r) => setTimeout(r, 0));
    setLocale(previousLocale);
    dom.window.close();
    for (const [k, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, k, descriptor);
      else delete (globalThis as Record<string, unknown>)[k];
    }
  };
  return { React, render, until, click, type, unmount, typed };
}

const offer = (kind: string) => document.querySelector(`[data-host-sign-in-offer="${kind}"]`);
const dialog = () => document.querySelector('[data-host-sign-in]');
/** The page's link, read by attribute: a selector would have to escape the address's `&`. */
const linkShown = () => Array.from(document.querySelectorAll('a')).some((a) => a.getAttribute('href') === AUTHORIZE);

test('setup: "Sign in" opens the page-and-code dialog, no terminal, and the flow runs to its verdict', async () => {
  const server: Server = { list: [cli()], flows: {}, calls: [], codes: [] };
  const m = await mount(server);
  try {
    const { ProviderCliCards } = await import('./provider-cli-cards');
    await m.render(m.React.createElement(ProviderCliCards, { mode: 'onboarding' }));
    await m.until(() => offer('login') !== null, 'the in-app sign-in button');
    await m.click(offer('login'));
    await m.until(linkShown, 'the sign-in page link');
    assert.equal(dialog()?.getAttribute('data-host-sign-in'), 'login');
    assert.deepEqual(m.typed, [], 'no command was typed in a terminal');
    assert.deepEqual(server.calls, ['POST login']);

    await m.type(document.querySelector('[data-host-sign-in] input') as HTMLInputElement, '  pasted-code#state  ');
    const submit = Array.from(document.querySelectorAll('[data-host-sign-in] button')).find((b) => b.getAttribute('type') === 'submit');
    await m.click(submit);
    await m.until(() => server.codes.length === 1, 'the code sent to the daemon');
    assert.deepEqual(server.codes, ['pasted-code#state']);
    server.flows.login = { ...server.flows.login!, state: 'connected', identity: 'host@perso.example' };
    await m.until(() => dialog()?.textContent?.includes('Claude is signed in as host@perso.example') === true, 'the verdict');
  } finally {
    await m.unmount();
  }
});

test('setup: a signed-in row offers no token, whatever the session: the token lives on the provider\'s page', async () => {
  for (const host of [
    view({ signedIn: true }),
    view({ signedIn: true, token: { stored: true } }),
    view({ signedIn: true, kept: true, identity: 'a@b.example' }),
  ]) {
    const server: Server = { list: [cli({ signedIn: true, host })], flows: {}, calls: [], codes: [] };
    const m = await mount(server);
    try {
      const { ProviderCliCards } = await import('./provider-cli-cards');
      await m.render(m.React.createElement(ProviderCliCards, { mode: 'onboarding' }));
      await m.until(() => document.querySelector('[data-state="ready"]') !== null, 'the ready row');
      assert.equal(offer('token'), null, JSON.stringify(host));
      assert.equal(offer('login'), null);
    } finally {
      await m.unmount();
    }
  }
});

test('setup: a sign-in Timon keeps is ready even while the verdict still says signed out', async () => {
  const host = view({ kept: true, identity: 'a@b.example', signedIn: false });
  const server: Server = { list: [cli({ signedIn: false, host })], flows: {}, calls: [], codes: [] };
  const m = await mount(server);
  try {
    const { ProviderCliCards } = await import('./provider-cli-cards');
    await m.render(m.React.createElement(ProviderCliCards, { mode: 'onboarding' }));
    await m.until(() => document.querySelector('[data-state="ready"]') !== null, 'the ready row');
    assert.ok(!document.querySelector('[data-host-sign-in-offer]'), 'no "Sign in" again, no token offer');
  } finally {
    await m.unmount();
  }
});

test('a CLI whose host sign-in Timon cannot keep still signs in with its terminal command', async () => {
  const server: Server = { list: [cli({ host: null })], flows: {}, calls: [], codes: [] };
  const m = await mount(server);
  try {
    const { ProviderCliCards } = await import('./provider-cli-cards');
    await m.render(m.React.createElement(ProviderCliCards, { mode: 'onboarding' }));
    await m.until(() => document.querySelector('[data-state="signIn"] button') !== null, 'the sign-in button');
    assert.equal(offer('login'), null);
    await m.click(document.querySelector('[data-state="signIn"] button'));
    await m.until(() => m.typed.length === 1, 'the command typed in the terminal');
    assert.equal(dialog(), null);
  } finally {
    await m.unmount();
  }
});

function overview(connection: Record<string, unknown>) {
  return {
    id: 'claude', name: 'Claude', brand: null, icon: null, origin: 'built-in', pluginId: 'provider-claude', plugin: null, catalogAgent: null,
    enabled: true, isDefault: true, backends: [], modelCount: 1, agentCount: 0,
    connection: { signedIn: false, signInCommand: '/usr/bin/claude', signInThen: '/login', acceptsAccounts: true, accounts: [], ...connection },
    secret: { required: false, present: false, names: [] }, programs: [], status: 'not-connected', updateAvailable: false,
  };
}

test('the provider page: this computer signs in in the app, a kept sign-in says who, and goes back to the terminal', async () => {
  const { computerState } = await import('@/plugins-client/backends/provider-connection-section');
  assert.deepEqual(computerState(overview({ signedIn: true, host: view({ kept: true, identity: 'a@b.example', signedIn: true }) }).connection as never),
    { tone: 'ready', key: 'hostSignIn.status.kept' });

  const server: Server = { list: [], flows: {}, calls: [], codes: [] };
  const m = await mount(server);
  const forgets: string[] = [];
  const own = globalThis.fetch;
  globalThis.fetch = (async (input: string, init?: { method?: string }) => {
    if (String(input) === '/api/ui/backends/host-sign-in/claude' && init?.method === 'DELETE') {
      forgets.push('DELETE');
      return Response.json({ hostSignIn: view({ signedIn: true }) });
    }
    if (String(input) === '/api/ui/backends/accounts') return Response.json({ accounts: [], backends: ['claude'] });
    if (String(input) === '/api/ui/auth/me') return Response.json({ user: { id: 'owner', is_superadmin: true }, needsSetup: false });
    if (String(input) === '/api/ui/backends/claude-token') return Response.json({ configured: false, readable: false, serviceOutsideSession: false });
    return own(input, init);
  }) as typeof fetch;
  try {
    const { ConnectionSection } = await import('@/plugins-client/backends/provider-connection-section');
    const { ClaudeTokenPanel } = await import('@/plugins-client/backends/claude-token');
    const { ProviderPageProvider } = await import('@/components/provider-page/provider-page-context');
    let refreshed = 0;
    const page = (connection: Record<string, unknown>) => m.React.createElement(ProviderPageProvider, {
      value: { provider: overview(connection) as never, status: 'not-connected', defaultBackend: null, refresh: async () => { refreshed += 1; }, back: () => {} },
    }, m.React.createElement(ConnectionSection), m.React.createElement(ClaudeTokenPanel));
    const computer = () => document.querySelector('[data-connection="computer"]');

    // Not signed in: the one action signs in in the app.
    await m.render(page({ host: view() }));
    await m.until(() => computer()?.querySelector('[data-host-sign-in-offer="login"]') != null, 'the in-app sign-in action');
    assert.match(computer()!.textContent ?? '', /Not signed in/);
    await m.click(computer()!.querySelector('[data-host-sign-in-offer="login"]'));
    await m.until(() => dialog()?.getAttribute('data-host-sign-in') === 'login', 'the sign-in dialog');
    assert.deepEqual(m.typed, []);
    const cancel = Array.from(document.querySelectorAll('[data-host-sign-in] button')).find((b) => b.textContent === 'Cancel the sign-in');
    await m.click(cancel);
    await m.until(() => dialog() === null, 'the dialog closed');

    // Kept by Timon: who it is, no action, the way back in the menu.
    await m.render(page({ signedIn: true, host: view({ kept: true, identity: 'host@perso.example', signedIn: true }) }));
    await m.until(() => /Signed in with Timon as host@perso\.example/.test(computer()?.textContent ?? ''), 'the kept sign-in');
    assert.ok(!computer()!.querySelector('[data-host-sign-in-offer="login"]'));
    const trigger = computer()!.querySelector('button[data-row-menu]') as HTMLElement;
    await m.React.act(async () => {
      trigger.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    await m.until(() => Array.from(document.querySelectorAll('[role="menuitem"]')).some((i) => i.textContent === 'Use the terminal session instead'), 'the menu');
    const back = Array.from(document.querySelectorAll('[role="menuitem"]')).find((i) => i.textContent === 'Use the terminal session instead');
    await m.click(back);
    await m.until(() => forgets.length === 1 && refreshed > 0, 'Timon\'s folder forgotten and the page read again');

    // The long-lived token: minted in the app.
    await m.render(page({ signedIn: true, host: view({ signedIn: true }) }));
    await m.until(() => document.querySelector('[data-claude-token] [data-host-sign-in-offer="token"]') != null, 'the token\'s in-app action');
    assert.equal(document.querySelector('[data-claude-token] [data-host-sign-in-offer="token"]')!.textContent, 'Create');
    await m.click(document.querySelector('[data-claude-token] [data-host-sign-in-offer="token"]'));
    await m.until(() => dialog()?.getAttribute('data-host-sign-in') === 'token' && server.calls.includes('POST token'), 'the token flow');
  } finally {
    globalThis.fetch = own;
    await m.unmount();
  }
});

test('setup: a macOS service outside the session offers the long-lived token alone, and says why', async () => {
  const host = view({ browser: false, tokenOnly: true });
  const server: Server = { list: [cli({ host })], flows: {}, calls: [], codes: [] };
  const m = await mount(server);
  try {
    const { ProviderCliCards } = await import('./provider-cli-cards');
    await m.render(m.React.createElement(ProviderCliCards, { mode: 'onboarding' }));
    await m.until(() => offer('token') !== null, 'the token offer');
    assert.equal(offer('login'), null, 'no sign-in it could not read');
    assert.match(document.body.textContent ?? '', /outside your session/);
    await m.click(offer('token'));
    await m.until(() => dialog()?.getAttribute('data-host-sign-in') === 'token' && server.calls.includes('POST token'), 'the token flow');
    assert.deepEqual(m.typed, [], 'no command typed in a terminal');
  } finally {
    await m.unmount();
  }
});

test('the provider page: outside the session, this computer offers the token, and no sign-in in its menu', async () => {
  const { computerState } = await import('@/plugins-client/backends/provider-connection-section');
  assert.deepEqual(computerState(overview({ host: view({ browser: false, tokenOnly: true }) }).connection as never),
    { tone: 'action', key: 'hostSignIn.status.tokenOnly' });
  assert.deepEqual(computerState(overview({ signedIn: true, host: view({ browser: false, tokenOnly: true, token: { stored: true }, kept: true }) }).connection as never),
    { tone: 'ready', key: 'hostSignIn.status.tokenOnlySet' });

  const server: Server = { list: [], flows: {}, calls: [], codes: [] };
  const m = await mount(server);
  const own = globalThis.fetch;
  globalThis.fetch = (async (input: string, init?: { method?: string }) => {
    if (String(input) === '/api/ui/backends/accounts') return Response.json({ accounts: [], backends: ['claude'] });
    return own(input, init);
  }) as typeof fetch;
  try {
    const { ConnectionSection } = await import('@/plugins-client/backends/provider-connection-section');
    const { ProviderPageProvider } = await import('@/components/provider-page/provider-page-context');
    await m.render(m.React.createElement(ProviderPageProvider, {
      value: { provider: overview({ host: view({ browser: false, tokenOnly: true }) }) as never, status: 'not-connected', defaultBackend: null, refresh: async () => {}, back: () => {} },
    }, m.React.createElement(ConnectionSection)));
    const computer = () => document.querySelector('[data-connection="computer"]');
    await m.until(() => computer()?.querySelector('[data-host-sign-in-offer="token"]') != null, 'the token offer');
    assert.match(computer()!.textContent ?? '', /Outside your session: needs a long-lived token/);
    assert.ok(!computer()!.querySelector('[data-host-sign-in-offer="login"]'));
    const trigger = computer()!.querySelector('button[data-row-menu]') as HTMLElement;
    await m.React.act(async () => {
      trigger.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    await m.until(() => document.querySelectorAll('[role="menuitem"]').length > 0, 'the menu');
    const { t } = await import('@/lib/i18n');
    const items = Array.from(document.querySelectorAll('[role="menuitem"]')).map((i) => i.textContent);
    assert.deepEqual(items, [t('providerPage.connection.checkAgain')], 'neither a sign-in nor the terminal command');
    await m.click(computer()!.querySelector('[data-host-sign-in-offer="token"]'));
    await m.until(() => dialog()?.getAttribute('data-host-sign-in') === 'token' && server.calls.includes('POST token'), 'the token flow');
  } finally {
    globalThis.fetch = own;
    await m.unmount();
  }
});
