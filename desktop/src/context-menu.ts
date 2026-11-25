import type { ContextMenuParams, MenuItemConstructorOptions } from 'electron';
import { shellText } from './shell-i18n.js';

/**
 * The right-click menu of the interface's pages (TODO #1133). Electron shows
 * none by default: without it a right click in a field does nothing, and a
 * user who pastes with the mouse (a sign-in code, a key) is stuck. The
 * built-in browser has its own menu (`native-browser.ts`).
 *
 * Built from the page's own report of what is under the pointer, so the
 * menu offers exactly what the field allows:
 * - an editable field: Cut, Copy, Paste, Select All, each enabled per
 *   `editFlags`, preceded by the spelling suggestions of a misspelled word;
 * - a password field: Paste and Select All only, its value never leaves
 *   through the clipboard;
 * - a selection outside a field: Copy;
 * - anything else: no menu.
 */

/** The fields of `ContextMenuParams` the menu reads: the tests build them by hand. */
export type ContextMenuInput = Pick<ContextMenuParams,
  'isEditable' | 'editFlags' | 'selectionText' | 'misspelledWord' | 'dictionarySuggestions' | 'formControlType'>;

/** What the items act on: the page's `webContents`. */
export interface ContextMenuTarget {
  cut(): void;
  copy(): void;
  paste(): void;
  selectAll(): void;
  replaceMisspelling(text: string): void;
}

/** Chromium offers up to five; more would push the edit items off a short screen. */
const MAX_SUGGESTIONS = 5;

/**
 * The items of the menu, or an empty list when there is nothing to offer.
 * The shortcuts are shown, not registered: the Edit menu already holds them.
 */
export function contextMenuTemplate(params: ContextMenuInput, target: ContextMenuTarget, locale: string): MenuItemConstructorOptions[] {
  const t = shellText(locale);
  if (!params.isEditable) {
    if (params.selectionText.trim() === '') return [];
    return [{ label: t('contextMenu.copy'), accelerator: 'CmdOrCtrl+C', registerAccelerator: false, click: () => target.copy() }];
  }
  // Electron 33 reports the password field as `formControlType`; `inputFieldType` is gone.
  const secret = params.formControlType === 'input-password';
  const items: MenuItemConstructorOptions[] = [];
  const suggestions = params.misspelledWord ? params.dictionarySuggestions.slice(0, MAX_SUGGESTIONS) : [];
  for (const word of suggestions) items.push({ label: word, click: () => target.replaceMisspelling(word) });
  if (items.length > 0) items.push({ type: 'separator' });
  const flags = params.editFlags;
  if (!secret) {
    items.push({ label: t('contextMenu.cut'), accelerator: 'CmdOrCtrl+X', registerAccelerator: false, enabled: flags.canCut, click: () => target.cut() });
    items.push({ label: t('contextMenu.copy'), accelerator: 'CmdOrCtrl+C', registerAccelerator: false, enabled: flags.canCopy, click: () => target.copy() });
  }
  items.push({ label: t('contextMenu.paste'), accelerator: 'CmdOrCtrl+V', registerAccelerator: false, enabled: flags.canPaste, click: () => target.paste() });
  items.push({ type: 'separator' });
  items.push({ label: t('contextMenu.selectAll'), accelerator: 'CmdOrCtrl+A', registerAccelerator: false, enabled: flags.canSelectAll, click: () => target.selectAll() });
  return items;
}
