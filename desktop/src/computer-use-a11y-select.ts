/** Which accessibility backend runs on this platform. */
import { A11yError, type A11yBackend } from './computer-use-a11y.js';
import type { Exec } from './computer-use-windows.js';
import { darwinA11yBackend } from './computer-use-a11y-darwin.js';
import { linuxA11yBackend } from './computer-use-a11y-linux.js';
import { win32A11yBackend } from './computer-use-a11y-win32.js';

/** The backend of this platform. Every system call goes through `exec`. */
export function selectA11yBackend(platform: NodeJS.Platform, exec: Exec): A11yBackend {
  if (platform === 'darwin') return darwinA11yBackend(exec);
  if (platform === 'win32') return win32A11yBackend(exec);
  if (platform === 'linux') return linuxA11yBackend(exec);
  return { probe: async () => 'unsupported', tree: async () => { throw new A11yError('failed', 'Unsupported platform.'); }, act: async () => { throw new A11yError('failed', 'Unsupported platform.'); } };
}
