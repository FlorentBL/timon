/**
 * `killProcessTree`: the signal always reaches the child, and a child that is
 * already gone is not an error. On Windows it reaches the root after `taskkill`
 * has answered, or after a limit. `stopProcessGroup` never signals a group it has
 * no number for. `execTree`: the answer comes when the program exits, and nothing
 * it left in its group outlives the call.
 */
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-kill-tree-'));
const {
  EXEC_TREE_MARK, cleanupReserve, environHoldsEntry, execTree, killProcessTree, markedPidsFromPs, setExecScopeForTest,
  stopProcessGroup, sweepWindowsOrphans, windowsOrphanSweepScript,
} = await import('./kill-tree.js');
const { getHost } = await import('./index.js');
type ExecResult = import('./types.js').ExecResult;

function child(onKill: (signal: string) => void, pid?: number): ChildProcess {
  return { pid, exitCode: null, signalCode: null, kill: (signal: string) => { onKill(signal); return true; } } as unknown as ChildProcess;
}

const posix = process.platform !== 'win32';
const dir = mkdtempSync(join(tmpdir(), 'timon-exec-tree-'));
process.on('exit', () => rmSync(dir, { recursive: true, force: true }));

function stub(name: string, body: string): string {
  const file = join(dir, name);
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
  return file;
}

const LIMITS = { timeout: 5_000, maxBuffer: 64 * 1024 };

/** Gone, or a zombie nobody reaped yet: either way it runs nothing any more. */
function running(pid: number): boolean {
  try { process.kill(pid, 0); } catch { return false; }
  if (process.platform !== 'linux') return true;
  // portability: Linux pseudo-fs, behind the platform guard above
  try { return !/^\d+ \(.*\) Z /s.test(readFileSync(`/proc/${pid}/stat`, 'utf8')); } catch { return false; }
}

async function stopsRunning(pid: number, withinMs = 2_000): Promise<boolean> {
  for (const end = Date.now() + withinMs; Date.now() < end; await new Promise((r) => { setTimeout(r, 20); })) {
    if (!running(pid)) return true;
  }
  return !running(pid);
}

function readPid(file: string): number {
  const pid = Number(readFileSync(file, 'utf8').trim());
  assert.ok(Number.isInteger(pid) && pid > 1, `no usable pid in ${file}`);
  return pid;
}

function cleanUp(pid: number): void {
  if (pid > 1) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone, as it should be */ } }
}

test('no group is signalled without a number that is really a group', (t) => {
  const kill = t.mock.method(process, 'kill', () => true);
  for (const pid of [undefined, 0, 1]) {
    const signals: string[] = [];
    stopProcessGroup(child((signal) => signals.push(signal), pid), 'SIGKILL', 'linux');
    assert.deepEqual(signals, ['SIGTERM'], `pid ${pid} falls back on the child`);
  }
  assert.equal(kill.mock.callCount(), 0, 'process.kill(0) would hit this process, process.kill(-1) every process');
  stopProcessGroup(child(() => assert.fail('the group took it'), 4242), 'SIGKILL', 'linux');
  assert.deepEqual(kill.mock.calls.map((c) => c.arguments), [[-4242, 'SIGKILL']]);
});

test('a group already gone falls back on the child, and Windows never signals a group', (t) => {
  const kill = t.mock.method(process, 'kill', () => { throw new Error('ESRCH'); });
  const signals: string[] = [];
  assert.doesNotThrow(() => stopProcessGroup(child((signal) => signals.push(signal), 4242), 'SIGKILL', 'linux'));
  assert.deepEqual(signals, ['SIGTERM']);
  assert.equal(kill.mock.callCount(), 1);
  kill.mock.resetCalls();
  stopProcessGroup(child(() => {}), 'SIGKILL', 'win32');
  assert.equal(kill.mock.callCount(), 0);
});

test('execTree reads like execAsync: exit code, both streams, env and cwd', { skip: !posix }, async () => {
  const file = stub('plain', 'echo "out $ASKED $PWD"; echo err >&2; exit 3');
  const result = await execTree(file, [], { ...LIMITS, env: { ASKED: 'yes', PATH: process.env.PATH ?? '' }, cwd: dir });
  assert.equal(result.code, 3);
  assert.match(result.stdout, /^out yes /);
  assert.equal(result.stderr, 'err\n');
  assert.equal(result.timedOut, undefined);
});

test('execTree rejects a binary that does not resolve, and answers one that cannot start', { skip: !posix }, async () => {
  await assert.rejects(execTree(join(dir, 'no-such-program'), [], LIMITS), /not found/);
  const broken = join(dir, 'broken');
  writeFileSync(broken, `#!${join(dir, 'no-such-interpreter')}\n`);
  chmodSync(broken, 0o755);
  // Through a scope, `env` is what says it, with its own code.
  const answer = await execTree(broken, [], LIMITS);
  assert.notEqual(answer.code, 0);
  assert.equal(answer.stdout, '');
});

test('a child left with its output elsewhere is ended too: nothing keeps the pipes open to tell', { skip: !posix }, async () => {
  const pidFile = join(dir, 'quiet-pid');
  const file = stub('quiet', `sleep 8 >/dev/null 2>&1 &\necho $! > "${pidFile}"\necho done`);
  const result = await execTree(file, [], LIMITS);
  const left = readPid(pidFile);
  try {
    assert.deepEqual(result, { code: 0, stdout: 'done\n', stderr: '' });
    assert.ok(await stopsRunning(left), `sleep ${left} survived`);
  } finally { cleanUp(left); }
});

/**
 * Whether this machine runs a launch in a transient scope: Linux with a user manager that accepts one. CI
 * has none, and takes the marked sweep both times below.
 */
const scopes = process.platform === 'linux'
  && spawnSync('systemd-run', ['--user', '--scope', '--quiet', '--collect', '--', 'true'], { stdio: 'ignore', timeout: 10_000 }).status === 0;

/**
 * A descendant that called `setsid()` left the group and the session: no group signal reaches it. Two
 * shapes: one that keeps the program's stdout (it would hold the answer), and a daemon that forks once
 * more and lets its parent exit, so that no parent pid leads to it any more. The test never ends them
 * itself before asserting: `cleanUp` only runs after a failed assertion.
 */
for (const way of ['scope', 'mark'] as const) {
  const skip = !posix ? 'POSIX only' : way === 'scope' && !scopes ? 'no user systemd manager that accepts a scope' : false;
  test(`a descendant that left the group and the session with setsid is ended too (${way})`, { skip }, async () => {
    setExecScopeForTest(way === 'scope' ? null : false);
    const heldPid = join(dir, `setsid-held-${way}`);
    const daemonPid = join(dir, `setsid-daemon-${way}`);
    const where = join(dir, `setsid-cgroup-${way}`);
    for (const file of [heldPid, daemonPid, where]) rmSync(file, { force: true });
    // `setsid` forks when it leads its group, so `sh -c` writes the pid that stays.
    const file = stub(`escapes-${way}`, [
      `setsid sh -c 'echo $$ > "${heldPid}"; exec sleep 8' &`,
      `setsid sh -c 'sleep 8 >/dev/null 2>&1 </dev/null & echo $! > "${daemonPid}"' </dev/null >/dev/null 2>&1`,
      `cat /proc/self/cgroup > "${where}" 2>/dev/null`,
      `while [ ! -s "${heldPid}" ] || [ ! -s "${daemonPid}" ]; do sleep 0.01; done`,
      'echo done',
    ].join('\n'));
    const started = Date.now();
    let held = 0;
    let daemon = 0;
    try {
      const result = await execTree(file, [], LIMITS);
      const took = Date.now() - started;
      held = readPid(heldPid);
      daemon = readPid(daemonPid);
      assert.equal(result.code, 0);
      assert.equal(result.stdout, 'done\n');
      assert.ok(took < 2_500, `returned after ${took} ms`);
      if (way === 'scope') assert.match(readFileSync(where, 'utf8'), /-exec-[0-9a-f]{8}\.scope$/m, 'the launch ran in a scope of its own');
      assert.ok(await stopsRunning(held), `setsid child ${held}, which held stdout, survived`);
      assert.ok(await stopsRunning(daemon), `double-forked daemon ${daemon} survived`);
    } finally {
      setExecScopeForTest(null);
      cleanUp(held);
      cleanUp(daemon);
    }
  });
}

test('the scope hands the program the environment it was given, not the bus variables systemd-run needed', { skip: !scopes ? 'no user systemd manager that accepts a scope' : false }, async () => {
  setExecScopeForTest(null);
  const file = stub('bus', 'echo "${XDG_RUNTIME_DIR-unset} ${DBUS_SESSION_BUS_ADDRESS-unset} ${INVOCATION_ID-unset} $ASKED"; cat /proc/self/cgroup');
  const result = await execTree(file, [], { ...LIMITS, env: { ASKED: 'yes', PATH: process.env.PATH ?? '' } });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /^unset unset unset yes$/m);
  const kept = await execTree(file, [], { ...LIMITS, env: { ASKED: 'yes', INVOCATION_ID: 'callers-own', PATH: process.env.PATH ?? '' } });
  assert.match(kept.stdout, /^unset unset callers-own yes$/m, 'a value the caller gave is given back');
  assert.match(result.stdout, /-exec-[0-9a-f]{8}\.scope$/m);
});

test('the mark is a whole environment entry, never a prefix nor a suffix', () => {
  const entry = `${EXEC_TREE_MARK}=abc`;
  assert.ok(environHoldsEntry(`${entry}`, entry));
  assert.ok(environHoldsEntry(`A=1\0${entry}\0B=2\0`, entry));
  assert.ok(environHoldsEntry(`X=${entry}\0${entry}`, entry), 'a later whole entry still counts');
  assert.ok(!environHoldsEntry(`${entry}d\0`, entry));
  assert.ok(!environHoldsEntry(`X${entry}\0`, entry));
  assert.ok(!environHoldsEntry('', entry));
});

test('the ps sweep (macOS) reads the mark as a word of the environment printed after the command', () => {
  const entry = `${EXEC_TREE_MARK}=abc`;
  const ps = [
    `  101 /bin/sleep 8 HOME=/Users/x ${entry} PATH=/bin`,
    `  102 /bin/sleep 8 HOME=/Users/x ${entry}d`,
    `  103 /bin/sh -c echo ${entry}x`,
    `  104 /usr/bin/thing ${entry}`,
    'garbage',
  ].join('\n');
  assert.deepEqual(markedPidsFromPs(ps, entry), [101, 104]);
});

test('the cleanup reserve: a quarter of a short timeout, a second at most', () => {
  assert.equal(cleanupReserve(300), 75);
  assert.equal(cleanupReserve(4_000), 1_000);
  assert.equal(cleanupReserve(600_000), 1_000);
});

test('the limit stops the program with its group, and says so', { skip: !posix }, async () => {
  const pidFile = join(dir, 'limit-pid');
  const file = stub('limit', `trap '' TERM\necho before\nsleep 8 &\necho $! > "${pidFile}"\nwait`);
  const started = Date.now();
  const result = await execTree(file, [], { ...LIMITS, timeout: 300 });
  const left = readPid(pidFile);
  try {
    assert.equal(result.timedOut, true);
    assert.equal(result.code, 1);
    assert.equal(result.stdout, 'before\n', 'what it printed before the limit is kept');
    assert.ok(Date.now() - started < 300 + 200, `one deadline end to end: returned after ${Date.now() - started} ms`);
    assert.ok(await stopsRunning(left), `sleep ${left} survived`);
  } finally { cleanUp(left); }
});

test('the stall limit waits on a program that keeps printing, and stops a silent one with its group', { skip: !posix }, async () => {
  const talker = stub('talker', 'i=0\nwhile [ $i -lt 8 ]; do echo $i >&2; sleep 0.1; i=$((i + 1)); done\necho done');
  const talked = await execTree(talker, [], { ...LIMITS, stallTimeout: 400 });
  assert.equal(talked.timedOut, undefined, 'eight lines over 0.8 s, never 0.4 s apart');
  assert.equal(talked.code, 0);
  assert.equal(talked.stdout, 'done\n');

  const pidFile = join(dir, 'stall-pid');
  const silent = stub('silent', `echo started >&2\nsleep 8 &\necho $! > "${pidFile}"\nwait`);
  const started = Date.now();
  const stalled = await execTree(silent, [], { ...LIMITS, stallTimeout: 300 });
  const left = readPid(pidFile);
  try {
    assert.equal(stalled.timedOut, true);
    assert.equal(stalled.stderr, 'started\n');
    assert.ok(Date.now() - started < 2_500, 'stopped by the stall limit, not the 5 s one');
    assert.ok(await stopsRunning(left), `sleep ${left} survived`);
  } finally { cleanUp(left); }
});

test('too much output stops the program: the start is kept, and it is no timeout', { skip: !posix }, async () => {
  const pidFile = join(dir, 'verbose-pid');
  const file = stub('verbose', `sleep 8 &\necho $! > "${pidFile}"\nwhile :; do echo xxxxxxxxxxxxxxxx; done`);
  const result = await execTree(file, [], { timeout: 5_000, maxBuffer: 64 });
  const left = readPid(pidFile);
  try {
    assert.equal(result.code, 1);
    assert.equal(result.stdout.length, 64);
    assert.equal(result.timedOut, undefined);
    assert.ok(await stopsRunning(left), `sleep ${left} survived`);
  } finally { cleanUp(left); }
});

// `detached` takes the child out of what a Ctrl+C reaches: the daemon's own exit has to bring it back.
test('a process that exits during the call ends the program it was asking', { skip: !posix }, async () => {
  const pidFile = join(dir, 'held-by-daemon-pid');
  const file = stub('hangs', `echo $$ > "${pidFile}"\nexec sleep 8`);
  const witness = join(dir, 'witness.mts'); // Outside any package: `.ts` would load as CommonJS, without top-level await.
  writeFileSync(witness, `
    import { existsSync } from 'node:fs';
    const { execTree } = await import(${JSON.stringify(join(import.meta.dirname, 'kill-tree.ts'))});
    void execTree(${JSON.stringify(file)}, [], { timeout: 30000, maxBuffer: 1024 });
    const poll = setInterval(() => { if (existsSync(${JSON.stringify(pidFile)})) { clearInterval(poll); process.exit(0); } }, 10);
  `);
  const daemon = spawn(process.execPath, ['--import', 'tsx', witness], { stdio: 'ignore', env: process.env, cwd: join(import.meta.dirname, '..', '..') });
  const code = await new Promise<number | null>((resolve) => { daemon.on('exit', resolve); });
  assert.equal(code, 0);
  assert.ok(existsSync(pidFile));
  const left = readPid(pidFile);
  try {
    assert.ok(await stopsRunning(left), `sleep ${left} survived the exit of its caller`);
  } finally { cleanUp(left); }
});

test('the child receives SIGTERM, on every platform', () => {
  for (const platform of ['linux', 'darwin', 'win32'] as const) {
    const signals: string[] = [];
    killProcessTree(child((signal) => signals.push(signal)), platform);
    assert.deepEqual(signals, ['SIGTERM'], platform);
  }
});

test('a child already gone does not throw', () => {
  assert.doesNotThrow(() => killProcessTree(child(() => { throw new Error('ESRCH'); }), 'linux'));
});

const TASKKILL = 'taskkill /T /F /PID 4242';
const ANSWERED: ExecResult = { code: 0, stdout: '', stderr: '' };
const settled = () => new Promise<void>((resolve) => { setImmediate(resolve); });

test('Windows: an exited root never starts taskkill, even before close', async (t) => {
  const exec = t.mock.method(getHost(), 'execAsync', () => Promise.resolve(ANSWERED));
  const groups = t.mock.method(process, 'kill', () => true);
  for (const status of [{ exitCode: 0 }, { exitCode: 1 }, { signalCode: 'SIGTERM' as const }]) {
    const root = Object.assign(child(() => assert.fail('the root has already exited'), 4242), status);
    killProcessTree(root, 'win32');
    stopProcessGroup(root, 'SIGTERM', 'win32');
    stopProcessGroup(root, 'SIGKILL', 'win32');
  }
  await settled();
  assert.equal(exec.mock.callCount(), 0, 'the pid could now belong to an unrelated process');
  assert.equal(groups.mock.callCount(), 0);
});

test('Windows: a forced stop after root exit does not repeat taskkill', async (t) => {
  const exec = t.mock.method(getHost(), 'execAsync', () => Promise.resolve(ANSWERED));
  const signals: string[] = [];
  const root = child((signal) => signals.push(signal), 4242);
  stopProcessGroup(root, 'SIGTERM', 'win32');
  await settled();
  assert.equal(exec.mock.callCount(), 1);
  assert.deepEqual(signals, ['SIGTERM']);
  root.signalCode = 'SIGTERM';
  stopProcessGroup(root, 'SIGKILL', 'win32');
  await settled();
  assert.equal(exec.mock.callCount(), 1);
  assert.deepEqual(signals, ['SIGTERM']);
});

test('POSIX: the group can still be stopped after its root exits', (t) => {
  const kill = t.mock.method(process, 'kill', () => true);
  for (const platform of ['linux', 'darwin'] as const) {
    const root = child(() => assert.fail('the group took it'), 4242);
    root.exitCode = 0;
    stopProcessGroup(root, 'SIGKILL', platform);
  }
  assert.deepEqual(kill.mock.calls.map((c) => c.arguments), [[-4242, 'SIGKILL'], [-4242, 'SIGKILL']]);
});

test('Windows: taskkill starts before the call returns, and the root is ended once it has answered', async (t) => {
  const order: string[] = [];
  let answer = (_: ExecResult) => {};
  t.mock.method(getHost(), 'execAsync', (name: string, args: string[]) => {
    order.push(`${name} ${args.join(' ')}`);
    return new Promise<ExecResult>((resolve) => { answer = resolve; });
  });
  killProcessTree(child((signal) => order.push(signal), 4242), 'win32');
  assert.deepEqual(order, [TASKKILL], 'a daemon exiting now still takes the tree');
  await settled();
  assert.deepEqual(order, [TASKKILL], 'taskkill walks down from the root: it has to be alive');
  order.push('taskkill answered');
  answer(ANSWERED);
  await settled();
  assert.deepEqual(order, [TASKKILL, 'taskkill answered', 'SIGTERM']);
});

test('Windows: the same order through stopProcessGroup, which has no group to signal there', async (t) => {
  const groups = t.mock.method(process, 'kill', () => true);
  const signals: string[] = [];
  let answer = (_: ExecResult) => {};
  t.mock.method(getHost(), 'execAsync', () => new Promise<ExecResult>((resolve) => { answer = resolve; }));
  stopProcessGroup(child((signal) => signals.push(signal), 4242), 'SIGKILL', 'win32');
  await settled();
  assert.deepEqual(signals, []);
  answer(ANSWERED);
  await settled();
  assert.deepEqual(signals, ['SIGTERM']);
  assert.equal(groups.mock.callCount(), 0);
});

test('Windows: a taskkill that fails or cannot start does not spare the root', async (t) => {
  const exec = t.mock.method(getHost(), 'execAsync', () => Promise.resolve({ code: 128, stdout: '', stderr: 'not found' }));
  const signals: string[] = [];
  killProcessTree(child((signal) => signals.push(signal), 4242), 'win32');
  await settled();
  assert.deepEqual(signals, ['SIGTERM']);

  exec.mock.mockImplementation(() => Promise.reject(new Error('binary not found')));
  killProcessTree(child((signal) => signals.push(signal), 4242), 'win32');
  await settled();
  assert.deepEqual(signals, ['SIGTERM', 'SIGTERM']);
});

test('Windows: a taskkill that does not answer costs the limit, then the root is ended, once', async (t) => {
  let answer = (_: ExecResult) => {};
  t.mock.method(getHost(), 'execAsync', () => new Promise<ExecResult>((resolve) => { answer = resolve; }));
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const signals: string[] = [];
  killProcessTree(child((signal) => signals.push(signal), 4242), 'win32');
  t.mock.timers.tick(1_499);
  assert.deepEqual(signals, []);
  t.mock.timers.tick(1);
  assert.deepEqual(signals, ['SIGTERM']);
  t.mock.timers.reset();
  answer(ANSWERED);
  await settled();
  assert.deepEqual(signals, ['SIGTERM'], 'its late answer signals nothing more');
});

test('Windows: a root already gone when taskkill answers is not an error', async (t) => {
  t.mock.method(getHost(), 'execAsync', () => Promise.resolve(ANSWERED));
  assert.doesNotThrow(() => killProcessTree(child(() => { throw new Error('ESRCH'); }, 4242), 'win32'));
  await settled();
});

test('no taskkill elsewhere, nor without a pid: the signal goes out at once', (t) => {
  const exec = t.mock.method(getHost(), 'execAsync', () => Promise.resolve(ANSWERED));
  for (const [platform, pid] of [['linux', 4242], ['darwin', 4242], ['win32', undefined]] as const) {
    const signals: string[] = [];
    killProcessTree(child((signal) => signals.push(signal), pid), platform);
    assert.deepEqual(signals, ['SIGTERM'], platform);
  }
  assert.equal(exec.mock.callCount(), 0);
});

/**
 * Windows has no group, and `taskkill /T` walks down from a living root only: a program that exits at once
 * and leaves a child would keep it. With `sweepOrphans`, the call ends what the exited root left, before it
 * returns. Run on Linux with the host taken for a Windows one: the sweep (PowerShell there) is the fake.
 */
test('Windows: with sweepOrphans, what the exited root left is swept before the call returns', { skip: !posix }, async (t) => {
  const host = getHost();
  const pidFile = join(dir, 'orphan-pid');
  const file = stub('leaves-orphan', `sleep 8 &\necho $! > "${pidFile}"\necho done`);
  t.mock.property(host, 'platform', 'win32');
  const swept: { pid: number; script: string }[] = [];
  let rootPid = 0;
  const spawnOriginal = host.spawn.bind(host);
  t.mock.method(host, 'spawn', (...call: Parameters<typeof host.spawn>) => {
    const proc = spawnOriginal(...call);
    rootPid = proc.pid ?? 0;
    return proc;
  });
  t.mock.method(host, 'execAsync', async (name: string, args: string[]) => {
    assert.equal(name, 'powershell');
    const script = args[args.length - 1]!;
    swept.push({ pid: Number(/^\$root = (\d+)$/m.exec(script)?.[1]), script });
    // What the real script does to the orphan.
    process.kill(readPid(pidFile), 'SIGKILL');
    return ANSWERED;
  });
  const started = Date.now();
  const result = await execTree(file, [], { ...LIMITS, sweepOrphans: true });
  const left = readPid(pidFile);
  try {
    assert.equal(result.code, 0);
    assert.ok(Date.now() - started < 3_000, 'the orphan holding stdout did not hold the call');
    assert.equal(swept.length, 1, 'one sweep, after the root exited');
    assert.equal(swept[0]!.pid, rootPid, 'from the root it started');
    assert.ok(await stopsRunning(left), `sleep ${left} survived`);
  } finally { cleanUp(left); }

  swept.length = 0;
  await execTree(file, [], LIMITS);
  cleanUp(readPid(pidFile));
  assert.equal(swept.length, 0, 'without the option, no PowerShell is started');
});

test('the sweep script: never while the pid is held, only processes since the root, never a system pid', () => {
  const script = windowsOrphanSweepScript(4242, new Date('2026-11-25T03:00:00.000Z'));
  assert.match(script, /^\$root = 4242$/m);
  assert.match(script, /'2026-11-25T03:00:00\.000Z'/);
  assert.match(script, /Where-Object \{ \$_\.ProcessId -eq \$root \}\)\.Count -gt 0\) \{ return \}/, 'a held pid is someone else\'s');
  assert.match(script, /CreationDate\.ToUniversalTime\(\) -ge \$since/, 'an older process named a previous holder');
  assert.match(script, /Stop-Process -Id \$id -Force/);
  for (const pid of [0, 4, -1, 1.5, Number.NaN]) assert.throws(() => windowsOrphanSweepScript(pid, new Date()), String(pid));
});

test('the sweep never throws: no PowerShell, a refused pid', async () => {
  const failing = { execAsync: () => Promise.reject(new Error('binary "powershell" not found in PATH')) };
  await assert.doesNotReject(sweepWindowsOrphans(failing, 4242, new Date()));
  await assert.doesNotReject(sweepWindowsOrphans({ execAsync: () => Promise.resolve(ANSWERED) }, 0, new Date()));
});

test('Windows: a sweep that does not answer still ends with the call\'s deadline', { skip: !posix }, async (t) => {
  const host = getHost();
  const file = stub('exits-at-once', 'echo done');
  t.mock.property(host, 'platform', 'win32');
  let sweepTimeout = 0;
  t.mock.method(host, 'execAsync', (_name: string, _args: string[], opts: { timeout?: number }) => {
    sweepTimeout = opts.timeout ?? 0;
    return new Promise<ExecResult>(() => {});
  });
  const warn = t.mock.method(console, 'warn', () => {});
  const started = Date.now();
  const result = await execTree(file, [], { ...LIMITS, timeout: 600, sweepOrphans: true });
  const took = Date.now() - started;
  assert.equal(result.code, 0);
  assert.equal(result.stdout, 'done\n');
  assert.ok(took >= 500 && took < 600 + 200, `returned after ${took} ms, not after the sweep's own 10 s`);
  assert.ok(sweepTimeout > 0 && sweepTimeout <= 600, `the sweep itself was given ${sweepTimeout} ms`);
  assert.equal(warn.mock.callCount(), 0, 'not reported as failed while it may still finish');
});

test('Windows: a sweep that fails is said, not taken for done', { skip: !posix }, async (t) => {
  const host = getHost();
  const file = stub('exits-at-once-too', 'echo done');
  t.mock.property(host, 'platform', 'win32');
  t.mock.method(host, 'execAsync', () => Promise.resolve({ code: 1, stdout: '', stderr: 'Access denied' }));
  const warn = t.mock.method(console, 'warn', () => {});
  const result = await execTree(file, [], { ...LIMITS, sweepOrphans: true });
  assert.equal(result.code, 0);
  assert.equal(warn.mock.callCount(), 1);
  assert.match(String(warn.mock.calls[0]!.arguments[0]), /could not sweep what process \d+ left running/);
  assert.equal(await sweepWindowsOrphans({ execAsync: () => Promise.resolve({ code: 0, stdout: '', stderr: '', timedOut: true }) }, 4242, new Date()), false);
  assert.equal(await sweepWindowsOrphans({ execAsync: () => Promise.resolve(ANSWERED) }, 4242, new Date()), true);
});
