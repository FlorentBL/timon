import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { INSTALL_ELECTRON_HINT, smokeElectron } from './electron-binary.fixture.js';

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
