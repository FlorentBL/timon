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

/**
 * Whether the smoke tests run Electron without a screen: asked with `TIMON_ELECTRON_SMOKE_HEADLESS=1`,
 * and implied on Linux when no display is set, where Electron would otherwise not start. A smoke run
 * on a desktop someone works at must not open its windows there.
 */
export function smokeHeadless(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): boolean {
  if (env.TIMON_ELECTRON_SMOKE_HEADLESS === '1') return true;
  return platform === 'linux' && !env.DISPLAY && !env.WAYLAND_DISPLAY;
}

const HEADLESS_SCREEN = '1920,1080';

/**
 * The command line for `script`: Chromium's headless Ozone backend first when headless. Its virtual
 * screen is 1x1 unless told otherwise, and a window never grows past its screen: the panel the
 * smokes attach would not fit.
 */
export function smokeArgs(script: string, headless: boolean = smokeHeadless()): string[] {
  return headless ? ['--ozone-platform=headless', `--ozone-override-screen-size=${HEADLESS_SCREEN}`, script] : [script];
}

/** `env` for the Electron child, without a display to open windows on when headless. */
export function smokeEnv(env: NodeJS.ProcessEnv, headless: boolean = smokeHeadless()): NodeJS.ProcessEnv {
  if (!headless) return env;
  const { DISPLAY: _display, WAYLAND_DISPLAY: _wayland, ...rest } = env;
  return rest;
}
