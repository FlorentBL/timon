import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  APP_CLAIM_MS, BROWSER_HOST_LAUNCH, appClaimActive, browserHostRefusal, browserHostRequested, headlessRelaunch, launchedByBrowserHost,
  liveBrowserHost, removeHostMarker, takeHomeFromBrowserHost, waitForHome, writeHostMarker,
} from './browser-host.js';

const home = (): string => mkdtempSync(join(tmpdir(), 'timon-browser-host-'));

test('the flag is read anywhere on the command line', () => {
  assert.equal(browserHostRequested(['/opt/Timon/timon-desktop', '--browser-host']), true);
  assert.equal(browserHostRequested(['/usr/bin/electron', 'dist/main.js', '--browser-host', '--no-sandbox']), true);
  assert.equal(browserHostRequested(['/opt/Timon/timon-desktop']), false);
});

test('macOS and Windows are refused with a sentence that says what to open instead', () => {
  assert.equal(browserHostRefusal('linux'), null);
  assert.match(browserHostRefusal('darwin')!, /Linux only.*On macOS.*open Timon instead/);
  assert.match(browserHostRefusal('win32')!, /Linux only.*On Windows/);
});

test('with no graphical session the host starts again on the headless platform, once', () => {
  const argv = ['/opt/Timon/timon-desktop', '--browser-host'];
  const relaunch = headlessRelaunch(argv, { PATH: '/usr/bin' }, 'linux');
  assert.deepEqual(relaunch?.args, [...argv, '--ozone-platform=headless', '--ozone-override-screen-size=1920,1080']);
  assert.equal(relaunch?.env.PATH, '/usr/bin');
  // The second start carries the switch and the guard: it goes on.
  assert.equal(headlessRelaunch(relaunch!.args, relaunch!.env, 'linux'), null);
  assert.equal(headlessRelaunch(argv, relaunch!.env, 'linux'), null, 'the guard alone stops a loop if the switch were dropped');
  assert.equal(headlessRelaunch([...argv, '--ozone-platform=x11'], {}, 'linux'), null, 'a platform chosen by hand is kept');
  assert.equal(headlessRelaunch(argv, { DISPLAY: ':0' }, 'linux'), null);
  assert.equal(headlessRelaunch(argv, { WAYLAND_DISPLAY: 'wayland-0' }, 'linux'), null);
  assert.equal(headlessRelaunch(argv, {}, 'darwin'), null);
});

test('a host lock request is told apart from a launch of the application', () => {
  assert.equal(launchedByBrowserHost(BROWSER_HOST_LAUNCH), true);
  assert.equal(launchedByBrowserHost({ build: '0.1.11' }), false);
  assert.equal(launchedByBrowserHost(null), false);
  assert.equal(launchedByBrowserHost('browser-host'), false);
});

test('the marker names a live host only, and only its own process removes it', () => {
  const dir = home();
  try {
    assert.equal(liveBrowserHost(dir), null);
    writeHostMarker(dir, 4242, 1);
    assert.equal(liveBrowserHost(dir, pid => pid === 4242), 4242);
    assert.equal(liveBrowserHost(dir, () => false), null, 'a crashed host leaves a marker that names nobody');
    removeHostMarker(dir, 1111);
    assert.equal(liveBrowserHost(dir, () => true), 4242, 'another process does not remove it');
    removeHostMarker(dir, 4242);
    assert.equal(liveBrowserHost(dir, () => true), null);
    mkdirSync(join(dir, 'browser-native'), { recursive: true });
    writeFileSync(join(dir, 'browser-native', 'browser-host.json'), '{"pid":"1"}');
    assert.equal(liveBrowserHost(dir, () => true), null, 'a malformed marker names nobody');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

/** A clock that `sleep` moves forward: the waits run instantly. */
function clock() {
  let at = 1_000_000;
  return { now: () => at, sleep: async (ms: number) => { at += ms; } };
}

test('the application takes the home from a host: claims it, retries until the host is gone, then drops the claim', async () => {
  const dir = home();
  try {
    writeHostMarker(dir, 4242, 0);
    const time = clock();
    let tries = 0;
    const claims: boolean[] = [];
    const taken = await takeHomeFromBrowserHost({
      home: dir, pid: 77, ...time, alive: pid => pid === 4242 || pid === 77,
      request: () => { claims.push(appClaimActive(dir, time.now(), pid => pid === 77)); return ++tries === 3; },
    });
    assert.equal(taken, true);
    assert.deepEqual(claims, [true, true, true], 'a restarted host must not ask for the lock while the app takes it');
    assert.equal(existsSync(join(dir, 'browser-native', 'app-claim.json')), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the application does not wait when no host holds the home: another app does, the usual second launch', async () => {
  const dir = home();
  try {
    let tries = 0;
    assert.equal(await takeHomeFromBrowserHost({ home: dir, pid: 77, request: () => { tries++; return true; } }), false);
    writeHostMarker(dir, 4242, 0);
    assert.equal(await takeHomeFromBrowserHost({ home: dir, pid: 77, alive: () => false, request: () => { tries++; return true; } }), false);
    assert.equal(tries, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the application gives up when the host never leaves, and drops its claim', async () => {
  const dir = home();
  try {
    writeHostMarker(dir, 4242, 0);
    const time = clock();
    let tries = 0;
    const lines: string[] = [];
    assert.equal(await takeHomeFromBrowserHost({
      home: dir, pid: 77, ...time, alive: () => true, timeoutMs: 2_000, intervalMs: 250,
      request: () => { tries++; return false; }, log: line => lines.push(line),
    }), false);
    assert.equal(tries, 8);
    assert.match(lines.at(-1)!, /did not step aside within 2 s/);
    assert.equal(existsSync(join(dir, 'browser-native', 'app-claim.json')), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the host waits for the lock, skips its tries while an application claims the home, and stops waiting on request', async () => {
  const dir = home();
  try {
    const time = clock();
    const lines: string[] = [];
    let tries = 0;
    assert.equal(await waitForHome({ home: dir, ...time, stopped: () => false, request: () => ++tries === 3, log: line => lines.push(line) }), true);
    assert.equal(tries, 3);
    assert.equal(lines.length, 1, 'said once, not at every try');

    mkdirSync(join(dir, 'browser-native'), { recursive: true });
    writeFileSync(join(dir, 'browser-native', 'app-claim.json'), JSON.stringify({ pid: 77, at: time.now() }));
    tries = 0;
    const asked: number[] = [];
    assert.equal(await waitForHome({
      home: dir, ...time, intervalMs: 5_000, stopped: () => false, alive: () => true,
      request: () => { asked.push(time.now()); return true; },
    }), true);
    assert.equal(asked.length, 1);
    assert.ok(asked[0]! - JSON.parse(readFileSync(join(dir, 'browser-native', 'app-claim.json'), 'utf8')).at >= APP_CLAIM_MS,
      'no try while the claim is fresh');

    let stopped = false;
    assert.equal(await waitForHome({ home: dir, ...time, stopped: () => stopped, request: () => { stopped = true; return false; } }), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a claim from an application that is gone does not hold the host back', () => {
  const dir = home();
  try {
    mkdirSync(join(dir, 'browser-native'), { recursive: true });
    writeFileSync(join(dir, 'browser-native', 'app-claim.json'), JSON.stringify({ pid: 77, at: 1000 }));
    assert.equal(appClaimActive(dir, 2000, () => true), true);
    assert.equal(appClaimActive(dir, 2000, () => false), false);
    assert.equal(appClaimActive(dir, 1000 + APP_CLAIM_MS, () => true), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
