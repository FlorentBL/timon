/**
 * The glass tuning card, mounted in a real DOM: one row per zone showing its
 * value, sliders only after "Adjust"; a zone follows the general tuning until
 * its switch says otherwise, and a drag goes through the preview while a
 * reset writes at once.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { NativeAppearance } from './ui-theme-variants';

async function mount(native: Partial<NativeAppearance>, disabled = false) {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true });
  const install = (key: string, value: unknown) => {
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Element', 'Node', 'Event', 'MouseEvent', 'PointerEvent', 'KeyboardEvent', 'FocusEvent'] as const) {
    install(key, (dom.window as unknown as Record<string, unknown>)[key]);
  }
  install('IS_REACT_ACT_ENVIRONMENT', true);
  install('getComputedStyle', dom.window.getComputedStyle.bind(dom.window));
  install('requestAnimationFrame', dom.window.requestAnimationFrame.bind(dom.window));
  install('cancelAnimationFrame', dom.window.cancelAnimationFrame.bind(dom.window));
  const React = await import('react');
  // The UI kit compiles to classic `React.createElement`.
  install('React', React);
  const { createRoot } = await import('react-dom/client');
  const { DEFAULT_APPEARANCE } = await import('./ui-theme-variants');
  const { GlassTuningSettings } = await import('./ui-theme-glass-tuning');
  const previews: Partial<NativeAppearance>[] = [];
  const resets: Partial<NativeAppearance>[] = [];
  const root = createRoot(document.getElementById('root')!);
  await React.act(async () => {
    root.render(React.createElement(GlassTuningSettings, {
      native: { ...DEFAULT_APPEARANCE, glass: true, ...native },
      disabled,
      scheme: 'dark',
      onPreview: (patch: Partial<NativeAppearance>) => { previews.push(patch); },
      onReset: (patch: Partial<NativeAppearance>) => { resets.push(patch); },
    }));
  });
  const openRow = async (id: string) => {
    const button = document.querySelector<HTMLButtonElement>(`[data-glass-adjust="${id}"]`)!;
    await React.act(async () => { button.click(); });
  };
  const status = (id: string) => document.querySelector<HTMLElement>(`[data-glass-zone="${id}"]`)!.textContent ?? '';
  const drag = async (input: HTMLInputElement, value: string) => {
    await React.act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input, value);
      input.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
  };
  return { React, root, previews, resets, openRow, status, drag };
}

test('the card shows each zone and its value, with no slider until a row is adjusted', async () => {
  const s = await mount({ glassBlur: 20, glassTransparency: 30, glassZones: { islands: { blur: 4, transparency: 10, tint: '#336699' } } });
  for (const id of ['general', 'chrome', 'islands', 'widgets', 'bubbles', 'floor']) {
    assert.ok(document.querySelector(`[data-glass-zone="${id}"]`), `row ${id}`);
  }
  assert.equal(document.querySelectorAll('input[type="range"]').length, 0, 'no editing grid by default');
  assert.match(s.status('general'), /20 px.*30 %/);
  assert.match(s.status('chrome'), /Follows General/);
  assert.match(s.status('islands'), /4 px.*10 %/);
  assert.ok(document.querySelector('[data-glass-zone="islands"][data-glass-own]'), 'a zone tuned apart is marked');
  assert.match(s.status('floor'), /Off/);
  await s.openRow('chrome');
  assert.ok(document.querySelector('#glass-chrome-blur'));
  await s.openRow('islands');
  assert.equal(document.querySelector('#glass-chrome-blur'), null, 'one row open at a time');
  assert.ok(document.querySelector('#glass-islands-blur'));
  await s.openRow('islands');
  assert.equal(document.querySelectorAll('input[type="range"]').length, 0, 'adjust again folds the row');
  await s.React.act(async () => { s.root.unmount(); });
});

test('a disabled card cannot be unfolded', async () => {
  const s = await mount({}, true);
  const button = document.querySelector<HTMLButtonElement>('[data-glass-adjust="general"]')!;
  assert.equal(button.disabled, true);
  await s.React.act(async () => { s.root.unmount(); });
});

test('the general row drives the general fields through the preview', async () => {
  const s = await mount({});
  await s.openRow('general');
  await s.drag(document.querySelector<HTMLInputElement>('#glass-general-blur')!, '24');
  assert.deepEqual(s.previews.at(-1), { glassBlur: 24 });
  await s.React.act(async () => { s.root.unmount(); });
});

test('a zone follows the general tuning until its switch turns off, then keeps its own', async () => {
  const s = await mount({ glassBlur: 12 });
  await s.openRow('chrome');
  const blur = document.querySelector<HTMLInputElement>('#glass-chrome-blur')!;
  assert.equal(blur.value, '12', 'shows the general value it follows');
  assert.equal(blur.disabled, true, 'locked while it follows');
  const follow = document.querySelector<HTMLElement>('[data-glass-zone] [role="switch"]')!;
  assert.equal(follow.getAttribute('aria-checked'), 'true');
  await s.React.act(async () => { follow.click(); });
  assert.deepEqual(s.resets.at(-1), { glassZones: { chrome: { blur: 12, transparency: 40, tint: null } } }, 'starts from a copy of the general tuning');
  await s.React.act(async () => { s.root.unmount(); });
});

test('a zone tuned apart previews its own fields and goes back to following', async () => {
  const s = await mount({ glassZones: { islands: { blur: 4, transparency: 10, tint: null } } });
  await s.openRow('islands');
  await s.drag(document.querySelector<HTMLInputElement>('#glass-islands-transparency')!, '70');
  assert.deepEqual(s.previews.at(-1), { glassZones: { islands: { blur: 4, transparency: 70, tint: null } } });
  const follow = document.querySelector<HTMLElement>('[data-glass-zone] [role="switch"]')!;
  await s.React.act(async () => { follow.click(); });
  assert.deepEqual(s.resets.at(-1), { glassZones: {} });
  await s.React.act(async () => { s.root.unmount(); });
});

test('the readability floor is a slider of its own', async () => {
  const s = await mount({});
  await s.openRow('floor');
  await s.drag(document.querySelector<HTMLInputElement>('#glass-floor')!, '55');
  assert.deepEqual(s.previews.at(-1), { glassFloor: 55 });
  await s.React.act(async () => { s.root.unmount(); });
});
