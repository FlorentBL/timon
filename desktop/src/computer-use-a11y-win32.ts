/**
 * Accessibility backend for Windows: UI Automation, read and driven inside the persistent
 * PowerShell worker that already carries the input (`computer-use-a11y-win32-script.ts`). A request
 * is a JSON object on the worker's stdin and never part of a script, so nothing an agent sends can
 * run as code.
 */
import {
  A11Y_ACTIONS, A11yError, type A11yActArgs, type A11yAction, type A11yBackend, type A11yCheck, type A11yRawNode, type A11yRawTree, type A11yTreeArgs,
} from './computer-use-a11y.js';
import { windowsQueryCommand, type WindowsQuery } from './computer-use-input.js';
import type { Exec } from './computer-use-windows.js';

/** A window id is a decimal HWND on Windows. */
const HWND = /^\d{1,20}$/;

const isActions = (value: unknown): value is A11yAction[] => Array.isArray(value) && value.every((a) => (A11Y_ACTIONS as readonly string[]).includes(a as string));

async function ask(exec: Exec, query: WindowsQuery): Promise<Record<string, unknown>> {
  let stdout: string;
  try { stdout = (await exec(windowsQueryCommand(query))).stdout; } catch { throw new A11yError('failed', 'The accessibility service could not be reached.'); }
  let parsed: unknown;
  try { parsed = JSON.parse(stdout.trim()); } catch { throw new A11yError('failed', 'The accessibility service answered something unreadable.'); }
  if (!parsed || typeof parsed !== 'object') throw new A11yError('failed', 'The accessibility service answered something unreadable.');
  return parsed as Record<string, unknown>;
}

function nodeOf(value: unknown): A11yRawNode | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.path !== 'string' || typeof raw.role !== 'string') return null;
  const node: A11yRawNode = {
    path: raw.path, role: raw.role, name: typeof raw.name === 'string' ? raw.name : '', enabled: raw.enabled !== false,
    actions: Array.isArray(raw.actions) ? raw.actions.filter((a): a is string => typeof a === 'string') : [],
  };
  if (typeof raw.value === 'string') node.value = raw.value;
  if (raw.focused === true) node.focused = true;
  const b = raw.bounds as Record<string, unknown> | undefined;
  if (b && [b.x, b.y, b.width, b.height].every((n) => typeof n === 'number')) {
    node.bounds = { x: b.x as number, y: b.y as number, width: b.width as number, height: b.height as number };
  }
  return node;
}

export function win32A11yBackend(exec: Exec): A11yBackend {
  return {
    // UI Automation ships with Windows: the check is that the worker can load it.
    async probe(): Promise<A11yCheck> {
      try { return (await ask(exec, { q: 'a11y_probe' })).ok === true ? 'ok' : 'missing'; } catch { return 'missing'; }
    },

    async tree(args: A11yTreeArgs): Promise<A11yRawTree> {
      if (!HWND.test(args.windowId)) throw new A11yError('failed', 'No such window.');
      const answer = await ask(exec, { q: 'a11y_tree', id: args.windowId, maxDepth: args.maxDepth, maxNodes: args.maxNodes });
      if (answer.stale === true) throw new A11yError('failed', 'No such window.');
      const nodes = (Array.isArray(answer.nodes) ? answer.nodes : []).map(nodeOf).filter((n): n is A11yRawNode => n !== null);
      return { truncated: answer.truncated === true, nodes };
    },

    async act(args: A11yActArgs): Promise<void> {
      if (!HWND.test(args.windowId)) throw new A11yError('stale', 'The element is gone.');
      const query: WindowsQuery = { q: 'a11y_act', id: args.windowId, path: args.path, action: args.action };
      if (args.action === 'set_value') query.value = args.value ?? '';
      const answer = await ask(exec, query);
      if (answer.ok === true) return;
      if (answer.stale === true) throw new A11yError('stale', 'The element is gone.');
      if (answer.unsupported === true) {
        const possible = isActions(answer.actions) ? answer.actions : [];
        throw new A11yError('unsupported', `This element cannot ${args.action}.`, possible);
      }
      throw new A11yError('failed', 'The action failed.');
    },
  };
}
