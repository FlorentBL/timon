// french-ok-file: the localised menu labels under test
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { MenuItemConstructorOptions } from 'electron';
import { contextMenuTemplate, type ContextMenuInput, type ContextMenuTarget } from './context-menu.js';
import { shellLocalesDir, useShellLocales } from './shell-i18n.js';

useShellLocales(shellLocalesDir({ packaged: false, resourcesPath: 'unused', desktopRoot: join(fileURLToPath(new URL('.', import.meta.url)), '..') }));

const ALL_FLAGS = { canUndo: true, canRedo: true, canCut: true, canCopy: true, canPaste: true, canDelete: true, canSelectAll: true, canEditRichly: false };

function params(over: Partial<ContextMenuInput> = {}): ContextMenuInput {
  return {
    isEditable: true, editFlags: ALL_FLAGS, selectionText: '', misspelledWord: '', dictionarySuggestions: [],
    formControlType: 'input-text', ...over,
  };
}

function recorder(): { target: ContextMenuTarget; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    target: {
      cut: () => calls.push('cut'), copy: () => calls.push('copy'), paste: () => calls.push('paste'),
      selectAll: () => calls.push('selectAll'), replaceMisspelling: (text) => calls.push(`replace:${text}`),
    },
  };
}

const labels = (items: MenuItemConstructorOptions[]): string[] => items.map((item) => item.type === 'separator' ? '-' : String(item.label));
const click = (item: MenuItemConstructorOptions | undefined): void => {
  assert.ok(item?.click);
  (item.click as () => void)();
};

test('context menu: an editable field offers Cut, Copy, Paste and Select All, each acting on the page', () => {
  const { target, calls } = recorder();
  const items = contextMenuTemplate(params(), target, 'en-US');
  assert.deepEqual(labels(items), ['Cut', 'Copy', 'Paste', '-', 'Select All']);
  for (const item of items) if (item.type !== 'separator') click(item);
  assert.deepEqual(calls, ['cut', 'copy', 'paste', 'selectAll']);
  // Shown only: the Edit menu holds the keys.
  assert.ok(items.every((item) => item.type === 'separator' || item.registerAccelerator === false));
});

test('context menu: the items follow the field\'s edit flags', () => {
  const { target } = recorder();
  const items = contextMenuTemplate(params({ editFlags: { ...ALL_FLAGS, canCut: false, canCopy: false, canPaste: false } }), target, 'en-US');
  const enabled = Object.fromEntries(items.filter((item) => item.type !== 'separator').map((item) => [item.label, item.enabled]));
  assert.deepEqual(enabled, { Cut: false, Copy: false, Paste: false, 'Select All': true });
});

test('context menu: a password field never offers Cut nor Copy', () => {
  const { target } = recorder();
  const items = contextMenuTemplate(params({ formControlType: 'input-password', selectionText: '' }), target, 'en-US');
  assert.deepEqual(labels(items), ['Paste', '-', 'Select All']);
});

test('context menu: a selection outside a field offers Copy alone, and nothing at all offers no menu', () => {
  const { target, calls } = recorder();
  const items = contextMenuTemplate(params({ isEditable: false, selectionText: 'sk-ant code', formControlType: 'none' }), target, 'en-US');
  assert.deepEqual(labels(items), ['Copy']);
  click(items[0]);
  assert.deepEqual(calls, ['copy']);
  assert.deepEqual(contextMenuTemplate(params({ isEditable: false, selectionText: '  \n', formControlType: 'none' }), target, 'en-US'), []);
});

test('context menu: a misspelled word lists its suggestions first, at most five, and replaces it', () => {
  const { target, calls } = recorder();
  const items = contextMenuTemplate(params({
    misspelledWord: 'helo', dictionarySuggestions: ['hello', 'help', 'hell', 'helot', 'halo', 'hole'],
  }), target, 'en-US');
  assert.deepEqual(labels(items), ['hello', 'help', 'hell', 'helot', 'halo', '-', 'Cut', 'Copy', 'Paste', '-', 'Select All']);
  click(items[1]);
  assert.deepEqual(calls, ['replace:help']);
  // No misspelled word: stray suggestions are not shown.
  assert.deepEqual(labels(contextMenuTemplate(params({ dictionarySuggestions: ['hello'] }), target, 'en-US')),
    ['Cut', 'Copy', 'Paste', '-', 'Select All']);
});

test('context menu: the labels speak the interface language', () => {
  const { target } = recorder();
  assert.deepEqual(labels(contextMenuTemplate(params(), target, 'fr')), ['Couper', 'Copier', 'Coller', '-', 'Tout sélectionner']);
});
