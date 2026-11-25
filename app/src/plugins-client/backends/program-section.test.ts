import assert from 'node:assert/strict';
import test from 'node:test';
import { waitUntil } from '@/lib/test-wait';
import { programState, shownAuthorization, type ProviderOverview, type ProviderProgramView } from '@/lib/provider-overview';

/**
 * The Program section of a provider page, mounted in the real `ProvidersSettings`: one path shown
 * (the one a launch runs, its link folded away), the official installer started in one click and
 * followed to its end, a path pinned under Advanced, and the security authorization in plain words
 * — for a third-party plugin only. The daemon's refusal of anyone but a superadmin signed in to the
 * app is covered by its own route tests (`provider-overview-routes`, `provider-cli-routes`,
 * `binaries-routes`).
 */

function program(over: Partial<ProviderProgramView> = {}): ProviderProgramView {
  return {
    name: 'acme-agent', path: '/usr/local/bin/acme-agent', linkTarget: null, pinned: false, pinKey: null, pin: null,
    version: '1.2.0', latest: null, updateAvailable: false, unsupportedVersion: false, bundled: false, installable: false,
    installCommand: null, installDocs: null, authorization: null, refusedReason: null, ...over,
  };
}

function provider(id: string, name: string, origin: ProviderOverview['origin'], programs: ProviderProgramView[]): ProviderOverview {
  return {
    id, name, brand: null, icon: null, origin, pluginId: origin === 'user' ? null : id,
    plugin: origin === 'plugin' ? { id, label: name, version: '3.1.0', state: 'active', reason: null, signed: true, builtin: false } : null,
    catalogAgent: null, enabled: true, isDefault: false,
    backends: [{ id, label: name, active: true, disabled: false, reason: null, modelCount: 1, defaultModel: null, isDefault: false, remote: false }],
    modelCount: 1, agentCount: 0,
    connection: { signedIn: null, signInCommand: null, signInThen: null, acceptsAccounts: false, accounts: [] },
    secret: { required: false, present: false, names: [] },
    programs, status: 'available', updateAvailable: false,
  };
}

test('a program state reads the path a launch runs before its version', () => {
  assert.equal(programState(program()), 'installed');
  assert.equal(programState(program({ path: null })), 'missing');
  assert.equal(programState(program({ path: null, pin: '/gone/acme-agent' })), 'brokenPin');
  assert.equal(programState(program({ updateAvailable: true })), 'update');
  assert.equal(programState(program({ updateAvailable: true, unsupportedVersion: true })), 'unsupported');
});

test('only a third-party plugin shows an authorization, whatever a daemon answers for a shipped one', () => {
  const refused = program({ authorization: 'refused', refusedReason: '`claude` is never executable by a plugin' });
  assert.equal(shownAuthorization({ origin: 'built-in' }, refused), null);
  assert.equal(shownAuthorization({ origin: 'user' }, refused), null);
  assert.equal(shownAuthorization({ origin: 'catalog' }, refused), null);
  assert.equal(shownAuthorization({ origin: 'plugin' }, refused), 'refused');
});

test('the Program section paints the daemon\'s program and drives its installer and its pinned path', async (suite) => {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/?settings=models%2Fbackends', pretendToBeVisual: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  install('window', dom.window);
  install('self', dom.window);
  for (const key of ['document', 'navigator', 'HTMLElement', 'HTMLButtonElement', 'Element', 'Node', 'DocumentFragment', 'MutationObserver', 'NodeFilter', 'HTMLInputElement', 'HTMLDetailsElement', 'SVGElement', 'Event', 'CustomEvent', 'FocusEvent', 'MouseEvent', 'KeyboardEvent', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame']) {
    install(key, (dom.window as unknown as Record<string, unknown>)[key]);
  }
  install('IS_REACT_ACT_ENVIRONMENT', true);

  // What the daemon says, changed by the gestures below.
  let claude = program({
    name: 'claude', path: '/home/u/.local/bin/claude', linkTarget: '/home/u/.local/share/claude/versions/2.0.14',
    pinKey: 'claude', version: '2.0.14', authorization: 'refused', refusedReason: '`claude` is never executable by a plugin',
  });
  let codex = program({ name: 'codex', path: null, pinKey: 'codex', version: null, installable: true, installCommand: 'npm i -g @openai/codex' });
  const intruder = program({ name: 'bash', path: '/usr/bin/bash', authorization: 'refused', refusedReason: '`bash` is never executable by a plugin' });
  const overview = () => ({
    providers: [
      provider('provider-claude', 'Claude', 'built-in', [claude]),
      provider('provider-codex', 'Codex', 'built-in', [codex]),
      provider('acme', 'Acme agent', 'plugin', [intruder]),
    ],
    defaultBackend: null,
  });

  let installPolls = 0;
  let refusePin: string | null = null;
  let overviewReads = 0;
  const requests: { method: string; url: string; body: unknown }[] = [];
  install('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    // The superadmin: the whole page (`lib/provider-access.ts`).
    if (url === '/api/ui/auth/me') return Response.json({ user: { id: 'u-admin', is_superadmin: true }, can: {} });
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) as unknown : undefined;
    requests.push({ method, url, body });
    if (url === '/api/ui/providers/overview') {
      overviewReads += 1;
      return Response.json(overview());
    }
    const job = (state: 'running' | 'succeeded') => ({
      name: 'codex', command: 'npm i -g @openai/codex', state, startedAt: 1, finishedAt: state === 'running' ? null : 2,
      lines: ['added 1 package'], dropped: 0, result: state === 'running' ? null : { ok: true, command: null, reason: null },
    });
    if (url === '/api/ui/backends/provider-clis/codex/install') {
      if (method === 'POST') return Response.json({ job: job('running') });
      if (installPolls === 0 && !requests.some((r) => r.method === 'POST' && r.url === url)) {
        return Response.json({ error: 'not-found' }, { status: 404 });
      }
      installPolls += 1;
      if (installPolls < 2) return Response.json({ job: job('running') });
      codex = { ...codex, path: '/home/u/.local/bin/codex', version: '0.50.0' };
      return Response.json({ job: job('succeeded') });
    }
    if (url === '/api/ui/backends/binaries/claude') {
      if (method === 'PUT') {
        if (refusePin) return Response.json({ error: refusePin, message: 'daemon text' }, { status: 400 });
        const path = (body as { path: string }).path;
        claude = { ...claude, path, linkTarget: null, pinned: true, pin: path };
      } else {
        claude = { ...claude, path: '/home/u/.local/bin/claude', pinned: false, pin: null };
      }
      return Response.json({ binaries: [] });
    }
    return Response.json({});
  });

  const React = await import('react');
  install('React', React);
  const { createRoot } = await import('react-dom/client');
  const { SearchParamsContext } = await import('next/dist/shared/lib/hooks-client-context.shared-runtime');
  const { AppRouterContext } = await import('next/dist/shared/lib/app-router-context.shared-runtime');
  const { setLocale, getLocale } = await import('@/lib/i18n');
  const previousLocale = getLocale();
  setLocale('en');
  const slots = await import('@/lib/plugin-host/slots');
  slots.resetSlotsForTests();
  slots.declareSlot('settings.provider.section', 'list');
  const { coreBackendsClient } = await import('@/plugins-client/backends');
  coreBackendsClient.apply({
    id: '@timon/backends',
    realtime: { subscribe: () => () => {} } as never,
    caps: null,
    zoneVisible: () => true,
    options: {},
    register: (options, Component) => (options.slot === 'settings.provider.section'
      ? slots.register({ ...options, pluginId: '@timon/backends' }, Component)
      : () => {}),
    onDispose: () => {},
  });
  const { ProvidersSettings } = await import('./providers-settings');

  const router = { push: () => {}, replace: () => {}, back: () => {}, forward: () => {}, refresh: () => {}, prefetch: () => {} };
  const root = createRoot(document.getElementById('root')!);
  const render = (id: string) => React.act(async () => {
    root.render(React.createElement(AppRouterContext.Provider, { value: router as never },
      React.createElement(SearchParamsContext.Provider, { value: new URLSearchParams(`settings=models%2Fbackends&provider=${id}`) as never },
        React.createElement(ProvidersSettings))));
  });
  const until = (condition: () => boolean, what: string) => waitUntil(React.act, condition, what);
  const section = () => document.querySelector('[data-provider-section="program"]');
  const text = () => section()?.textContent ?? '';
  const button = (label: RegExp) => Array.from(section()?.querySelectorAll('button') ?? []).find((b) => label.test(b.textContent ?? ''));
  const click = (el: HTMLElement) => React.act(async () => { el.click(); });
  // A row's "…" menu: opened from the keyboard (jsdom has no pointer events), then one item chosen.
  const choose = async (row: Element, item: string) => {
    const trigger = row.querySelector<HTMLElement>('button[data-row-menu]')!;
    await React.act(async () => { trigger.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
    await until(() => document.querySelector('[role="menu"]') !== null, 'the row menu');
    const entry = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).find((el) => el.textContent === item);
    assert.ok(entry, `menu item ${item}`);
    await React.act(async () => { entry.click(); });
    await until(() => document.querySelector('[role="menu"]') === null, 'the menu closed');
  };
  const type = async (field: HTMLInputElement, value: string) => {
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!;
    await React.act(async () => {
      setter.call(field, value);
      field.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    });
  };

  try {
    await suite.test('a provider shipped in the release: one path, its link folded away, no authorization', async () => {
      await render('provider-claude');
      await until(() => text().includes('v2.0.14'), 'the Program section');
      assert.ok(!section()!.querySelector('[data-program-path]'), 'the path waits under Advanced');
      await choose(section()!.querySelector('[data-program="claude"]')!, 'Advanced settings');
      await until(() => section()?.querySelector('[data-program-advanced]') != null, 'Advanced unfolded');
      assert.equal(section()!.querySelectorAll('[data-program-path]').length, 1, 'one path shown');
      assert.equal(section()!.querySelector('[data-program-path]')!.textContent, '/home/u/.local/bin/claude');
      const link = section()!.querySelector('[data-program-link]')!;
      assert.ok(link.closest('details'), 'the link\'s target sits in a folded detail');
      assert.match(link.textContent!, /versions\/2\.0\.14/);
      assert.ok(!section()!.querySelector('[data-program-authorization]'), 'no authorization for a shipped provider');
      assert.doesNotMatch(text(), /Blocked|never/);
      assert.equal(section()!.querySelector('[data-program-state]')!.getAttribute('data-program-state'), 'installed');
    });

    await suite.test('a third party whose program is refused reads as blocked, with why', async () => {
      await render('acme');
      await until(() => section()?.querySelector('[data-program-authorization]') !== null, 'the authorization block');
      const block = section()!.querySelector('[data-program-authorization]')!;
      assert.equal(block.getAttribute('data-program-authorization'), 'refused');
      assert.match(block.textContent!, /Blocked: this program cannot be run by a plugin/);
      assert.match(block.textContent!, /No authorization can unblock it/);
      assert.equal(button(/Review and authorize/), undefined, 'nothing to review for a refused program');
      assert.match(text(), /Brought by the plugin Acme agent, version 3\.1\.0/);
    });

    await suite.test('a missing program installs in one click, followed to its end, then the provider is read again', async () => {
      await render('provider-codex');
      await until(() => button(/^Install$/) !== undefined, 'the Install button');
      assert.match(section()!.querySelector('[data-program-state]')!.textContent!, /Not found on this computer/);
      const readsBefore = overviewReads;
      await click(button(/^Install$/)!);
      assert.ok(requests.some((r) => r.method === 'POST' && r.url === '/api/ui/backends/provider-clis/codex/install'));
      await until(() => text().includes('added 1 package'), 'the installer\'s console');
      await until(() => overviewReads > readsBefore && text().includes('v0.50.0'), 'the provider read again once installed');
      assert.equal(button(/^Install$/), undefined);
    });

    await suite.test('a path pinned under Advanced: a refusal is a sentence of the locale, a save is trimmed', async () => {
      await render('provider-claude');
      await until(() => section()?.querySelector('[data-program="claude"]') != null, 'the Claude program row');
      await choose(section()!.querySelector('[data-program="claude"]')!, 'Advanced settings');
      await until(() => document.getElementById('program-pin-claude') !== null, 'the pinned path field');
      const field = document.getElementById('program-pin-claude') as HTMLInputElement;
      assert.ok(field.closest('[data-program-advanced]'), 'under Advanced');
      // #1101: the field names the program it wants, its example included — never another provider's.
      assert.match(text(), /Path to the claude CLI/);
      assert.match(field.placeholder, /\/usr\/local\/bin\/claude$/);

      refusePin = 'wrong_program';
      await type(field, '/usr/local/bin/ollama');
      await click(button(/Save path/)!);
      await until(() => section()?.querySelector('[role="alert"]') !== null, 'the wrong program refusal');
      assert.equal(section()!.querySelector('[role="alert"]')!.textContent, 'This file is not the claude CLI.');

      refusePin = 'path_not_executable';
      await type(field, '/secret/place/claude');
      await click(button(/Save path/)!);
      await until(() => section()?.querySelector('[role="alert"]') !== null, 'the refusal');
      assert.match(section()!.querySelector('[role="alert"]')!.textContent!, /not executable/);
      assert.doesNotMatch(section()!.querySelector('[role="alert"]')!.textContent!, /daemon text|secret/);

      refusePin = null;
      await type(document.getElementById('program-pin-claude') as HTMLInputElement, '  /opt/claude/bin/claude  ');
      await click(button(/Save path/)!);
      await until(() => section()?.querySelector('[data-program-path]')?.textContent === '/opt/claude/bin/claude', 'the pinned path shown as run');
      assert.deepEqual(requests.filter((r) => r.method === 'PUT').at(-1)!.body, { path: '/opt/claude/bin/claude' });

      await click(button(/Remove pin/)!);
      await until(() => section()?.querySelector('[data-program-path]')?.textContent === '/home/u/.local/bin/claude', 'back to the path found');
      assert.equal(requests.filter((r) => r.method === 'DELETE').at(-1)!.url, '/api/ui/backends/binaries/claude');
    });
  } finally {
    await React.act(async () => { root.unmount(); });
    await React.act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
    slots.resetSlotsForTests();
    setLocale(previousLocale);
    dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
  }
});
