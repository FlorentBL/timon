/**
 * The setup card lists each prerequisite with ✅/❌, offers Allow and the exact
 * Settings path on macOS, the install commands on Linux, and stops polling once complete.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { ComputerSetup } from '@/lib/computer-use';

async function withDom<T>(run: (ctx: { React: typeof import('react'); root: import('react-dom/client').Root; doc: Document }) => Promise<T>): Promise<T> {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/' });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    if (!saved.has(key)) saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Node', 'Event', 'MouseEvent']) {
    install(key, key === 'window' ? dom.window : (dom.window as unknown as Record<string, unknown>)[key]);
  }
  install('self', dom.window);
  install('IS_REACT_ACT_ENVIRONMENT', true);
  const React = await import('react');
  install('React', React);
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(dom.window.document.getElementById('root')!);
  try {
    return await run({ React, root, doc: dom.window.document });
  } finally {
    await React.act(async () => root.unmount());
    for (const [key, desc] of saved) {
      if (desc) Object.defineProperty(globalThis, key, desc); else delete (globalThis as Record<string, unknown>)[key];
    }
  }
}

const mac = (checks: ComputerSetup['checks'], extra: Partial<ComputerSetup> = {}): ComputerSetup =>
  ({ reachable: true, platform: 'darwin', available: false, needsRestart: false, checks, ...extra });

test('setupIncomplete drives the polling: only a complete setup stops it', async () => {
  const { setupIncomplete } = await import('./computer-use-setup');
  assert.equal(setupIncomplete(mac({ desktop: 'ok', screen: 'ok', accessibility: 'ok', inputTool: 'ok' }, { available: true })), false);
  assert.equal(setupIncomplete(mac({ desktop: 'ok', screen: 'missing' })), true);
  // The accessibility tree is optional: polling goes on for a missing one, not for an unsupported one.
  assert.equal(setupIncomplete(mac({ desktop: 'ok', screen: 'ok', accessibility: 'ok', inputTool: 'ok', a11y: 'unsupported' }, { available: true })), false);
  assert.equal(setupIncomplete(mac({ desktop: 'ok', screen: 'ok', accessibility: 'ok', inputTool: 'ok', a11y: 'missing' }, { available: true })), true);
  assert.equal(setupIncomplete(mac({ desktop: 'ok', screen: 'ok' }, { needsRestart: true })), true);
  assert.equal(setupIncomplete({ reachable: false, platform: '', available: false, checks: { desktop: 'missing' }, needsRestart: false }), true);
});

test('macOS: a line per grant, Allow, the Settings path, and Restart once required', async () => {
  await withDom(async ({ React, root, doc }) => {
    const { ComputerUseSetupView } = await import('./computer-use-setup');
    const calls: string[] = [];
    const render = (setup: ComputerSetup) => React.act(async () => {
      root.render(React.createElement(ComputerUseSetupView, { setup, busy: false, onAllow: () => calls.push('allow'), onRestart: () => calls.push('restart') }));
    });
    await render(mac({ desktop: 'ok', accessibility: 'missing', screen: 'missing', inputTool: 'ok' }));
    const states = Array.from(doc.querySelectorAll('[data-computer-check-state]')).map((li) => li.getAttribute('data-computer-check-state'));
    assert.deepEqual(states, ['ok', 'missing', 'missing', 'ok']);
    const text = doc.body.textContent ?? '';
    assert.match(text, /Privacy & Security › Accessibility/);
    assert.match(text, /Privacy & Security › Screen Recording/);
    await React.act(async () => { (doc.querySelector('[data-computer-use-allow]') as HTMLElement).click(); });
    assert.deepEqual(calls, ['allow']);
    assert.ok(!doc.querySelector('[data-computer-use-restart]'));
    await render(mac({ desktop: 'ok', accessibility: 'ok', screen: 'ok', inputTool: 'ok' }, { needsRestart: true }));
    assert.ok(!doc.querySelector('[data-computer-use-allow]'));
    await React.act(async () => { doc.querySelector('[data-computer-use-restart] button')!.dispatchEvent(new (doc.defaultView as unknown as { MouseEvent: typeof MouseEvent }).MouseEvent('click', { bubbles: true })); });
    assert.deepEqual(calls, ['allow', 'restart']);
    await render(mac({ desktop: 'ok', accessibility: 'ok', screen: 'ok', inputTool: 'ok' }, { available: true }));
    assert.ok(doc.querySelector('[data-computer-use-ready]'));
  });
});

test('Linux: install commands without xdotool, X11 message under Wayland, no Allow button', async () => {
  await withDom(async ({ React, root, doc }) => {
    const { ComputerUseSetupView } = await import('./computer-use-setup');
    const render = (checks: ComputerSetup['checks']) => React.act(async () => {
      root.render(React.createElement(ComputerUseSetupView, {
        setup: { reachable: true, platform: 'linux', available: false, needsRestart: false, checks }, busy: false, onAllow: () => {}, onRestart: () => {},
      }));
    });
    await render({ desktop: 'ok', session: 'ok', inputTool: 'missing' });
    const text = doc.body.textContent ?? '';
    for (const command of ['sudo apt install xdotool', 'sudo dnf install xdotool', 'sudo pacman -S xdotool']) assert.ok(text.includes(command), command);
    assert.ok(!doc.querySelector('[data-computer-use-allow]'));
    await render({ desktop: 'ok', session: 'unsupported', inputTool: 'missing' });
    assert.match(doc.body.textContent ?? '', /X11 session is required/);
  });
});

test('desktop not reachable: the only line is the desktop one, with its instruction', async () => {
  await withDom(async ({ React, root, doc }) => {
    const { ComputerUseSetupView } = await import('./computer-use-setup');
    await React.act(async () => {
      root.render(React.createElement(ComputerUseSetupView, {
        setup: { reachable: false, platform: '', available: false, needsRestart: false, checks: { desktop: 'missing' } }, busy: false, onAllow: () => {}, onRestart: () => {},
      }));
    });
    assert.equal(doc.querySelectorAll('[data-computer-check-state]').length, 1);
    assert.match(doc.body.textContent ?? '', /Open the Timon desktop app/);
  });
});

test('the journal lists time, action and result, shows refusals, and refreshes on demand', async () => {
  await withDom(async ({ React, root, doc }) => {
    const { ComputerJournalView } = await import('./computer-use-setup');
    let refreshed = 0;
    const render = (entries: Parameters<typeof ComputerJournalView>[0]['entries']) => React.act(async () => {
      root.render(React.createElement(ComputerJournalView, { entries, onRefresh: () => { refreshed += 1; } }));
    });
    await render([
      { id: 2, at: Date.now(), command: 'click', args: { x: 1, y: 2 }, result: 'ok', duration_ms: 5 },
      { id: 1, at: Date.now(), command: 'move', args: {}, result: 'computer_stopped', duration_ms: 1 },
    ]);
    const rows = Array.from(doc.querySelectorAll('[data-computer-journal-row]')).map((row) => row.textContent ?? '');
    assert.equal(rows.length, 2);
    assert.match(rows[0] ?? '', /click/);
    assert.match(rows[1] ?? '', /computer_stopped/);
    await React.act(async () => { (doc.querySelector('[data-computer-journal-refresh]') as HTMLElement).click(); });
    assert.equal(refreshed, 1);
    await render([]);
    assert.ok(doc.querySelector('[data-computer-journal-empty]'));
    assert.ok(!doc.querySelector('[data-computer-journal-row]'));
  });
});

test('allowed applications: an empty list warns, windows are offered once and added on click, an entry is removed', async () => {
  await withDom(async ({ React, root, doc }) => {
    const { ComputerUseApps, appsToOffer } = await import('./computer-use-apps');
    assert.deepEqual(appsToOffer([{ app: 'Notepad' }, { app: 'notepad' }, { app: 'Calc' }, { app: ' ' }], ['calc']), ['Notepad']);
    let values: string[] = [];
    let loads = 0;
    const load = async () => { loads += 1; return [{ id: '1', title: 'a', app: 'TextEdit', focused: true }, { id: '2', title: 'b', app: 'Mail', focused: false }]; };
    const render = () => React.act(async () => { root.render(React.createElement(ComputerUseApps, { values, onChange: (next: string[]) => { values = next; }, load })); });
    await render();
    assert.ok(doc.querySelector('[data-computer-use-apps-empty]'), 'an empty list says the agent can do nothing');
    assert.match(doc.body.textContent ?? '', /cannot do anything with the keyboard or the mouse/);
    await React.act(async () => { (doc.querySelector('[data-computer-use-apps-load]') as HTMLElement).click(); });
    assert.equal(loads, 1);
    assert.deepEqual(Array.from(doc.querySelectorAll('[data-computer-app-offer]')).map((b) => b.textContent), ['TextEdit', 'Mail']);
    await React.act(async () => { (doc.querySelector('[data-computer-app-offer]') as HTMLElement).click(); });
    assert.deepEqual(values, ['TextEdit']);
    await render();
    assert.ok(!doc.querySelector('[data-computer-use-apps-empty]'));
    assert.equal(doc.querySelectorAll('[data-computer-app]').length, 1);
    await React.act(async () => { (doc.querySelector('[data-computer-app] button') as HTMLElement).click(); });
    assert.deepEqual(values, []);
  });
});

test('allowed applications: no window to offer says so', async () => {
  await withDom(async ({ React, root, doc }) => {
    const { ComputerUseApps } = await import('./computer-use-apps');
    await React.act(async () => { root.render(React.createElement(ComputerUseApps, { values: ['Mail'], onChange: () => {}, load: async () => null })); });
    await React.act(async () => { (doc.querySelector('[data-computer-use-apps-load]') as HTMLElement).click(); });
    assert.match(doc.querySelector('[data-computer-use-apps-none]')?.textContent ?? '', /Timon desktop app/);
  });
});

test('the accessibility line explains what is missing, per system, and stays optional', async () => {
  await withDom(async ({ React, root, doc }) => {
    const { ComputerUseSetupView } = await import('./computer-use-setup');
    const render = (platform: string, checks: ComputerSetup['checks']) => React.act(async () => {
      root.render(React.createElement(ComputerUseSetupView, {
        setup: { reachable: true, platform, available: true, needsRestart: false, checks }, busy: false, onAllow: () => {}, onRestart: () => {},
      }));
    });
    await render('darwin', { desktop: 'ok', accessibility: 'ok', screen: 'ok', inputTool: 'ok', a11y: 'missing' });
    let text = doc.body.textContent ?? '';
    assert.match(text, /Accessibility tree/);
    assert.match(text, /without it the agent works from screenshots only/);
    assert.match(text, /Privacy & Security › Accessibility/);
    await render('linux', { desktop: 'ok', session: 'ok', inputTool: 'ok', a11y: 'missing' });
    assert.match(doc.body.textContent ?? '', /toolkit-accessibility true/);
    await render('win32', { desktop: 'ok', a11y: 'unsupported' });
    text = doc.body.textContent ?? '';
    assert.match(text, /Not available on this system for now/);
    assert.ok(doc.querySelector('[data-computer-use-ready]'), 'the setup stays ready without the tree');
    await render('linux', { desktop: 'ok', session: 'ok', inputTool: 'ok', a11y: 'ok' });
    assert.doesNotMatch(doc.body.textContent ?? '', /works from screenshots/);
  });
});
