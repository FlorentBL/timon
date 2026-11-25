/**
 * A project's window, split as a replaceable dialog: the host
 * (`ProjectEditDialog`, opened by the agents grid, a project's card and the
 * chat's project menu) reads the record and keeps the calls to the daemon;
 * the product's window paints from `useProjectEditDialog()`. The slot name
 * `project.edit.dialog` is reserved, not declared: no plugin can claim it
 * before the client API that publishes it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

type Call = { url: string; method: string; body: unknown };

const ACME = { slug: 'acme', name: 'Acme', color: '#112233', icon: '', workspace: 'work', cwd: '/srv/acme', speech: '' };

async function mount(slug: string | null, opts: { agentsLeft?: string[] } = {}) {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  install('window', dom.window);
  install('self', dom.window);
  for (const key of ['document', 'navigator', 'HTMLElement', 'HTMLButtonElement', 'HTMLSelectElement', 'Element', 'Node',
    'DocumentFragment', 'MutationObserver', 'NodeFilter', 'HTMLInputElement', 'HTMLTextAreaElement', 'SVGElement', 'Event',
    'CustomEvent', 'FocusEvent', 'MouseEvent', 'PointerEvent', 'KeyboardEvent', 'getComputedStyle', 'localStorage']) {
    install(key, (dom.window as unknown as Record<string, unknown>)[key]);
  }
  install('requestAnimationFrame', dom.window.requestAnimationFrame.bind(dom.window));
  install('cancelAnimationFrame', dom.window.cancelAnimationFrame.bind(dom.window));
  install('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  install('IS_REACT_ACT_ENVIRONMENT', true);

  const calls: Call[] = [];
  let agentsLeft = opts.agentsLeft ?? [];
  install('fetch', async (input: string, init: RequestInit = {}) => {
    const url = String(input);
    const method = init.method ?? 'GET';
    calls.push({ url, method, body: init.body ? JSON.parse(String(init.body)) as unknown : null });
    if (url === '/api/ui/projects' && method === 'GET') {
      return Response.json({ projects: [ACME, { slug: 'beta', name: 'Beta' }] });
    }
    if (url === '/api/ui/projects' && method === 'POST') return Response.json({ ok: true });
    if (url === '/api/ui/projects/acme/meta' && method === 'PUT') return Response.json({ ok: true });
    if (url.startsWith('/api/ui/projects/acme') && method === 'DELETE') {
      if (agentsLeft.length && !url.includes('?agents=')) return Response.json({ agents: agentsLeft }, { status: 409 });
      agentsLeft = [];
      return Response.json({ ok: true });
    }
    return Response.json({ error: 'not_found' }, { status: 404 });
  });

  const React = await import('react');
  install('React', React);
  const { createRoot } = await import('react-dom/client');
  const { setLocale, getLocale } = await import('@/lib/i18n');
  const previousLocale = getLocale();
  setLocale('en');
  const { answerConfirmsForTests } = await import('./confirm-dialog/confirm-dialog-context');
  answerConfirmsForTests(() => true);
  const { ProjectEditDialog } = await import('./project-edit-dialog');
  const events: string[] = [];
  const root = createRoot(document.getElementById('root')!);
  const settle = async () => {
    for (let i = 0; i < 8; i += 1) await React.act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  };
  await React.act(async () => {
    root.render(React.createElement(ProjectEditDialog, {
      slug, onSaved: () => events.push('saved'), onClose: () => events.push('closed'),
    }));
  });
  await settle();
  const byText = (text: string) => Array.from(dom.window.document.querySelectorAll('button')).find((b) => b.textContent?.trim() === text) ?? null;
  const click = async (el: Element | null) => {
    assert.ok(el);
    await React.act(async () => { (el as HTMLElement).dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
    await settle();
  };
  const unmount = async () => {
    await React.act(async () => { root.unmount(); });
    // The dialog's focus scope hands the focus back on a timer after unmounting:
    // let it run while the window's globals are still installed.
    await new Promise((r) => setTimeout(r, 10));
    answerConfirmsForTests(null);
    setLocale(previousLocale);
    dom.window.close();
    for (const [k, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, k, descriptor);
      else delete (globalThis as Record<string, unknown>)[k];
    }
  };
  return { document: dom.window.document, calls, events, byText, click, unmount };
}

test('project.edit.dialog is reserved, not declared: no plugin claims it before its client API', async () => {
  const { PROJECT_EDIT_DIALOG_SLOT, resetSlotsForTests, slotKind } = await import('@/lib/plugin-host/slots');
  const { clientContext } = await import('@/lib/plugin-host/loader');
  assert.equal(PROJECT_EDIT_DIALOG_SLOT, 'project.edit.dialog');
  resetSlotsForTests();
  assert.equal(slotKind(PROJECT_EDIT_DIALOG_SLOT), null);
  const plugin = clientContext('acme-window', [PROJECT_EDIT_DIALOG_SLOT]);
  assert.throws(() => plugin.slots.register({ slot: PROJECT_EDIT_DIALOG_SLOT }, () => null), /not declared/);
});

test('the host reads the record and the product window paints it from the context', async () => {
  const view = await mount('acme');
  try {
    const name = view.document.querySelector('input[value="Acme"]');
    assert.ok(name, 'the name, from the record the host read');
    assert.ok(view.document.querySelector('input[value="/srv/acme"]'), 'the working directory');
    assert.match(view.document.body.textContent ?? '', /acme/);
  } finally {
    await view.unmount();
  }
});

test('save goes through the host: one write, then the caller is told and the window closes', async () => {
  const view = await mount('acme');
  try {
    await view.click(view.byText('Save'));
    const put = view.calls.filter((c) => c.method === 'PUT');
    assert.equal(put.length, 1);
    assert.equal(put[0]?.url, '/api/ui/projects/acme/meta');
    assert.deepEqual(put[0]?.body, { slug: 'acme', name: 'Acme', color: '#112233', workspace: 'work', cwd: '/srv/acme' });
    assert.deepEqual(view.events, ['saved', 'closed']);
  } finally {
    await view.unmount();
  }
});

test('a deletion refused for the agents left asks their fate, then deletes with it', async () => {
  const view = await mount('acme', { agentsLeft: ['acme.coder', 'acme.reviewer'] });
  try {
    await view.click(view.byText('Delete'));
    assert.deepEqual(view.events, [], 'nothing closes on the refusal');
    assert.match(view.document.body.textContent ?? '', /acme\.coder, acme\.reviewer/);
    const select = view.document.querySelector('select');
    assert.ok(select, 'move is preselected, towards another project');
    assert.equal((select as HTMLSelectElement).value, 'beta');
    await view.click(view.byText('Delete the project'));
    const deletes = view.calls.filter((c) => c.method === 'DELETE').map((c) => c.url);
    assert.deepEqual(deletes, ['/api/ui/projects/acme', '/api/ui/projects/acme?agents=move&to=beta']);
    assert.deepEqual(view.events, ['saved', 'closed']);
  } finally {
    await view.unmount();
  }
});

test('creation: no record is read and no deletion is offered', async () => {
  const view = await mount(null);
  try {
    assert.equal(view.byText('Delete'), null);
    assert.ok(!view.calls.some((c) => c.url === '/api/ui/projects' && c.method === 'GET'));
    // The slug field takes the focus a beat after opening: let it, before the window goes.
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(view.document.activeElement?.tagName, 'INPUT');
  } finally {
    await view.unmount();
  }
});
