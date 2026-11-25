import { accessSync, constants, openSync, readSync, closeSync, statSync } from 'node:fs';
import { posix, win32 } from 'node:path';

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
   * Locates `node` beyond PATH (the adapter's candidate folders), called only
   * when no PATH folder holds one. `null` = none on this machine.
   */
  findNode?: () => string | null;
  /**
   * The Node the daemon itself runs on (`daemonNode`), tried last when the
   * machine shows none: the one a desktop package ships, or the one a source
   * install was started with. `null` = the daemon is not on a Node.
   */
  runtimeNode?: string | null;
  /** The runtime to refuse as a `node`: Electron's binary runs as Node only with ELECTRON_RUN_AS_NODE. */
  selfExecutable?: string;
  /** Whether `dir` holds an executable `node`; injectable for tests. */
  hasNode?: (dir: string, platform: NodeJS.Platform) => boolean;
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
 * `path` with what a Node CLI needs: the folder of `binary` first when it is not
 * listed (npm, nvm and Volta put `node` beside the CLIs they install), then the
 * folder of a `node` found elsewhere, last, when still no folder holds one:
 * the machine's own first, the daemon's runtime when the machine has none.
 */
export function launchPath(path: string, opts: LaunchPathOptions): string {
  const { platform } = opts;
  const dirs = path.split(delimiterOf(platform)).filter(Boolean);
  const listed = (dir: string) => dirs.some((entry) => sameDir(entry, dir, platform));
  const out = [...dirs];
  if (opts.binary && isAbsoluteFor(opts.binary, platform)) {
    const dir = pathModule(platform).dirname(opts.binary);
    if (!listed(dir)) out.unshift(dir);
  }
  const hasNode = opts.hasNode ?? nodeInDir;
  if ((opts.findNode || opts.runtimeNode) && !out.some((dir) => hasNode(dir, platform))) {
    const self = opts.selfExecutable;
    const usable = (file: string | null | undefined): file is string =>
      !!file && isAbsoluteFor(file, platform) && !(self && sameDir(file, self, platform));
    const found = opts.findNode?.();
    const node = usable(found) ? found : usable(opts.runtimeNode) ? opts.runtimeNode : null;
    if (node) {
      const dir = pathModule(platform).dirname(node);
      if (!out.some((entry) => sameDir(entry, dir, platform))) out.push(dir);
    }
  }
  return out.join(delimiterOf(platform));
}

export type NodeRuntimeFacts = {
  execPath: string;
  /** `process.versions.electron`: set, the runtime is Electron, which is no `node`. */
  electron?: string | undefined;
  platform: NodeJS.Platform;
};

/**
 * The daemon's own runtime when it is a Node a CLI can run on: since 0.1.6 a
 * desktop package runs its daemon on the Node it ships
 * (`resources/node/node[.exe]`), and a source install runs on the Node it was
 * started with. The fence already opens that runtime to the mission, whose
 * Timon MCP servers start with it. Electron is never one: its binary runs as
 * Node only with `ELECTRON_RUN_AS_NODE`, which the package's fuse turns off.
 * Only a file named `node` helps: `#!/usr/bin/env node` looks for that name.
 */
export function daemonNode(runtime: NodeRuntimeFacts = {
  execPath: process.execPath, electron: process.versions.electron, platform: process.platform,
}): string | null {
  if (runtime.electron) return null;
  const path = pathModule(runtime.platform);
  if (!path.isAbsolute(runtime.execPath)) return null;
  const name = path.basename(runtime.execPath);
  return (runtime.platform === 'win32' ? /^node\.exe$/i : /^node$/).test(name) ? runtime.execPath : null;
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

export type NodelessBackend = { name: string; path: string };

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
  },
): NodelessBackend[] {
  const hasNode = opts.hasNode ?? nodeInDir;
  let node: string | null | undefined;
  return names.flatMap((name) => {
    const path = opts.resolve(name);
    if (!path || !runsOnNode(path, opts.platform, opts.read)) return [];
    node ??= opts.resolve('node') ?? opts.runtimeNode ?? null;
    if (node || hasNode(pathModule(opts.platform).dirname(path), opts.platform)) return [];
    return [{ name, path }];
  });
}

/** The sentence both diagnostics print for one such CLI. */
export function nodelessBackendText(backend: NodelessBackend): string {
  return `${backend.name} (${backend.path}) runs on Node.js, which Timon cannot find: its missions fail with `
    + '"env: node: No such file or directory". Install Node.js system-wide (your package manager, or nodejs.org), '
    + 'or set host.binaries.node in timon.config.json to the path `node -p process.execPath` prints in your terminal, '
    + 'then restart Timon.';
}
