/**
 * Accessibility backend for linux. Not written yet: the platform reports `unsupported`, so the
 * accessibility tools say so and an agent falls back to screenshots.
 */
import { A11yError, type A11yBackend } from './computer-use-a11y.js';
import type { Exec } from './computer-use-windows.js';

export function linuxA11yBackend(_exec: Exec): A11yBackend {
  const unsupported = (): never => { throw new A11yError('failed', 'The accessibility tree is not available on this system yet.'); };
  return { probe: async () => 'unsupported', tree: async () => unsupported(), act: async () => unsupported() };
}
