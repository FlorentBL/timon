/**
 * The window system, read and driven through the same injected executor as the input: which
 * application is in front, which windows are open, bringing one forward, and the list of
 * applications an agent may act in.
 *
 * Nothing here is spliced into a script: macOS and Windows run fixed text, a window id travels as
 * JSON, and Linux builds an argv array.
 */
import { macCommand, windowsQueryCommand, type InputPlatform, type SystemCommand } from './computer-use-input.js';

export type Exec = (command: SystemCommand) => Promise<{ stdout: string }>;

/** What identifies an application: every spelling the user may have put in the list. */
export interface AppIdentity {
  /** macOS bundle identifier. */
  bundle?: string;
  /** The name a person sees. */
  name: string;
  /** The executable's name. */
  exe?: string;
}

export interface WindowInfo { id: string; title: string; app: string; focused: boolean }
interface WindowEntry extends WindowInfo { identity: AppIdentity }

const MAX_WINDOWS = 60;

// ── macOS ──────────────────────────────────────────────────────────────────

const MAC_FOREGROUND_SCRIPT = `
ObjC.import('AppKit');
function run() {
  const app = $.NSWorkspace.sharedWorkspace.frontmostApplication;
  const text = (value) => { const v = value ? ObjC.unwrap(value) : ''; return typeof v === 'string' ? v : ''; };
  return JSON.stringify({ bundle: text(app.bundleIdentifier), name: text(app.localizedName), exe: text(app.executableURL ? app.executableURL.lastPathComponent : null) });
}
`.trim();

// Window ids are `<unix pid>:<index in the application's window list>`: System Events has no stable window number.
const MAC_LIST_SCRIPT = `
function run() {
  const events = Application('System Events');
  const out = [];
  for (const process of events.processes.whose({ backgroundOnly: false })()) {
    let windows = [];
    try { windows = process.windows(); } catch (e) { continue; }
    let pid = 0, name = '', bundle = '', front = false;
    try { pid = process.unixId(); name = process.name(); bundle = process.bundleIdentifier() || ''; front = process.frontmost(); } catch (e) { continue; }
    windows.forEach((window, index) => {
      let title = '';
      try { title = window.title() || ''; } catch (e) { /* untitled */ }
      out.push({ id: pid + ':' + (index + 1), title, app: name, bundle, focused: front && index === 0 });
    });
    if (out.length >= ${MAX_WINDOWS}) break;
  }
  return JSON.stringify(out);
}
`.trim();

const MAC_FOCUS_SCRIPT = `
function run(argv) {
  const [pid, index] = JSON.parse(argv[0]);
  const events = Application('System Events');
  const process = events.processes.whose({ unixId: pid })()[0];
  process.frontmost = true;
  process.windows()[index - 1].actions.byName('AXRaise').perform();
  return 'ok';
}
`.trim();

// ── Parsing ────────────────────────────────────────────────────────────────

function parseJson(stdout: string): unknown {
  try { return JSON.parse(stdout.trim()); } catch { return undefined; }
}

const str = (value: unknown): string => typeof value === 'string' ? value : '';

function identityOf(value: unknown): AppIdentity | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const identity: AppIdentity = { name: str(raw.name) };
  if (str(raw.bundle)) identity.bundle = str(raw.bundle);
  if (str(raw.exe)) identity.exe = str(raw.exe);
  return identity.name || identity.bundle || identity.exe ? identity : null;
}

function entriesOf(value: unknown): WindowEntry[] {
  if (!Array.isArray(value)) return [];
  const out: WindowEntry[] = [];
  for (const item of value.slice(0, MAX_WINDOWS)) {
    if (!item || typeof item !== 'object') continue;
    const raw = item as Record<string, unknown>;
    const id = str(raw.id);
    if (!/^[A-Za-z0-9:_.-]{1,64}$/.test(id)) continue;
    const identity = identityOf({ name: raw.app, bundle: raw.bundle, exe: raw.exe });
    if (!identity) continue;
    out.push({ id, title: str(raw.title), app: identity.name || identity.exe || identity.bundle || '', focused: raw.focused === true, identity });
  }
  return out;
}

// ── Linux ──────────────────────────────────────────────────────────────────

const xdotool = (...args: string[]): SystemCommand => ({ file: 'xdotool', args });

async function linuxIdentity(exec: Exec, windowId: string): Promise<AppIdentity | null> {
  let pid = '';
  let className = '';
  try { pid = (await exec(xdotool('getwindowpid', windowId))).stdout.trim(); } catch { /* no pid: the class may still name it */ }
  try { className = (await exec(xdotool('getwindowclassname', windowId))).stdout.trim(); } catch { /* same */ }
  let exe = '';
  if (/^\d+$/.test(pid)) {
    // portability: Linux branch only, the same X11 session xdotool needs
    try { exe = (await exec({ file: 'ps', args: ['-p', pid, '-o', 'comm='] })).stdout.trim(); } catch { /* gone */ }
  }
  return identityOf({ name: className || exe, exe });
}

async function linuxWindows(exec: Exec): Promise<WindowEntry[]> {
  const active = (await exec(xdotool('getactivewindow')).catch(() => ({ stdout: '' }))).stdout.trim();
  const found = await exec(xdotool('search', '--onlyvisible', '--name', '.'));
  const out: WindowEntry[] = [];
  for (const id of found.stdout.split('\n').map((line) => line.trim()).filter((line) => /^\d{1,20}$/.test(line)).slice(0, MAX_WINDOWS)) {
    let title = '';
    try { title = (await exec(xdotool('getwindowname', id))).stdout.trim(); } catch { continue; }
    const identity = await linuxIdentity(exec, id);
    if (!identity) continue;
    out.push({ id, title, app: identity.name || identity.exe || '', focused: id === active, identity });
  }
  return out;
}

// ── Per-OS entry points ────────────────────────────────────────────────────

/** The application in front, or null when the system cannot tell. */
export async function readForegroundApp(platform: InputPlatform, exec: Exec): Promise<AppIdentity | null> {
  try {
    if (platform === 'darwin') return identityOf(parseJson((await exec(macCommand(MAC_FOREGROUND_SCRIPT))).stdout));
    if (platform === 'win32') return identityOf(parseJson((await exec(windowsQueryCommand({ q: 'foreground' }))).stdout));
    // Without a window manager there is no active window: the window holding the input focus is the next best.
    let active = (await exec(xdotool('getactivewindow')).catch(() => ({ stdout: '' }))).stdout.trim();
    if (!/^\d+$/.test(active)) active = (await exec(xdotool('getwindowfocus'))).stdout.trim();
    return /^\d+$/.test(active) ? await linuxIdentity(exec, active) : null;
  } catch { return null; }
}

async function entries(platform: InputPlatform, exec: Exec): Promise<WindowEntry[]> {
  if (platform === 'darwin') return entriesOf(parseJson((await exec(macCommand(MAC_LIST_SCRIPT))).stdout));
  if (platform === 'win32') return entriesOf(parseJson((await exec(windowsQueryCommand({ q: 'windows' }))).stdout));
  return linuxWindows(exec);
}

/** The open windows, front to back as far as the system says. */
export async function listWindows(platform: InputPlatform, exec: Exec): Promise<WindowInfo[]> {
  return (await entries(platform, exec)).map(({ id, title, app, focused }) => ({ id, title, app, focused }));
}

/** The application owning window `id`, or null when no such window is open. */
export async function windowApp(platform: InputPlatform, exec: Exec, id: string): Promise<AppIdentity | null> {
  return (await entries(platform, exec)).find((entry) => entry.id === id)?.identity ?? null;
}

/** Brings window `id` forward. Resolves false when the system did not (Windows reports it). */
export async function focusWindow(platform: InputPlatform, exec: Exec, id: string): Promise<boolean> {
  if (platform === 'darwin') {
    const [pid, index] = id.split(':').map(Number);
    if (!Number.isInteger(pid) || !Number.isInteger(index)) return false;
    await exec(macCommand(MAC_FOCUS_SCRIPT, [pid, index]));
    return true;
  }
  if (platform === 'win32') {
    const answer = parseJson((await exec(windowsQueryCommand({ q: 'focus', id }))).stdout) as { ok?: unknown } | undefined;
    return answer?.ok === true;
  }
  await exec(xdotool('windowactivate', '--sync', id));
  return true;
}

// ── The allowed applications ───────────────────────────────────────────────

/** Case and a trailing ".exe" never matter: "Notepad", "notepad.exe" and "NOTEPAD.EXE" are one name. */
const normalize = (value: string): string => value.trim().toLowerCase().replace(/\.exe$/, '');

/** The list is explicit: an empty or absent one allows nothing. Any of the app's three names may be listed. */
export function isAppAllowed(app: AppIdentity | null, allowed: readonly string[]): boolean {
  if (!app) return false;
  const wanted = new Set(allowed.map(normalize).filter(Boolean));
  if (wanted.size === 0) return false;
  return [app.bundle, app.name, app.exe].some((name) => !!name && wanted.has(normalize(name)));
}

/** How an application is named in a refusal: what the agent can read back into the list. */
export function describeApp(app: AppIdentity | null): string {
  if (!app) return 'unknown';
  const detail = [app.bundle, app.exe].filter((part) => part && part !== app.name);
  return `${app.name || app.exe || app.bundle}${detail.length ? ` (${detail.join(', ')})` : ''}`;
}
