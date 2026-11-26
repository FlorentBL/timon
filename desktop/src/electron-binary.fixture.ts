/**
 * The Electron executable the opt-in smoke tests launch.
 *
 * Since Electron 42 the `electron` package no longer downloads its binary when
 * it is installed: `require('electron')` downloads it on first use instead.
 * Inside a smoke test that download would run against the test's time limit,
 * once per test file, all of them extracting into the same folder at once. The
 * binary is installed beforehand (`npm run install:electron`); without it, a
 * smoke test stops here with that command instead.
 */
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

export const INSTALL_ELECTRON_HINT = 'Electron binary not installed: run `npm run install:electron` in desktop/ before the smoke tests';

/** The installed binary's path, read the way `electron/index.js` reads it, without its download fallback. */
export function smokeElectron(packageJson: string = createRequire(import.meta.url).resolve('electron/package.json')): string {
  const dir = dirname(packageJson);
  const pathFile = join(dir, 'path.txt');
  if (!existsSync(pathFile)) throw new Error(INSTALL_ELECTRON_HINT);
  const executable = join(dir, 'dist', readFileSync(pathFile, 'utf8'));
  if (!existsSync(executable)) throw new Error(INSTALL_ELECTRON_HINT);
  return executable;
}
