import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { BROWSER_HOST_EXIT, BROWSER_HOST_LAUNCH, writeHostMarker } from './browser-host.js';
import { runBrowserHost, type BrowserHostSeams } from './browser-host-shell.js';
import { startNativeBrowserServer } from './native-browser-server.js';

interface Harness {
  seams: BrowserHostSeams;
  home: string;
  exits: number[];
  lines: string[];
  errors: string[];
  execs: Array<{ file: string; args: string[] }>;
  calls: string[];
  locks: unknown[];
  signal(name: 'SIGTERM' | 'SIGINT'): void;
  secondInstance(data: unknown): void;
  quitRequest(): boolean;
  exited: Promise<number>;
}

function harness(overrides: Partial<BrowserHostSeams> = {}, lockAnswers: boolean[] = [true]): Harness {
  const home = mkdtempSync(join(tmpdir(), 'timon-browser-host-shell-'));
  const exits: number[] = [];
  const lines: string[] = [];
  const errors: string[] = [];
  const execs: Array<{ file: string; args: string[] }> = [];
  const calls: string[] = [];
  const locks: unknown[] = [];
  const signals = new Map<string, () => void>();
  let secondInstance: (data: unknown) => void = () => {};
  let quit: (prevent: () => void) => void = () => {};
  let exited!: (code: number) => void;
  const exitedPromise = new Promise<number>(resolve => { exited = resolve; });
  const seams: BrowserHostSeams = {
    // The second start, after the headless relaunch.
    platform: 'linux', argv: ['/opt/Timon/timon-desktop', '--browser-host', '--ozone-platform=headless'], env: {}, pid: 4242,
    execPath: '/opt/Timon/timon-desktop',
    execve: (file, args) => { execs.push({ file, args }); },
    ozonePlatform: () => 'headless',
    setUserData: (path) => { calls.push(`userData:${path}`); },
    requestLock: (data) => { locks.push(data); return lockAnswers.length > 1 ? lockAnswers.shift()! : lockAnswers[0]!; },
    whenReady: async () => { calls.push('ready'); },
    keepRunningWithoutWindows: () => { calls.push('keep-running'); },
    onSecondInstance: (listener) => { secondInstance = listener; },
    onQuitRequest: (listener) => { quit = listener; },
    onSignal: (signal, listener) => { signals.set(signal, listener); },
    exit: (code) => { exits.push(code); exited(code); },
    resolveHome: () => home,
    installLog: () => { calls.push('log'); },
    start: async (dir, headless) => {
      calls.push(`start:${headless ? 'headless' : 'windowed'}`);
      return startNativeBrowserServer(dir, async () => ({ ok: true }));
    },
    measureText: async () => 44,
    sleep: async () => {},
    log: (line) => { lines.push(line); },
    error: (line) => { errors.push(line); },
    ...overrides,
  };
  return {
    seams, home, exits, lines, errors, execs, calls, locks,
    signal: (name) => signals.get(name)!(),
    secondInstance: (data) => secondInstance(data),
    quitRequest: () => { let prevented = false; quit(() => { prevented = true; }); return prevented; },
    exited: exitedPromise,
  };
}

const provider = (home: string): string => join(home, 'browser-native', 'provider.json');
const marker = (home: string): string => join(home, 'browser-native', 'browser-host.json');

test('on macOS and Windows the host refuses to start, with a code that tells its service not to retry', async () => {
  for (const platform of ['darwin', 'win32'] as const) {
    const h = harness({ platform });
    try {
      await runBrowserHost(h.seams);
      assert.deepEqual(h.exits, [BROWSER_HOST_EXIT.unsupported]);
      assert.match(h.errors[0]!, /Linux only/);
      assert.deepEqual(h.calls, [], 'nothing of the browser starts');
      assert.equal(existsSync(provider(h.home)), false);
    } finally { rmSync(h.home, { recursive: true, force: true }); }
  }
});

test('with no graphical session the host replaces itself with a headless start before anything else', async () => {
  const h = harness({ argv: ['/opt/Timon/timon-desktop', '--browser-host'] });
  try {
    await runBrowserHost(h.seams);
    assert.deepEqual(h.execs, [{ file: '/opt/Timon/timon-desktop',
      args: ['/opt/Timon/timon-desktop', '--browser-host', '--ozone-platform=headless', '--ozone-override-screen-size=1920,1080'] }]);
    assert.deepEqual(h.calls, []);
    assert.deepEqual(h.locks, []);
  } finally { rmSync(h.home, { recursive: true, force: true }); }
});

test('the host writes provider.json like the app, and SIGTERM removes it with its marker before exiting 0', async () => {
  const h = harness();
  try {
    await runBrowserHost(h.seams);
    assert.deepEqual(h.calls, [`userData:${join(h.home, 'desktop-profile')}`, 'keep-running', 'log', 'ready', 'start:headless']);
    assert.deepEqual(h.locks, [BROWSER_HOST_LAUNCH], 'the application tells the host lock request from its own launches');
    const descriptor = JSON.parse(readFileSync(provider(h.home), 'utf8')) as { origin: string; token: string };
    assert.match(descriptor.origin, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.equal(JSON.parse(readFileSync(marker(h.home), 'utf8')).pid, 4242);
    const answer = await fetch(`${descriptor.origin}/command`, { method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${descriptor.token}` }, body: '{"action":"status"}' });
    assert.deepEqual(await answer.json(), { ok: true });
    h.signal('SIGTERM');
    assert.equal(await h.exited, BROWSER_HOST_EXIT.stopped);
    assert.equal(existsSync(provider(h.home)), false);
    assert.equal(existsSync(marker(h.home)), false);
    assert.equal(h.quitRequest(), true, "Chromium's own quit on a signal is held: the stop already runs");
    assert.deepEqual(h.exits, [0], 'one exit, however many stop requests');
  } finally { rmSync(h.home, { recursive: true, force: true }); }
});

test('the application opening on the home makes the host close its provider and exit with the "yielded" code', async () => {
  const h = harness();
  try {
    await runBrowserHost(h.seams);
    h.secondInstance(BROWSER_HOST_LAUNCH);
    assert.deepEqual(h.exits, [], 'another host waiting for the home changes nothing');
    assert.equal(existsSync(provider(h.home)), true);
    h.secondInstance({ build: '0.1.11' });
    assert.equal(await h.exited, BROWSER_HOST_EXIT.yielded);
    assert.equal(existsSync(provider(h.home)), false, 'only the application writes provider.json from now on');
    assert.equal(existsSync(marker(h.home)), false);
  } finally { rmSync(h.home, { recursive: true, force: true }); }
});

test('the host waits while the application holds the home, then serves', async () => {
  const h = harness({}, [false, false, true]);
  try {
    await runBrowserHost(h.seams);
    assert.equal(h.locks.length, 3);
    assert.match(h.lines.join('\n'), /waiting for it to quit/);
    assert.equal(existsSync(provider(h.home)), true);
    h.signal('SIGINT');
    assert.equal(await h.exited, 0);
  } finally { rmSync(h.home, { recursive: true, force: true }); }
});

test('a signal while the host waits ends it without starting anything', async () => {
  let stop!: () => void;
  const h = harness({ sleep: async () => { stop(); } }, [false]);
  stop = () => h.signal('SIGTERM');
  try {
    await runBrowserHost(h.seams);
    assert.equal(await h.exited, 0);
    assert.equal(h.calls.includes('ready'), false);
    assert.equal(existsSync(provider(h.home)), false);
  } finally { rmSync(h.home, { recursive: true, force: true }); }
});

test('a stop that comes while the provider starts waits for it and closes what started', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const h = harness({
    start: async (dir) => { await gate; return startNativeBrowserServer(dir, async () => ({})); },
  });
  try {
    const run = runBrowserHost(h.seams);
    await new Promise(resolve => setImmediate(resolve));
    h.signal('SIGTERM');
    assert.deepEqual(h.exits, [], 'no exit before the provider it waits for');
    release();
    await run;
    assert.equal(await h.exited, 0);
    assert.equal(existsSync(provider(h.home)), false);
  } finally { rmSync(h.home, { recursive: true, force: true }); }
});

test('a provider that cannot start ends the host with the failure code and no marker', async () => {
  const h = harness({ start: async () => { throw new Error('no engine'); } });
  try {
    await runBrowserHost(h.seams);
    assert.equal(await h.exited, BROWSER_HOST_EXIT.failed);
    assert.match(h.errors.join('\n'), /could not start/);
    assert.equal(existsSync(marker(h.home)), false);
  } finally { rmSync(h.home, { recursive: true, force: true }); }
});

test('a crashed host leaves a marker and a provider.json that the next start replaces', async () => {
  const h = harness();
  try {
    writeHostMarker(h.home, 1111, 0);
    const stale = await startNativeBrowserServer(h.home, async () => ({}));
    const staleToken = stale.descriptor.token;
    await runBrowserHost(h.seams);
    assert.notEqual(JSON.parse(readFileSync(provider(h.home), 'utf8')).token, staleToken);
    assert.equal(JSON.parse(readFileSync(marker(h.home), 'utf8')).pid, 4242);
    await stale.close();
    assert.equal(existsSync(provider(h.home)), true, "the stale provider's close leaves the new descriptor");
    h.signal('SIGTERM');
    await h.exited;
  } finally { rmSync(h.home, { recursive: true, force: true }); }
});

test('a system with no font is said at start, with what to install; one with fonts says nothing', async () => {
  for (const [width, warned] of [[0, true], [44, false]] as const) {
    const h = harness({ measureText: async () => width });
    try {
      await runBrowserHost(h.seams);
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(h.errors.some(line => /no font is installed.*fonts-noto-core/.test(line)), warned);
      h.signal('SIGTERM');
      await h.exited;
    } finally { rmSync(h.home, { recursive: true, force: true }); }
  }
});

const SRC = dirname(fileURLToPath(import.meta.url));

/** Every module of this folder `entry` loads, its static and dynamic relative imports followed. */
function localImports(entry: string): Set<string> {
  const seen = new Set<string>();
  const pending = [entry];
  while (pending.length) {
    const name = pending.pop()!;
    if (seen.has(name)) continue;
    seen.add(name);
    const { importedFiles } = ts.preProcessFile(readFileSync(join(SRC, name), 'utf8'), true, true);
    for (const { fileName } of importedFiles) {
      if (fileName.startsWith('./')) pending.push(fileName.slice(2).replace(/\.c?js$/, (ext) => ext === '.cjs' ? '.cts' : '.ts'));
    }
  }
  return seen;
}

// Computer use drives the desktop of the person in front of the screen; a browser host has neither.
test('the browser host never starts computer use: none of its modules loads it, and its branch of main.ts runs the host alone', async () => {
  for (const entry of ['browser-host-shell.ts', 'browser-host-electron.ts', 'browser-host.ts']) {
    const reached = [...localImports(entry)].filter((name) => name.startsWith('computer-use'));
    assert.deepEqual(reached, [], `${entry} reaches ${reached.join(', ')}`);
  }

  const source = ts.createSourceFile('main.ts', readFileSync(join(SRC, 'main.ts'), 'utf8'), ts.ScriptTarget.ES2022, true);
  const isHostTest = (node: ts.Expression): boolean => ts.isCallExpression(node) && node.expression.getText(source) === 'browserHostRequested';
  let hostBranch: ts.Statement | undefined;
  const visit = (node: ts.Node): void => {
    if (ts.isIfStatement(node) && isHostTest(node.expression)) hostBranch = node.thenStatement;
    else if (ts.isIfStatement(node)) { visit(node.expression); visit(node.thenStatement); if (node.elseStatement) visit(node.elseStatement); }
  };
  source.statements.forEach(visit);
  assert.ok(hostBranch, 'main.ts dispatches --browser-host at the top level');

  // Every start of computer use lies in main(), which only the application with a screen calls.
  const starts: string[] = [];
  const enclosing = (node: ts.Node): string => {
    for (let at: ts.Node | undefined = node.parent; at; at = at.parent) {
      if (ts.isFunctionDeclaration(at) && at.name) return at.name.text;
    }
    return '<top level>';
  };
  const collect = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.expression.getText(source) === 'startComputerUse') starts.push(enclosing(node));
    ts.forEachChild(node, collect);
  };
  collect(source);
  assert.deepEqual(starts, ['main']);

  const calls: string[] = [];
  const branch = ts.transpileModule(hostBranch!.getText(source), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  runInNewContext(branch, {
    runBrowserHost: async () => { calls.push('host'); },
    electronBrowserHostSeams: () => ({}),
    startComputerUse: () => { calls.push('computer use'); },
    main: () => { calls.push('application'); },
    startShell: () => { calls.push('application'); },
    app: { exit: () => {} }, BROWSER_HOST_EXIT: { failed: 1 }, console,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ['host']);
});
