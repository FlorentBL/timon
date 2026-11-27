import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pruneNativeBuild } from './native-build.mjs';

/** A module directory as node-gyp leaves it after a source build. */
function sourceBuild(prefix, release, extra = []) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const releaseDir = join(dir, 'build', 'Release');
  mkdirSync(releaseDir, { recursive: true });
  for (const name of release) writeFileSync(join(releaseDir, name), '');
  for (const name of extra) writeFileSync(join(dir, 'build', name), '');
  return { dir, releaseDir };
}

test('TIM-0162: a Linux source rebuild keeps only the addon that ships', () => {
  const { dir, releaseDir } = sourceBuild('prune-linux-', ['better_sqlite3.node', 'test_extension.node'], ['Makefile']);
  mkdirSync(join(releaseDir, 'obj.target'), { recursive: true });
  mkdirSync(join(dir, 'build', 'node_gyp_bins'), { recursive: true });
  assert.deepEqual(pruneNativeBuild(dir, 'better-sqlite3'), [join(releaseDir, 'better_sqlite3.node')]);
  assert.ok(!existsSync(join(releaseDir, 'test_extension.node')), 'a SQLite extension, not a Node addon: it cannot load');
  assert.ok(!existsSync(join(releaseDir, 'obj.target')));
  assert.ok(!existsSync(join(dir, 'build', 'Makefile')));
  assert.ok(!existsSync(join(dir, 'build', 'node_gyp_bins')));
});

/**
 * 0.1.12-rc.1 on macOS: better-sqlite3 11.10.0 has no prebuild for Node 24
 * (ABI 137), so `npm rebuild` compiled it, `test_extension.node` landed beside
 * `better_sqlite3.node`, and loading every `.node` under the shipped Node died
 * on it ("Module did not self-register"). Windows compiles the same way.
 */
test('0.1.12-rc.1: a macOS or Windows source rebuild never hands test_extension.node to the load check', () => {
  const mac = sourceBuild('prune-mac-', ['better_sqlite3.node', 'test_extension.node'], ['Makefile', 'config.gypi']);
  mkdirSync(join(mac.releaseDir, '.deps'), { recursive: true });
  mkdirSync(join(mac.releaseDir, 'obj.target'), { recursive: true });
  assert.deepEqual(pruneNativeBuild(mac.dir, 'better-sqlite3'), [join(mac.releaseDir, 'better_sqlite3.node')]);
  assert.deepEqual(readdirSync(mac.releaseDir), ['better_sqlite3.node']);
  assert.deepEqual(readdirSync(join(mac.dir, 'build')), ['Release']);

  const win = sourceBuild('prune-win-', ['better_sqlite3.node', 'better_sqlite3.pdb', 'better_sqlite3.lib', 'test_extension.node', 'test_extension.pdb'], ['better_sqlite3.vcxproj']);
  assert.deepEqual(pruneNativeBuild(win.dir, 'better-sqlite3'), [join(win.releaseDir, 'better_sqlite3.node')]);
  assert.deepEqual(readdirSync(win.releaseDir), ['better_sqlite3.node']);
});

test('a rebuild without its addon, or an undeclared module, stops the build', () => {
  const { dir } = sourceBuild('prune-empty-', ['test_extension.node']);
  assert.throws(() => pruneNativeBuild(dir, 'better-sqlite3'), /no better_sqlite3\.node/);
  assert.throws(() => pruneNativeBuild(dir, 'node-pty'), /no pty\.node/);
  assert.throws(() => pruneNativeBuild(dir, 'left-pad'), /no native artefact declared/);
});
