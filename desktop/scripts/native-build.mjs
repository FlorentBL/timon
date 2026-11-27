/**
 * What a from-source rebuild of a native module leaves behind, and what of it
 * ships. Every platform: Linux always rebuilds from source (TIM-0162), macOS
 * and Windows whenever no prebuild matches the shipped Node (better-sqlite3
 * 11.10.0 publishes none for Node 24, ABI 137: the 0.1.12-rc.1 Mac build
 * compiled it and then failed to load the `test_extension.node` beside it).
 */
import { lstatSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

/**
 * What a from-source rebuild leaves in `build/Release` that ships, per module.
 * The same names on every platform: node-gyp writes `<target>.node` on each.
 * node-gyp also writes its objects, a Makefile and, for better-sqlite3, a
 * `test_extension.node` that is a SQLite extension, not a Node addon: loading
 * it fails ("did not self-register") and nothing in Timon needs it.
 */
export const NATIVE_BUILD_ARTEFACTS = Object.freeze({
  'better-sqlite3': Object.freeze(['better_sqlite3.node']),
  'node-pty': Object.freeze(['pty.node']),
});

/**
 * Reduces a rebuilt module's `build/` to the artefacts that ship, and returns
 * them: the only files the shipped Node is then asked to load. Throws when one is missing: a rebuild that "succeeded" without its
 * addon is the silent failure this whole file exists to stop.
 */
export function pruneNativeBuild(moduleDir, moduleName) {
  const keep = NATIVE_BUILD_ARTEFACTS[moduleName];
  if (!keep) throw new Error(`${moduleName}: no native artefact declared in NATIVE_BUILD_ARTEFACTS`);
  const build = join(moduleDir, 'build');
  const release = join(build, 'Release');
  const missing = keep.filter((name) => !lstatSync(join(release, name), { throwIfNoEntry: false })?.isFile());
  if (missing.length) throw new Error(`${moduleName}: the rebuild left no ${missing.join(', ')} under ${release}`);
  for (const entry of readdirSync(build)) {
    if (entry !== 'Release') rmSync(join(build, entry), { recursive: true, force: true });
  }
  for (const entry of readdirSync(release)) {
    if (!keep.includes(entry)) rmSync(join(release, entry), { recursive: true, force: true });
  }
  return keep.map((name) => join(release, name));
}
