/**
 * Accessibility backend for linux, over AT-SPI. One FIXED python3 script (PyGObject, `Atspi`) is
 * embedded as a string and started with `python3 -c`: no shell, and everything the agent controls
 * (window, path, action, value) travels as one JSON argument in argv, never inside the script, so
 * nothing it sends can be interpreted as code.
 *
 * The window id is the X11 id (decimal) from list_windows. AT-SPI does not know X ids, so the
 * window is found through what xdotool says about it: its process and its title.
 */
import { A11yError, type A11yActArgs, type A11yBackend, type A11yCheck, type A11yRawTree, type A11yTreeArgs } from './computer-use-a11y.js';
import type { SystemCommand } from './computer-use-input.js';
import type { Exec } from './computer-use-windows.js';

/** What to install when the probe says `missing`, for the three usual package managers. */
export const LINUX_A11Y_HINT =
  'Install the AT-SPI bindings: apt install python3-gi gir1.2-atspi-2.0 at-spi2-core (Debian, Ubuntu), '
  + 'dnf install python3-gobject at-spi2-core (Fedora), pacman -S python-gobject at-spi2-core (Arch). '
  + 'The session also needs the accessibility bus (at-spi-bus-launcher).';

/** Fixed text: read it, never build it from input. */
const SCRIPT = String.raw`
import sys, json
import gi
gi.require_version('Atspi', '2.0')
from gi.repository import Atspi

ROLES = {
  'push button': 'button', 'button': 'button', 'toggle button': 'button', 'entry': 'textfield', 'password text': 'textfield',
  'text': 'text', 'label': 'text', 'static': 'text', 'paragraph': 'text', 'heading': 'text',
  'check box': 'checkbox', 'check menu item': 'checkbox', 'radio button': 'radio', 'radio menu item': 'radio',
  'combo box': 'combobox', 'list': 'list', 'list box': 'list', 'list item': 'listitem', 'menu': 'menu', 'popup menu': 'menu',
  'menu item': 'menuitem', 'menu bar': 'menubar', 'page tab': 'tab', 'page tab list': 'tablist', 'link': 'link',
  'image': 'image', 'icon': 'image', 'panel': 'group', 'section': 'group', 'filler': 'group', 'grouping': 'group',
  'frame': 'window', 'window': 'window', 'dialog': 'window', 'tool bar': 'toolbar', 'table': 'table', 'tree table': 'table',
  'table row': 'row', 'table cell': 'cell', 'slider': 'slider', 'scroll bar': 'scrollbar',
}
PRESS = ('click', 'press', 'activate', 'jump', 'toggle', 'check', 'uncheck', 'open')

def has(state_set, state):
    return state_set.contains(state)

def interfaces(acc):
    try:
        return set(acc.get_interfaces())
    except Exception:
        return set()

def action_names(acc):
    names = []
    try:
        for i in range(Atspi.Action.get_n_actions(acc)):
            names.append(Atspi.Action.get_action_name(acc, i).lower())
    except Exception:
        pass
    return names

def find_action(acc, words):
    for i, name in enumerate(action_names(acc)):
        if any(w in name for w in words):
            return i
    return None

def kind_of(acc, role, ifaces, states):
    kind = ROLES.get(role, 'other')
    if kind == 'textfield' and has(states, Atspi.StateType.MULTI_LINE):
        return 'textarea'
    if role == 'text' and 'EditableText' in ifaces:
        return 'textarea' if has(states, Atspi.StateType.MULTI_LINE) else 'textfield'
    return kind

def possible(acc, kind, ifaces, states, parent_ifaces):
    out = []
    names = action_names(acc)
    if find_action(acc, PRESS) is not None:
        out.append('press')
    if 'Component' in ifaces and has(states, Atspi.StateType.FOCUSABLE):
        out.append('focus')
    if 'EditableText' in ifaces and has(states, Atspi.StateType.EDITABLE):
        out.append('set_value')
    if 'Selection' in parent_ifaces or has(states, Atspi.StateType.SELECTABLE):
        out.append('select')
    if has(states, Atspi.StateType.EXPANDABLE) or find_action(acc, ('expand', 'contract', 'collapse')) is not None:
        out.extend(['expand', 'collapse'])
    if find_action(acc, ('menu',)) is not None:
        out.append('show_menu')
    if 'Component' in ifaces:
        out.append('scroll_into_view')
    return out

def describe(acc, path, parent_ifaces):
    states = acc.get_state_set()
    ifaces = interfaces(acc)
    role = acc.get_role_name().lower()
    kind = kind_of(acc, role, ifaces, states)
    node = {'path': path, 'role': kind, 'name': acc.get_name() or '',
            'enabled': has(states, Atspi.StateType.ENABLED) or has(states, Atspi.StateType.SENSITIVE),
            'actions': possible(acc, kind, ifaces, states, parent_ifaces)}
    value = None
    try:
        if kind in ('textfield', 'textarea') and 'Text' in ifaces:
            value = Atspi.Text.get_text(acc, 0, 2000)
        elif kind == 'slider' and 'Value' in ifaces:
            value = str(Atspi.Value.get_current_value(acc))
        elif kind in ('checkbox', 'radio'):
            value = 'true' if has(states, Atspi.StateType.CHECKED) else 'false'
    except Exception:
        value = None
    if value:
        node['value'] = value
    if has(states, Atspi.StateType.FOCUSED):
        node['focused'] = True
    if 'Component' in ifaces:
        try:
            r = Atspi.Component.get_extents(acc, Atspi.CoordType.SCREEN)
            if r.width > 0 and r.height > 0:
                node['bounds'] = {'x': r.x, 'y': r.y, 'width': r.width, 'height': r.height}
        except Exception:
            pass
    return node, ifaces

def find_window(req):
    desktop = Atspi.get_desktop(0)
    pid = req.get('pid')
    title = req.get('title') or ''
    best = None
    for i in range(desktop.get_child_count()):
        app = desktop.get_child_at_index(i)
        if app is None:
            continue
        if pid is not None:
            try:
                if app.get_process_id() != pid:
                    continue
            except Exception:
                continue
        for j in range(app.get_child_count()):
            win = app.get_child_at_index(j)
            if win is None:
                continue
            if title and (win.get_name() or '') == title:
                return win
            if best is None and win.get_role_name().lower() in ('frame', 'window', 'dialog') and pid is not None:
                best = win
    return best

def at_path(win, path):
    acc = win
    for part in path.split('.')[1:]:
        index = int(part)
        if index >= acc.get_child_count():
            return None
        acc = acc.get_child_at_index(index)
        if acc is None:
            return None
    return acc

def walk(win, max_depth, max_nodes):
    nodes = []
    truncated = False
    def visit(acc, path, depth, parent_ifaces):
        nonlocal truncated
        if len(nodes) >= max_nodes:
            truncated = True
            return
        node, ifaces = describe(acc, path, parent_ifaces)
        nodes.append(node)
        if depth + 1 >= max_depth:
            if acc.get_child_count() > 0:
                truncated = True
            return
        for index in range(acc.get_child_count()):
            child = acc.get_child_at_index(index)
            if child is None:
                continue
            if depth >= 0 and not has(child.get_state_set(), Atspi.StateType.SHOWING):
                continue
            visit(child, path + '.' + str(index), depth + 1, ifaces)
            if truncated and len(nodes) >= max_nodes:
                return
    visit(win, '0', 0, set())
    return {'truncated': truncated, 'nodes': nodes}

def act(win, req):
    acc = at_path(win, req['path'])
    if acc is None:
        return {'error': 'stale'}
    action = req['action']
    parent = acc.get_parent()
    states = acc.get_state_set()
    ifaces = interfaces(acc)
    parent_ifaces = interfaces(parent) if parent is not None else set()
    can = possible(acc, '', ifaces, states, parent_ifaces)
    if action not in can:
        return {'error': 'unsupported', 'actions': can}
    ok = False
    if action == 'press':
        ok = Atspi.Action.do_action(acc, find_action(acc, PRESS))
    elif action == 'focus':
        ok = Atspi.Component.grab_focus(acc)
    elif action == 'set_value':
        ok = Atspi.EditableText.set_text_contents(acc, req.get('value') or '')
    elif action == 'select':
        index = acc.get_index_in_parent()
        if 'Selection' in parent_ifaces:
            ok = Atspi.Selection.select_child(parent, index)
        else:
            i = find_action(acc, ('select', 'click', 'press'))
            ok = i is not None and Atspi.Action.do_action(acc, i)
    elif action == 'expand':
        i = find_action(acc, ('expand', 'open'))
        if i is None:
            i = find_action(acc, ('contract',))
        ok = i is not None and Atspi.Action.do_action(acc, i)
    elif action == 'collapse':
        i = find_action(acc, ('collapse', 'contract', 'close'))
        ok = i is not None and Atspi.Action.do_action(acc, i)
    elif action == 'show_menu':
        ok = Atspi.Action.do_action(acc, find_action(acc, ('menu',)))
    elif action == 'scroll_into_view':
        ok = Atspi.Component.scroll_to(acc, Atspi.ScrollType.ANYWHERE)
    return {'ok': True} if ok else {'error': 'failed'}

def main():
    req = json.loads(sys.argv[1])
    op = req['op']
    if op == 'probe':
        Atspi.get_desktop(0).get_child_count()
        out = {'ok': True}
    else:
        win = find_window(req)
        if win is None:
            out = {'error': 'stale'}
        elif op == 'tree':
            out = walk(win, req['maxDepth'], req['maxNodes'])
        else:
            out = act(win, req)
    sys.stdout.write(json.dumps(out))

main()
`;

const python = (request: Record<string, unknown>): SystemCommand => ({ file: 'python3', args: ['-c', SCRIPT, JSON.stringify(request)] });
const xdotool = (...args: string[]): SystemCommand => ({ file: 'xdotool', args });

const ACTIONS = ['press', 'focus', 'set_value', 'select', 'expand', 'collapse', 'show_menu', 'scroll_into_view'] as const;

export function linuxA11yBackend(exec: Exec): A11yBackend {
  /** The window's process and title, which is how AT-SPI is asked for it. A missing one is left out. */
  async function windowRef(windowId: string): Promise<{ pid?: number; title?: string }> {
    if (!/^\d{1,12}$/.test(windowId)) throw new A11yError('stale', 'No such window.');
    const ref: { pid?: number; title?: string } = {};
    try { const pid = Number((await exec(xdotool('getwindowpid', windowId))).stdout.trim()); if (Number.isInteger(pid) && pid > 0) ref.pid = pid; } catch { /* the title may still find it */ }
    try { const title = (await exec(xdotool('getwindowname', windowId))).stdout.replace(/\n$/, ''); if (title) ref.title = title; } catch { /* same */ }
    if (ref.pid === undefined && ref.title === undefined) throw new A11yError('stale', 'No such window.');
    return ref;
  }

  async function run(request: Record<string, unknown>): Promise<Record<string, unknown>> {
    let stdout: string;
    try { stdout = (await exec(python(request))).stdout; }
    catch { throw new A11yError('failed', 'Reading the accessibility tree failed. Is the accessibility bus running?'); }
    try {
      const parsed: unknown = JSON.parse(stdout);
      if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>;
    } catch { /* falls through */ }
    throw new A11yError('failed', 'The accessibility reader answered something unreadable.');
  }

  function refuse(out: Record<string, unknown>): void {
    if (out.error === 'stale') throw new A11yError('stale', 'That element or window no longer exists.');
    if (out.error === 'unsupported') {
      const possible = Array.isArray(out.actions) ? out.actions.filter((a): a is typeof ACTIONS[number] => (ACTIONS as readonly unknown[]).includes(a)) : [];
      throw new A11yError('unsupported', 'That element cannot do this.', possible);
    }
    if (out.error !== undefined) throw new A11yError('failed', 'The accessibility action failed.');
  }

  return {
    async probe(): Promise<A11yCheck> {
      try { return (await run({ op: 'probe' })).ok === true ? 'ok' : 'missing'; } catch { return 'missing'; }
    },
    async tree(args: A11yTreeArgs): Promise<A11yRawTree> {
      const ref = await windowRef(args.windowId);
      const out = await run({ op: 'tree', ...ref, maxDepth: args.maxDepth, maxNodes: args.maxNodes });
      refuse(out);
      if (!Array.isArray(out.nodes)) throw new A11yError('failed', 'The accessibility reader answered something unreadable.');
      return { truncated: out.truncated === true, nodes: out.nodes as A11yRawTree['nodes'] };
    },
    async act(args: A11yActArgs): Promise<void> {
      const ref = await windowRef(args.windowId);
      refuse(await run({ op: 'act', ...ref, path: args.path, action: args.action, ...(args.value === undefined ? {} : { value: args.value }) }));
    },
  };
}
