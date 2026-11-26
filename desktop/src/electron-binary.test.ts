import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { INSTALL_ELECTRON_HINT, smokeArgs, smokeElectron, smokeEnv, smokeHeadless } from './electron-binary.fixture.js';

test('a smoke test without the Electron binary stops on the install command, never downloads it', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'timon-electron-binary-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const pkg = join(dir, 'package.json');
  writeFileSync(pkg, '{"name":"electron"}');
  assert.throws(() => smokeElectron(pkg), { message: INSTALL_ELECTRON_HINT });
  writeFileSync(join(dir, 'path.txt'), 'electron');
  assert.throws(() => smokeElectron(pkg), { message: INSTALL_ELECTRON_HINT }, 'path.txt alone: the binary itself is missing');
  mkdirSync(join(dir, 'dist'));
  writeFileSync(join(dir, 'dist', 'electron'), '');
  assert.equal(smokeElectron(pkg), join(dir, 'dist', 'electron'));
});

test('the install command the hint names exists', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { scripts: Record<string, string> };
  assert.match(INSTALL_ELECTRON_HINT, /npm run install:electron/);
  assert.equal(pkg.scripts['install:electron'], 'install-electron');
});

test('a headless smoke runs Electron on the headless Ozone backend, with no display to open windows on', () => {
  assert.equal(smokeHeadless({ TIMON_ELECTRON_SMOKE_HEADLESS: '1', DISPLAY: ':1' }, 'linux'), true, 'asked for, even with a display');
  assert.equal(smokeHeadless({}, 'linux'), true, 'a Linux machine without a display cannot show a window anyway');
  assert.equal(smokeHeadless({ DISPLAY: ':1' }, 'linux'), false);
  assert.equal(smokeHeadless({ WAYLAND_DISPLAY: 'wayland-0' }, 'linux'), false);
  assert.equal(smokeHeadless({}, 'darwin'), false);
  assert.deepEqual(smokeArgs('/tmp/smoke.cjs', true), ['--ozone-platform=headless', '--ozone-override-screen-size=1920,1080', '/tmp/smoke.cjs']);
  assert.deepEqual(smokeArgs('/tmp/smoke.cjs', false), ['/tmp/smoke.cjs']);
  const env = { DISPLAY: ':1', WAYLAND_DISPLAY: 'wayland-0', TIMON_HOME: '/tmp/home' };
  assert.deepEqual(smokeEnv(env, true), { TIMON_HOME: '/tmp/home' });
  assert.equal(smokeEnv(env, false), env);
});
