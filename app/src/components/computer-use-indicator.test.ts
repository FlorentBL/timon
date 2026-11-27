/**
 * The banner paints nothing while idle, and shows Stop (active) or Resume
 * (stopped) with the matching callback.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

test('the banner shows Stop while active, Resume once stopped, nothing when idle', async () => {
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
  const root = createRoot(document.getElementById('root')!);
  try {
    const { ComputerUseBanner } = await import('./computer-use-indicator');
    const calls: string[] = [];
    const render = (active: boolean, stopped: boolean) => React.act(async () => {
      root.render(React.createElement(ComputerUseBanner, {
        status: { active, stopped }, busy: false,
        onStop: () => calls.push('stop'), onResume: () => calls.push('resume'),
      }));
    });
    await render(false, false);
    assert.ok(!document.querySelector('[data-computer-use-banner]'));
    await render(true, false);
    const banner = document.querySelector('[data-computer-use-banner="active"]');
    assert.ok(banner);
    await React.act(async () => { banner.querySelector('button')!.click(); });
    await render(false, true);
    const stopped = document.querySelector('[data-computer-use-banner="stopped"]');
    assert.ok(stopped);
    await React.act(async () => { stopped.querySelector('button')!.click(); });
    assert.deepEqual(calls, ['stop', 'resume']);
  } finally {
    await React.act(async () => root.unmount());
    for (const [key, desc] of saved) {
      if (desc) Object.defineProperty(globalThis, key, desc); else delete (globalThis as Record<string, unknown>)[key];
    }
  }
});
