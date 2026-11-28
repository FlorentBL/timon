import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as protocol from './native-browser-protocol.js';

const nodeRequire = createRequire(import.meta.url);
const source = (await readFile(new URL('./native-browser.ts', import.meta.url), 'utf8'))
  .replaceAll('import.meta.url', JSON.stringify(new URL('./native-browser.ts', import.meta.url).href));
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

interface Engine { command(body: Record<string, unknown>): Promise<unknown> }

function engineClass(): new (home: string, options?: Record<string, unknown>) => Engine {
  const exports: Record<string, unknown> = {};
  runInNewContext(compiled, {
    exports, console, Buffer, URL, setTimeout, clearTimeout,
    require: (name: string) => name === 'electron' ? { ipcMain: new EventEmitter() }
      : name === './native-browser-protocol.js' ? protocol : nodeRequire(name),
  });
  return exports.NativeBrowserEngine as new (home: string, options?: Record<string, unknown>) => Engine;
}

test('with no screen, a Chrome sign-in is refused with a code before any profile or Chrome is looked at', async () => {
  const NativeBrowserEngine = engineClass();
  const headless = new NativeBrowserEngine('/unused', { headless: true });
  await assert.rejects(headless.command({ action: 'chromeSigninStart', profileId: 'profile-a', executable: '/usr/bin/google-chrome' }),
    (error: unknown) => {
      assert.ok(error instanceof protocol.BrowserCommandError);
      assert.equal(error.code, protocol.BROWSER_NEEDS_SCREEN);
      assert.equal(error.statusCode, 409);
      assert.match(error.message, /no screen/);
      return true;
    });
  // With a screen, the same command reaches the profile check: nothing refuses it up front.
  const windowed = new NativeBrowserEngine('/unused');
  await assert.rejects(windowed.command({ action: 'chromeSigninStart', profileId: 'profile-a', executable: '/usr/bin/google-chrome' }),
    (error: unknown) => error instanceof protocol.BrowserCommandError && error.code === undefined && /not running/.test(error.message));
});
