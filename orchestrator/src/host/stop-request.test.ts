/**
 * TODO #1208: the Windows installer stops the service's daemon by writing
 * `run/stop-request`, with no token. Proven on real files in a temporary
 * home: who watches, what counts as a request, that a leftover never stops the
 * daemon started after it, and that the stop runs once.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, mkdtempSync, symlinkSync, utimesSync, writeFileSync, type Stats } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readStopRequest, STOP_REQUEST_FILE, stopRequestPath, stopRequestWatched, watchStopRequest,
} from './stop-request.js';

function home(): string {
  const dir = mkdtempSync(join(tmpdir(), 'timon-stop-request-'));
  mkdirSync(join(dir, 'run'));
  return dir;
}

/** Writes the request, dated `at` (epoch ms). */
function request(dir: string, at: number): string {
  const file = stopRequestPath(dir);
  writeFileSync(file, 'installer\r\n');
  utimesSync(file, at / 1000, at / 1000);
  return file;
}

/** A manual clock for the poll: `tick()` runs one look. */
function manualPoll(): { every: (tick: () => void, ms: number) => () => void; tick: () => void; cancelled: () => boolean; ms: () => number } {
  let current: (() => void) | null = null;
  let cancelled = false;
  let period = 0;
  return {
    every: (tick, ms) => { current = tick; period = ms; return () => { cancelled = true; }; },
    tick: () => current?.(),
    cancelled: () => cancelled,
    ms: () => period,
  };
}

const START = Date.UTC(2026, 10, 27, 1, 0, 0);

test('the request lives in the run folder of the home, under the name the installer writes', () => {
  assert.equal(STOP_REQUEST_FILE, 'stop-request');
  assert.equal(stopRequestPath(join('C:', 'Users', 'a', '.timon')), join('C:', 'Users', 'a', '.timon', 'run', 'stop-request'));
});

test('only the daemon of the Windows service watches for it', () => {
  assert.equal(stopRequestWatched({ TIMON_DESKTOP_SERVICE: '1', TIMON_DESKTOP_EMBEDDED: '0' }, 'win32'), true);
  assert.equal(stopRequestWatched({ TIMON_DESKTOP_SERVICE: '1' }, 'win32'), true);
  // The desktop's embedded daemon is stopped by its window, a checkout by its terminal.
  assert.equal(stopRequestWatched({ TIMON_DESKTOP_EMBEDDED: '1' }, 'win32'), false);
  assert.equal(stopRequestWatched({ TIMON_DESKTOP_SERVICE: '1', TIMON_DESKTOP_EMBEDDED: '1' }, 'win32'), false);
  assert.equal(stopRequestWatched({}, 'win32'), false);
  // POSIX supervisors send SIGTERM.
  for (const platform of ['linux', 'darwin'] as const) {
    assert.equal(stopRequestWatched({ TIMON_DESKTOP_SERVICE: '1', TIMON_DESKTOP_EMBEDDED: '0' }, platform), false);
  }
});

test('a request counts only when it is a plain file written since the daemon started', (t) => {
  const dir = home();
  const file = stopRequestPath(dir);
  assert.equal(readStopRequest(file, START), 'none');
  request(dir, START + 5_000);
  assert.equal(readStopRequest(file, START), 'fresh');
  request(dir, START);
  assert.equal(readStopRequest(file, START), 'fresh', 'written as the process started');
  request(dir, START - 1_000);
  assert.equal(readStopRequest(file, START), 'stale');

  const folder = join(home(), 'run', STOP_REQUEST_FILE);
  mkdirSync(folder);
  assert.equal(readStopRequest(folder, START), 'none', 'a folder is not a request');

  const target = join(dir, 'elsewhere');
  writeFileSync(target, 'x');
  utimesSync(target, (START + 5_000) / 1000, (START + 5_000) / 1000);
  const linked = stopRequestPath(home());
  try {
    symlinkSync(target, linked);
  } catch {
    t.diagnostic('symbolic links are not allowed here: the link case is skipped');
    return;
  }
  assert.equal(readStopRequest(linked, START), 'none', 'a link is not followed');
});

test('a fresh request runs the common stop once, and is removed', () => {
  const dir = home();
  const poll = manualPoll();
  const asked: string[] = [];
  const lines: string[] = [];
  const stop = watchStopRequest({
    file: stopRequestPath(dir), startedAt: START, request: (why) => asked.push(why),
    log: (line) => lines.push(line), every: poll.every,
  });
  assert.equal(poll.ms(), 1_000);
  poll.tick();
  assert.deepEqual(asked, [], 'nothing until the installer writes');

  const file = request(dir, START + 60_000);
  poll.tick();
  assert.deepEqual(asked, ['stop request file']);
  assert.equal(existsSync(file), false);
  assert.equal(poll.cancelled(), true, 'the poll ends with the request');
  assert.deepEqual(lines, ['[timon] stop request file found in the run folder']);
  assert.ok(!lines.join('\n').includes('installer'), 'the content is never read nor written out');

  request(dir, START + 61_000);
  poll.tick();
  assert.deepEqual(asked, ['stop request file'], 'a stop under way is not asked again');
  stop();
});

test('a request written during the boot is honoured at the first look', () => {
  const dir = home();
  request(dir, START + 200);
  const asked: string[] = [];
  const poll = manualPoll();
  watchStopRequest({ file: stopRequestPath(dir), startedAt: START, request: (why) => asked.push(why), log: () => {}, every: poll.every });
  assert.deepEqual(asked, ['stop request file']);
  assert.equal(poll.ms(), 0, 'no poll is started after it');
});

// The installer writes the request even when no daemon runs, or when the one
// that runs is too old to read it: the daemon it starts again afterwards must
// not stop at once.
test('a leftover request is removed and never stops the daemon started after it', () => {
  const dir = home();
  const file = request(dir, START - 30_000);
  const asked: string[] = [];
  const poll = manualPoll();
  watchStopRequest({ file, startedAt: START, request: (why) => asked.push(why), log: () => {}, every: poll.every });
  assert.equal(existsSync(file), false, 'cleared at start');
  poll.tick();
  assert.deepEqual(asked, []);
  assert.equal(poll.cancelled(), false, 'still watching for a real request');
});

test('a leftover that cannot be removed stays ignored, and is not tried again every second', () => {
  const dir = home();
  const file = request(dir, START - 30_000);
  let removals = 0;
  const asked: string[] = [];
  const poll = manualPoll();
  watchStopRequest({
    file, startedAt: START, request: (why) => asked.push(why), log: () => {}, every: poll.every,
    remove: () => { removals += 1; throw Object.assign(new Error('busy'), { code: 'EBUSY' }); },
  });
  poll.tick();
  poll.tick();
  assert.equal(removals, 1);
  assert.deepEqual(asked, []);
  // The installer then writes over it: a new date, a real request.
  utimesSync(file, (START + 10_000) / 1000, (START + 10_000) / 1000);
  poll.tick();
  assert.deepEqual(asked, ['stop request file'], 'stops even when the request cannot be removed');
});

test('a request that cannot be read is no request', () => {
  const asked: string[] = [];
  const poll = manualPoll();
  const denied = (): Stats => { throw Object.assign(new Error('denied'), { code: 'EPERM' }); };
  watchStopRequest({ file: 'unused', startedAt: START, request: (why) => asked.push(why), log: () => {}, every: poll.every, stat: denied });
  poll.tick();
  assert.deepEqual(asked, []);
});

test('the returned function stops the watch', () => {
  const dir = home();
  const asked: string[] = [];
  const poll = manualPoll();
  const stop = watchStopRequest({ file: stopRequestPath(dir), startedAt: START, request: (why) => asked.push(why), log: () => {}, every: poll.every });
  stop();
  assert.equal(poll.cancelled(), true);
  request(dir, START + 1_000);
  poll.tick();
  assert.deepEqual(asked, []);
});

test('the real poll finds a request written after it started', async () => {
  const dir = home();
  const asked: string[] = [];
  const stop = watchStopRequest({ file: stopRequestPath(dir), startedAt: Date.now() - 1_000, request: (why) => asked.push(why), log: () => {}, pollMs: 20 });
  writeFileSync(stopRequestPath(dir), 'installer\r\n');
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.deepEqual(asked, ['stop request file']);
  stop();
});

test('the booted daemon watches for it, behind the service marker', () => {
  const boot = readFileSync(join(import.meta.dirname, '..', 'kernel-boot.ts'), 'utf8');
  const after = boot.slice(boot.indexOf('root = await boot();'));
  assert.match(after, /if \(stopRequestWatched\(process\.env, process\.platform\)\) \{\s+onDaemonShutdown\(watchStopRequest\(\{\s+file: stopRequestPath\(TIMON_HOME\),\s+startedAt: performance\.timeOrigin,\s+request: requestDaemonShutdown,/);
});
