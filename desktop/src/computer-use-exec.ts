/** The real executor of the computer-native service: no shell, a timeout, bounded output. */
import { execFile } from 'node:child_process';
import type { SystemCommand } from './computer-use-input.js';

export function runSystemCommand(command: SystemCommand, timeoutMs = 20_000): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => {
    execFile(command.file, command.args, {
      timeout: timeoutMs, maxBuffer: 256 * 1024, windowsHide: true,
      env: { ...process.env, ...command.env },
    }, (error, stdout) => {
      if (error) reject(error); else resolve({ stdout: String(stdout) });
    });
  });
}
