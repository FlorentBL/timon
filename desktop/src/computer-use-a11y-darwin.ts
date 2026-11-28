/**
 * Accessibility backend for macOS: the AXUIElement API, reached from JXA through `osascript`.
 * The script is fixed text; what the agent chose (window, path, action, value) travels as one JSON
 * argument, so nothing it sends is ever interpreted as code. The answer is one JSON line.
 *
 * Electron and Chromium build their tree only when asked: `AXManualAccessibility` is set on the
 * application element before it is read. Positions are in screen points, which is what the contract
 * wants from a backend (the service converts them to the frame of the last capture).
 */
import { A11yError, A11Y_ACTIONS, type A11yAction, type A11yActArgs, type A11yBackend, type A11yBounds, type A11yCheck, type A11yRawNode, type A11yRawTree, type A11yTreeArgs } from './computer-use-a11y.js';
import { MAC_TRUST_SCRIPT, macCommand } from './computer-use-input.js';
import { MAC_PICK_WINDOW_JS, type Exec } from './computer-use-windows.js';

/**
 * One script for both operations. `argv[0]` is `{ op: 'tree' | 'act', pid, number, path?, action?, value?, maxDepth?, maxNodes? }`.
 * Answers: `{ ok, truncated, nodes }` for a tree, `{ ok: true }` or `{ error, actions? }` for an action.
 */
export const MAC_A11Y_SCRIPT = `
ObjC.import('ApplicationServices');
ObjC.import('CoreGraphics');
${MAC_PICK_WINDOW_JS}
const NODE_BUDGET_MS = 6000;
function attr(el, name) {
  const ref = Ref();
  if ($.AXUIElementCopyAttributeValue(el, $(name), ref) !== 0 || !ref[0]) return null;
  return ObjC.castRefToObject(ref[0]);
}
function str(el, name) {
  const v = attr(el, name);
  if (v === null) return '';
  const u = ObjC.unwrap(v);
  return typeof u === 'string' ? u : (typeof u === 'number' || typeof u === 'boolean' ? String(u) : '');
}
function settable(el, name) {
  const ref = Ref();
  return $.AXUIElementIsAttributeSettable(el, $(name), ref) === 0 && ref[0] === true;
}
function point(el, name, a, b) {
  const v = attr(el, name);
  if (v === null) return null;
  const m = String(ObjC.unwrap(v.description)).match(new RegExp(a + ':(-?[0-9.]+) ' + b + ':(-?[0-9.]+)'));
  return m ? [Number(m[1]), Number(m[2])] : null;
}
function childrenOf(el, name) {
  const list = attr(el, name);
  if (list === null) return [];
  const out = [];
  const count = Number(list.count);
  for (let i = 0; i < count; i++) out.push(list.objectAtIndex(i));
  return out;
}
function children(el) { return childrenOf(el, 'AXChildren'); }
function actionNames(el) {
  const ref = Ref();
  if ($.AXUIElementCopyActionNames(el, ref) !== 0 || !ref[0]) return [];
  return ObjC.deepUnwrap(ObjC.castRefToObject(ref[0])) || [];
}
function describe(el, path) {
  const role = str(el, 'AXRole');
  const sub = str(el, 'AXSubrole');
  const name = str(el, 'AXTitle') || str(el, 'AXDescription') || str(el, 'AXPlaceholderValue') || (role === 'AXStaticText' ? '' : str(el, 'AXLabel'));
  const textual = ['AXTextField', 'AXTextArea', 'AXComboBox', 'AXSlider', 'AXStaticText', 'AXCheckBox', 'AXRadioButton', 'AXPopUpButton'].indexOf(role) >= 0;
  const value = textual ? str(el, 'AXValue') : '';
  const names = actionNames(el);
  const actions = [];
  if (names.indexOf('AXPress') >= 0) actions.push('press');
  if (names.indexOf('AXShowMenu') >= 0) actions.push('show_menu');
  if (names.indexOf('AXScrollToVisible') >= 0) actions.push('scroll_into_view');
  if (settable(el, 'AXFocused')) actions.push('focus');
  if (textual && role !== 'AXStaticText' && settable(el, 'AXValue')) actions.push('set_value');
  if (attr(el, 'AXExpanded') !== null) { actions.push('expand'); actions.push('collapse'); }
  if (settable(el, 'AXSelected')) actions.push('select');
  const enabledRaw = attr(el, 'AXEnabled');
  const focusedRaw = attr(el, 'AXFocused');
  const node = { path, role, sub, name, value, enabled: enabledRaw === null ? true : Boolean(ObjC.unwrap(enabledRaw)), actions };
  if (focusedRaw !== null && ObjC.unwrap(focusedRaw) === true) node.focused = true;
  const pos = point(el, 'AXPosition', 'x', 'y');
  const size = point(el, 'AXSize', 'w', 'h');
  if (pos && size) node.bounds = { x: pos[0], y: pos[1], width: size[0], height: size[1] };
  return node;
}
function readTree(root, maxDepth, maxNodes) {
  const nodes = [];
  let truncated = false;
  const started = Date.now();
  const visit = (el, path, depth) => {
    if (nodes.length >= maxNodes || Date.now() - started > NODE_BUDGET_MS) { truncated = true; return; }
    nodes.push(describe(el, path));
    if (depth + 1 >= maxDepth) { if (children(el).length > 0) truncated = true; return; }
    const kids = children(el);
    for (let i = 0; i < kids.length; i++) visit(kids[i], path + '.' + i, depth + 1);
  };
  visit(root, '0', 0);
  return { ok: true, truncated, nodes };
}
function walk(win, path) {
  let el = win;
  const steps = path.split('.').slice(1);
  for (const step of steps) {
    const kids = children(el);
    const index = Number(step);
    if (index >= kids.length) return null;
    el = kids[index];
  }
  return el;
}
function act(el, action, value) {
  const names = actionNames(el);
  const possible = describe(el, '0').actions;
  const unsupported = () => JSON.stringify({ error: 'unsupported', actions: possible });
  if (possible.indexOf(action) < 0) return unsupported();
  const yes = $.kCFBooleanTrue;
  const no = $.kCFBooleanFalse;
  let code = 0;
  if (action === 'press') code = $.AXUIElementPerformAction(el, $('AXPress'));
  else if (action === 'show_menu') code = $.AXUIElementPerformAction(el, $('AXShowMenu'));
  else if (action === 'scroll_into_view') code = $.AXUIElementPerformAction(el, $('AXScrollToVisible'));
  else if (action === 'focus') code = $.AXUIElementSetAttributeValue(el, $('AXFocused'), yes);
  else if (action === 'set_value') code = $.AXUIElementSetAttributeValue(el, $('AXValue'), $(value));
  else if (action === 'select') code = $.AXUIElementSetAttributeValue(el, $('AXSelected'), yes);
  else if (action === 'expand') code = $.AXUIElementSetAttributeValue(el, $('AXExpanded'), yes);
  else if (action === 'collapse') code = $.AXUIElementSetAttributeValue(el, $('AXExpanded'), no);
  return code === 0 ? JSON.stringify({ ok: true }) : JSON.stringify({ error: 'failed', code: Number(code) });
}
function run(argv) {
  const req = JSON.parse(argv[0]);
  const app = $.AXUIElementCreateApplication(req.pid);
  // Electron and Chromium only build their tree when an assistive client says it is there.
  $.AXUIElementSetAttributeValue(app, $('AXManualAccessibility'), $.kCFBooleanTrue);
  const win = pickWindow(app, req.pid, req.number);
  if (win === null) return JSON.stringify({ error: 'stale' });
  if (req.op === 'tree') return JSON.stringify(readTree(win, req.maxDepth, req.maxNodes));
  const el = walk(win, req.path);
  if (el === null) return JSON.stringify({ error: 'stale' });
  return act(el, req.action, req.value || '');
}
`.trim();

const ROLES: Readonly<Record<string, string>> = {
  AXButton: 'button', AXTextField: 'textfield', AXSearchField: 'textfield', AXTextArea: 'textarea', AXCheckBox: 'checkbox',
  AXRadioButton: 'radio', AXComboBox: 'combobox', AXPopUpButton: 'combobox', AXMenuButton: 'combobox', AXList: 'list', AXOutline: 'list',
  AXBrowser: 'list', AXMenu: 'menu', AXMenuItem: 'menuitem', AXMenuBarItem: 'menuitem', AXMenuBar: 'menubar', AXTabGroup: 'tablist',
  AXLink: 'link', AXImage: 'image', AXStaticText: 'text', AXGroup: 'group', AXSplitGroup: 'group', AXScrollArea: 'group',
  AXWindow: 'window', AXToolbar: 'toolbar', AXTable: 'table', AXRow: 'row', AXCell: 'cell', AXSlider: 'slider', AXScrollBar: 'scrollbar',
};

/** The contract's role for an AX role and subrole; a tab is a radio button or button with the tab subrole. */
export function macRole(role: string, subrole: string): string {
  if (subrole === 'AXTabButton') return 'tab';
  return ROLES[role] ?? 'other';
}

const isAction = (text: unknown): text is A11yAction => typeof text === 'string' && (A11Y_ACTIONS as readonly string[]).includes(text);
const text = (value: unknown): string => typeof value === 'string' ? value : '';

function parseBounds(value: unknown): A11yBounds | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const b = value as Record<string, unknown>;
  return [b.x, b.y, b.width, b.height].every((n) => typeof n === 'number' && Number.isFinite(n))
    ? { x: b.x as number, y: b.y as number, width: b.width as number, height: b.height as number } : undefined;
}

function parseNode(value: unknown): A11yRawNode | null {
  if (typeof value !== 'object' || value === null) return null;
  const n = value as Record<string, unknown>;
  if (typeof n.path !== 'string') return null;
  const node: A11yRawNode = {
    path: n.path, role: macRole(text(n.role), text(n.sub)), name: text(n.name), enabled: n.enabled !== false,
    actions: Array.isArray(n.actions) ? n.actions.filter(isAction) : [],
  };
  if (text(n.value) !== '') node.value = text(n.value);
  if (n.focused === true) node.focused = true;
  const bounds = parseBounds(n.bounds);
  if (bounds) node.bounds = bounds;
  return node;
}

/** `pid:CGWindowNumber`, the id list_windows gives. */
function splitWindowId(windowId: string): { pid: number; number: number } {
  const match = /^(\d{1,10}):(\d{1,10})$/.exec(windowId);
  if (!match) throw new A11yError('stale', 'That window id is not one of this system.');
  return { pid: Number(match[1]), number: Number(match[2]) };
}

async function runScript(exec: Exec, request: Record<string, unknown>): Promise<Record<string, unknown>> {
  let stdout: string;
  try { stdout = (await exec(macCommand(MAC_A11Y_SCRIPT, request))).stdout; }
  catch (error) { throw new A11yError('failed', `The accessibility read failed: ${error instanceof Error ? error.message : String(error)}`); }
  try {
    const parsed: unknown = JSON.parse(stdout.trim().split('\n').pop() ?? '');
    if (typeof parsed === 'object' && parsed !== null) return parsed as Record<string, unknown>;
  } catch { /* falls through */ }
  throw new A11yError('failed', 'The accessibility read returned something unreadable.');
}

export function darwinA11yBackend(exec: Exec): A11yBackend {
  return {
    async probe(): Promise<A11yCheck> {
      try { return (await exec(macCommand(MAC_TRUST_SCRIPT))).stdout.trim() === 'true' ? 'ok' : 'missing'; }
      catch { return 'missing'; }
    },
    async tree(args: A11yTreeArgs): Promise<A11yRawTree> {
      const { pid, number } = splitWindowId(args.windowId);
      const answer = await runScript(exec, { op: 'tree', pid, number, maxDepth: args.maxDepth, maxNodes: args.maxNodes });
      if (answer.error === 'stale') throw new A11yError('stale', 'That window is gone.');
      if (answer.ok !== true || !Array.isArray(answer.nodes)) throw new A11yError('failed', 'The accessibility tree could not be read.');
      const nodes = answer.nodes.map(parseNode).filter((n): n is A11yRawNode => n !== null);
      return { truncated: answer.truncated === true, nodes };
    },
    async act(args: A11yActArgs): Promise<void> {
      const { pid, number } = splitWindowId(args.windowId);
      const answer = await runScript(exec, { op: 'act', pid, number, path: args.path, action: args.action, ...(args.value === undefined ? {} : { value: args.value }) });
      if (answer.ok === true) return;
      if (answer.error === 'stale') throw new A11yError('stale', 'That element is gone.');
      if (answer.error === 'unsupported') {
        const possible = Array.isArray(answer.actions) ? answer.actions.filter(isAction) : [];
        throw new A11yError('unsupported', `The element cannot ${args.action}.`, possible);
      }
      throw new A11yError('failed', `The element refused ${args.action}.`);
    },
  };
}
