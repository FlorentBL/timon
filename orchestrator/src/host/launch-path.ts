import { accessSync, constants, openSync, readSync, closeSync, realpathSync, statSync } from 'node:fs';
import { posix, win32 } from 'node:path';
import { untrustedPathProblem } from './trusted-tree.js';

/**
 * The PATH a backend CLI is launched with.
 *
 * `binary-path.ts` finds a CLI where a service never looks (nvm, Volta, an npm
 * prefix, `%APPDATA%\npm`), yet the process still received the service's PATH.
 * An npm CLI is a `#!/usr/bin/env node` script (a `.cmd` shim calling `node` on
 * Windows), and Timon's own MCP servers are started as `node <script>` by the
 * CLI: neither runs if `node` is not on that PATH (macOS tester report,
 * 0.1.6-rc.1, 26/10/2026 — `env: node: No such file or directory`, then
 * `mcp__timon_ask__request ... not found`).
 */
export type LaunchPathOptions = {
  platform: NodeJS.Platform;
  /** The resolved binary about to run: its folder goes first when PATH lacks it. */
  binary?: string | null;
  /**
   * The `node` chosen on the host side (`chooseLaunchNode`), whatever the PATH
   * being completed holds: its folder goes ahead of the first one a child's
   * `node` could come from unchecked. `null` = none on this machine.
   */
  node?: string | null;
  /** Whether `dir` holds an executable `node`; injectable for tests. */
  hasNode?: (dir: string, platform: NodeJS.Platform) => boolean;
  /**
   * Whether the `node` file of a PATH folder may stand: not the daemon's own
   * runtime once its check fails (`checkDaemonNode`). Injectable for tests.
   */
  nodeStands?: (file: string) => boolean;
};

function pathModule(platform: NodeJS.Platform): typeof posix {
  return platform === 'win32' ? win32 : posix;
}

function delimiterOf(platform: NodeJS.Platform): string {
  return platform === 'win32' ? ';' : ':';
}

/** Windows folders compare without case or trailing separator; elsewhere, exactly but for the trailing one. */
function sameDir(a: string, b: string, platform: NodeJS.Platform): boolean {
  const path = pathModule(platform);
  const norm = (dir: string) => {
    const resolved = path.normalize(dir).replace(/[\\/]+$/, '');
    return platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  return norm(a) === norm(b);
}

function isAbsoluteFor(file: string, platform: NodeJS.Platform): boolean {
  return pathModule(platform).isAbsolute(file);
}

export function nodeInDir(dir: string, platform: NodeJS.Platform): boolean {
  const path = pathModule(platform);
  for (const ext of platform === 'win32' ? ['.exe', '.cmd', ''] : ['']) {
    const file = path.join(dir, `node${ext}`);
    try {
      if (!statSync(file).isFile()) continue;
      accessSync(file, platform === 'win32' ? constants.F_OK : constants.X_OK);
      return true;
    } catch { /* next */ }
  }
  return false;
}

/**
 * `path` with what a Node CLI needs: the folder of `binary` first when it is
 * not listed (npm, nvm and Volta put `node` beside the CLIs they install), then
 * the folder of the chosen `node`, ahead of the first entry a child process's
 * `node` could come from without the host's checks: a relative entry (read
 * against the mission's folder, which it writes), or an absolute one whose
 * `node` is the daemon's runtime and no longer passes its check. A sound
 * absolute folder holding a `node` before those is the mission's own choice
 * for its children and is left first. The CLI itself never relies on this
 * lookup: it is started with the chosen interpreter (`nodeInterpreter`).
 */
export function launchPath(path: string, opts: LaunchPathOptions): string {
  const { platform } = opts;
  const join = pathModule(platform).join;
  const dirs = path.split(delimiterOf(platform)).filter(Boolean);
  const listed = (dir: string) => dirs.some((entry) => sameDir(entry, dir, platform));
  const out = [...dirs];
  if (opts.binary && isAbsoluteFor(opts.binary, platform)) {
    const dir = pathModule(platform).dirname(opts.binary);
    if (!listed(dir)) out.unshift(dir);
  }
  if (!opts.node || !isAbsoluteFor(opts.node, platform)) return out.join(delimiterOf(platform));
  const hasNode = opts.hasNode ?? nodeInDir;
  let runtimeOk: boolean | undefined;
  const stands = opts.nodeStands ?? ((file: string) =>
    !designatesDaemonRuntime(file, platform) || (runtimeOk ??= checkDaemonNode().node !== null));
  const nodeFile = platform === 'win32' ? 'node.exe' : 'node';
  const first = out.findIndex((dir) => !isAbsoluteFor(dir, platform) || hasNode(dir, platform));
  const entry = first >= 0 ? out[first]! : null;
  if (entry && isAbsoluteFor(entry, platform) && stands(join(entry, nodeFile))) return out.join(delimiterOf(platform));
  const dir = pathModule(platform).dirname(opts.node);
  if (first >= 0) out.splice(first, 0, dir);
  else if (!out.some((listedDir) => sameDir(listedDir, dir, platform))) out.push(dir);
  return out.join(delimiterOf(platform));
}

export type NodeChoiceOptions = {
  platform: NodeJS.Platform;
  /**
   * The host's own search (`host.bin('node')`): its pin, the daemon's PATH and
   * the folders it knows, never the PATH a mission sets. `null` = none.
   */
  findNode?: () => string | null;
  /** The runtime to refuse as a `node`: Electron's binary runs as Node only with ELECTRON_RUN_AS_NODE. */
  selfExecutable?: string | undefined;
  /** The daemon's runtime as `checkDaemonNode` reports it; read once, when needed, by default. */
  runtime?: () => DaemonNodeCheck;
  /** Whether a file is the daemon's runtime; `designatesDaemonRuntime` by default. */
  isRuntime?: (file: string) => boolean;
};

/**
 * The `node` a CLI is started with, chosen on the host side (#1102, security
 * review): the machine's own, else the daemon's runtime. Whichever way the
 * daemon's runtime comes (as the last resort, or as what the search found:
 * `/usr/bin/node` for a daemon run from sources), it stands only once
 * `checkDaemonNode` passes it, and the path returned is the one it checked.
 */
export function chooseLaunchNode(opts: NodeChoiceOptions): string | null {
  const { platform } = opts;
  const self = opts.selfExecutable;
  const usable = (file: string | null | undefined): file is string =>
    !!file && isAbsoluteFor(file, platform) && !(self && sameDir(file, self, platform));
  const isRuntime = opts.isRuntime ?? ((file: string) => designatesDaemonRuntime(file, platform));
  let found: string | null = null;
  try { found = opts.findNode?.() ?? null; } catch { found = null; }
  if (usable(found) && !isRuntime(found)) return found;
  const own = (opts.runtime ?? (() => checkDaemonNode()))().node;
  return usable(own) ? own : null;
}

export type NodeRuntimeFacts = {
  execPath: string;
  /** `process.versions.electron`: set, the runtime is Electron, which is no `node`. */
  electron?: string | undefined;
  platform: NodeJS.Platform;
};

/** What tells one file from its replacement at the same path. */
export type FileIdentity = { dev: number; ino: number; size: number; mtimeMs: number };

/**
 * Why the daemon's runtime, a Node when the daemon started, can no longer stand
 * in for one. `unverified`: its identity could not be read at startup, and its
 * folders do not prove who put it there.
 */
export type DaemonNodeProblem = 'missing' | 'not-executable' | 'not-node' | 'replaced' | 'unverified';

export type DaemonNodeCheck =
  | { node: string; problem: null }
  /** `problem: null`: the daemon does not run on a Node at all (Electron, a `nodejs` binary). */
  | { node: null; problem: DaemonNodeProblem | null };

export type DaemonNodeDeps = {
  realpath?: (file: string) => string;
  stat?: (file: string) => FileIdentity & { isFile(): boolean };
  executable?: (file: string, platform: NodeJS.Platform) => boolean;
  /** The runtime's identity when the daemon started; `null` = unknown, which proves nothing. */
  startup?: FileIdentity | null;
  /** Whether only root or the daemon's account can have put a file there; `untrustedPathProblem` by default. */
  soundTree?: (file: string) => boolean;
};

function currentRuntime(): NodeRuntimeFacts {
  return { execPath: process.execPath, electron: process.versions.electron, platform: process.platform };
}

function identityOf(stat: FileIdentity): FileIdentity {
  return { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs };
}

function isExecutable(file: string, platform: NodeJS.Platform): boolean {
  try { accessSync(file, platform === 'win32' ? constants.F_OK : constants.X_OK); return true; } catch { return false; }
}

function nodeNamed(file: string, platform: NodeJS.Platform): boolean {
  return (platform === 'win32' ? /^node\.exe$/i : /^node$/).test(pathModule(platform).basename(file));
}

/** The file this process was started from, as it was then: a later replacement must not inherit its trust. */
const STARTUP: { real: string; identity: FileIdentity } | null = (() => {
  try {
    const real = realpathSync(process.execPath);
    return { real, identity: identityOf(statSync(real)) };
  } catch { return null; }
})();

function sameIdentity(a: FileIdentity, b: FileIdentity): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs;
}

/**
 * Whether `file` is the daemon's own runtime: the path it was started from, the
 * file that path led to then, or the one it leads to now. Such a file is the
 * runtime however it was found, and only `checkDaemonNode` may let it stand.
 */
export function designatesDaemonRuntime(
  file: string,
  platform: NodeJS.Platform = process.platform,
  deps: { execPath?: string; startupReal?: string | null; realpath?: (file: string) => string } = {},
): boolean {
  const realpath = deps.realpath ?? realpathSync;
  const execPath = deps.execPath ?? process.execPath;
  const startupReal = 'startupReal' in deps ? deps.startupReal : STARTUP?.real;
  const known = [execPath, ...(startupReal ? [startupReal] : [])];
  try { known.push(realpath(execPath)); } catch { /* gone: the other two still name it */ }
  const forms = [file];
  try { forms.push(realpath(file)); } catch { /* compared as written */ }
  return forms.some((form) => known.some((own) => sameDir(form, own, platform)));
}

/**
 * Whether only root or the daemon's account can have put `file` where it is,
 * checked up to `/` (`trusted-tree.ts`). Never on Windows, whose ACLs are not
 * read, nor for another OS than this one.
 */
function soundTree(platform: NodeJS.Platform): (file: string) => boolean {
  return (file) => platform !== 'win32' && platform === process.platform && untrustedPathProblem(file, { platform }) === null;
}

/**
 * The daemon's own runtime when it is a Node a CLI can run on, checked on
 * disk right before each launch (#1102, security review): since 0.1.6 a
 * desktop package runs its daemon on the Node it ships
 * (`resources/node/node[.exe]`), and a source install runs on the Node it was
 * started with. The fence already opens that runtime to the mission, whose
 * Timon MCP servers start with it. Electron is never one: its binary runs as
 * Node only with `ELECTRON_RUN_AS_NODE`, which the package's fuse turns off.
 *
 * What the process was started from says nothing of the file now at that
 * path: it must still exist, be executable, be named `node` once its links are
 * resolved (`#!/usr/bin/env node` looks for that name, and a link to the
 * Electron binary resolves to another one), and be the very file the daemon
 * started from. When that identity was never captured, or no longer matches,
 * the file stands only if root or the daemon's account alone could have put it
 * there (a `/usr/bin/node` the system's package manager upgraded): a package's
 * folder an administrator group can write, or any Windows install, gets refused
 * until Timon restarts. The resolved path is the one returned: the CLI runs that file.
 */
export function checkDaemonNode(runtime?: NodeRuntimeFacts, deps: DaemonNodeDeps = {}): DaemonNodeCheck {
  const facts = runtime ?? currentRuntime();
  const none = { node: null, problem: null } as const;
  if (facts.electron) return none;
  const path = pathModule(facts.platform);
  if (!path.isAbsolute(facts.execPath) || !nodeNamed(facts.execPath, facts.platform)) return none;
  const realpath = deps.realpath ?? realpathSync;
  const stat = deps.stat ?? statSync;
  const executable = deps.executable ?? isExecutable;
  const sound = deps.soundTree ?? soundTree(facts.platform);
  // Another runtime than this process's own has no startup identity to compare with.
  const startup = 'startup' in deps ? deps.startup ?? null : runtime ? null : STARTUP?.identity ?? null;
  let real: string;
  let info: FileIdentity & { isFile(): boolean };
  try {
    real = realpath(facts.execPath);
    info = stat(real);
  } catch {
    return { node: null, problem: 'missing' };
  }
  if (!info.isFile()) return { node: null, problem: 'missing' };
  const same = startup !== null && sameIdentity(identityOf(info), startup);
  if (!same && !sound(real)) return { node: null, problem: startup ? 'replaced' : 'unverified' };
  if (!path.isAbsolute(real) || !nodeNamed(real, facts.platform)) {
    // The same file as at startup was never one by name (`node` linked to `nodejs`): nothing changed to report.
    return { node: null, problem: same ? null : 'not-node' };
  }
  if (!executable(real, facts.platform)) return { node: null, problem: 'not-executable' };
  return { node: real, problem: null };
}

/** `checkDaemonNode`'s path: the daemon's Node as it may run a CLI now, or `null`. */
export function daemonNode(runtime?: NodeRuntimeFacts, deps?: DaemonNodeDeps): string | null {
  return checkDaemonNode(runtime, deps).node;
}

/** The key holding PATH: Windows keeps the case it was read with (`Path`), and two spellings would be two variables. */
export function pathKeyOf(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
  if (platform !== 'win32') return 'PATH';
  // The last spelling: layers are spread least to most specific, so it is the one that won.
  return Object.keys(env).filter((key) => key.toUpperCase() === 'PATH').pop() ?? 'PATH';
}

/** `env` with its PATH completed by `launchPath`, the same object when nothing changes. */
export function withLaunchPath(env: NodeJS.ProcessEnv, opts: LaunchPathOptions): NodeJS.ProcessEnv {
  const key = pathKeyOf(env, opts.platform);
  const current = env[key] ?? '';
  const next = launchPath(current, opts);
  if (next === current) return env;
  const out: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(env)) {
    // Any other spelling of PATH would shadow the one written below on Windows.
    if (opts.platform === 'win32' && name !== key && name.toUpperCase() === 'PATH') continue;
    out[name] = value;
  }
  out[key] = next;
  return out;
}

/**
 * Whether `file` runs on Node: a `#!...node` script, or on Windows the
 * `.cmd`/`.ps1` shim npm writes, which calls `node`. A native binary reads as `false`.
 */
export function runsOnNode(file: string, platform: NodeJS.Platform, read: (file: string) => string = readHead): boolean {
  let head: string;
  try { head = read(file); } catch { return false; }
  if (head.startsWith('#!')) return /\bnode(\.exe)?\b/.test(head.split(/\r?\n/, 1)[0] ?? '');
  if (platform === 'win32' && /\.(cmd|bat|ps1)$/i.test(file)) return /\bnode(\.exe)?\b/i.test(head);
  return false;
}

function readHead(file: string): string {
  const fd = openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(1024);
    const length = readSync(fd, buffer, 0, buffer.length, 0);
    return buffer.subarray(0, length).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

export type NodelessBackend = {
  name: string;
  path: string;
  /** Why the daemon's own Node, which would have stood in, no longer can. */
  runtimeProblem?: DaemonNodeProblem;
};

/**
 * The CLIs among `names` that are found, run on Node, and would get no `node`
 * at launch: neither beside them nor anywhere the binary search looks. What
 * `timon doctor` and the diagnostic report name, since such a CLI is
 * "resolved" and still cannot start a single mission.
 */
export function nodelessBackends(
  names: readonly string[],
  opts: {
    platform: NodeJS.Platform;
    /** Resolution as the host adapter does it (pin, then search); `null` when absent. */
    resolve: (name: string) => string | null;
    read?: (file: string) => string;
    hasNode?: (dir: string, platform: NodeJS.Platform) => boolean;
    /** The daemon's own Node (`daemonNode`), which a launch falls back on. */
    runtimeNode?: string | null;
    /** Why that Node is missing when the daemon started on one (`checkDaemonNode`). */
    runtimeProblem?: DaemonNodeProblem | null;
    /** Whether a file is the daemon's runtime, which only `runtimeNode` vouches for; `designatesDaemonRuntime` by default. */
    isRuntime?: (file: string) => boolean;
  },
): NodelessBackend[] {
  const hasNode = opts.hasNode ?? nodeInDir;
  const isRuntime = opts.isRuntime ?? ((file: string) => designatesDaemonRuntime(file, opts.platform));
  let node: string | null | undefined;
  return names.flatMap((name) => {
    const path = opts.resolve(name);
    if (!path || !runsOnNode(path, opts.platform, opts.read)) return [];
    // As a launch chooses it (`chooseLaunchNode`): the runtime found by the search stands only once checked.
    const found = opts.resolve('node');
    node ??= (found && !isRuntime(found) ? found : null) ?? opts.runtimeNode ?? null;
    if (node || hasNode(pathModule(opts.platform).dirname(path), opts.platform)) return [];
    return [opts.runtimeProblem ? { name, path, runtimeProblem: opts.runtimeProblem } : { name, path }];
  });
}

/** The sentence both diagnostics print for one such CLI. */
export function nodelessBackendText(backend: NodelessBackend): string {
  const text = `${backend.name} (${backend.path}) runs on Node.js, which Timon cannot find: its missions fail with `
    + '"env: node: No such file or directory". Install Node.js system-wide (your package manager, or nodejs.org), '
    + 'or set host.binaries.node in timon.config.json to the path `node -p process.execPath` prints in your terminal, '
    + 'then restart Timon.';
  if (!backend.runtimeProblem) return text;
  if (backend.runtimeProblem === 'unverified') {
    return `${text} The Node.js Timon itself runs on could not be identified when it started, `
      + 'so it cannot stand in for one until Timon restarts.';
  }
  return `${text} The Node.js Timon itself started on was removed, replaced or made non-executable since, `
    + 'so it cannot stand in for one until Timon restarts.';
}
