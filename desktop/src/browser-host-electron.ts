/**
 * The real seams of `runBrowserHost` (`browser-host-shell.ts`): Electron, the engine and the
 * process. Loaded by `main.ts` only, inside Electron.
 */
import { mkdirSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { app, BrowserWindow } from 'electron';
import type { BrowserHostSeams } from './browser-host-shell.js';
import { resolveTimonHome } from './config.js';
import { installDesktopLog } from './desktop-log.js';
import { NativeBrowserEngine } from './native-browser.js';
import { NativeBrowserMedia } from './native-browser-media.js';
import { providerCommand, startNativeBrowserServer } from './native-browser-server.js';
import { keepDictionariesLocal } from './spellcheck.js';

export function electronBrowserHostSeams(): BrowserHostSeams {
  // Every session, before any page loads: no spell-check dictionary from Google, as in the app.
  app.on('session-created', (created) => keepDictionariesLocal(created, process.platform));
  return {
    platform: process.platform, argv: process.argv, env: process.env, pid: process.pid, execPath: process.execPath,
    execve: (file, args, env) => {
      // Node 22.15 and later; typed here since older @types/node do not declare it.
      const execve = (process as { execve?: (file: string, args: readonly string[], env: NodeJS.ProcessEnv) => never }).execve;
      if (!execve) throw new Error(`This runtime cannot start itself again: start it with ${args.slice(-2).join(' ')}`);
      execve(file, args, env);
    },
    ozonePlatform: () => app.commandLine.getSwitchValue('ozone-platform'),
    setUserData: (path) => app.setPath('userData', path),
    requestLock: (data) => app.requestSingleInstanceLock(data),
    whenReady: () => app.whenReady(),
    keepRunningWithoutWindows: () => { app.on('window-all-closed', () => { /* A host serves with no window open. */ }); },
    onSecondInstance: (listener) => { app.on('second-instance', (_event, _argv, _cwd, data) => listener(data)); },
    onQuitRequest: (listener) => { app.on('before-quit', (event) => listener(() => event.preventDefault())); },
    onSignal: (signal, listener) => { process.once(signal, listener); },
    exit: (code) => app.exit(code),
    resolveHome: () => {
      const requested = resolve(resolveTimonHome());
      mkdirSync(requested, { recursive: true });
      return realpathSync(requested);
    },
    installLog: (home) => { installDesktopLog(home); },
    start: async (home, headless) => {
      const engine = new NativeBrowserEngine(home, { headless });
      // Its capture window streams hidden, headless platform included (measured): only `capturePage` needs a shown window.
      const media = new NativeBrowserMedia(home, profileId => engine.mediaSource(profileId));
      const provider = await startNativeBrowserServer(home, providerCommand(() => ({ browser: engine, media })));
      return {
        close: async () => {
          // The descriptor goes first: the daemon stops sending while the profiles flush.
          await provider.close();
          media.close();
          await engine.close();
        },
      };
    },
    measureText: async () => {
      const probe = new BrowserWindow({ show: false, width: 400, height: 200, webPreferences: { sandbox: true, contextIsolation: true } });
      try {
        await probe.loadURL('data:text/html;charset=utf-8,<span style="font:16px sans-serif">Timon</span>');
        return Number(await probe.webContents.executeJavaScript('document.querySelector("span").getBoundingClientRect().width'));
      } finally { probe.destroy(); }
    },
    log: (line) => console.log(line),
    error: (line, cause) => { if (cause === undefined) console.error(line); else console.error(line, cause); },
  };
}
