/**
 * Free-space gate of the dispatcher.
 *
 * On 2026-11-25 task worktrees and agent archives filled `/`: SQLite failed
 * with `database or disk is full`, then `disk I/O error`, and the daemon
 * crash-looped. Each dispatched task adds a worktree (hundreds of MB with a
 * build cache) and a mission writing to the database, so below a floor of
 * free space the dispatcher stops starting tasks instead of pushing the disk
 * the last step. It resumes by itself once space is back: nothing is blocked,
 * the tasks wait as PENDING.
 *
 * Kept free of `db.js` imports: the notification is the caller's.
 */
import { existsSync } from 'node:fs';
import { formatBytes, freeBytes } from './storage-failure.js';

export type DiskGate =
  | { ok: true; free: number | null }
  | { ok: false; free: number; min: number; dir: string };

/**
 * Is there more than `minBytes` free on the filesystem of the first existing
 * folder of `dirs`? Open when the floor is 0 or the OS cannot tell: a gate
 * that cannot read the disk must not stop all work.
 */
export function diskGate(
  dirs: readonly string[],
  minBytes: number,
  free: (dir: string) => number | null = freeBytes,
): DiskGate {
  if (!(minBytes > 0)) return { ok: true, free: null };
  const dir = dirs.find((d) => existsSync(d));
  if (!dir) return { ok: true, free: null };
  const bytes = free(dir);
  if (bytes === null || bytes >= minBytes) return { ok: true, free: bytes };
  return { ok: false, free: bytes, min: minBytes, dir };
}

export function diskGateMessage(gate: Extract<DiskGate, { ok: false }>): string {
  return `only ${formatBytes(gate.free)} free for ${gate.dir}, under the floor of ${formatBytes(gate.min)} (TIMON_DISK_MIN_FREE_MB)`;
}

export type DiskTransition = 'paused' | 'resumed' | null;

/**
 * Remembers whether the dispatcher is paused, so the log line and the
 * notification go out once per episode, not at every tick.
 */
export class DiskPause {
  private paused = false;

  /** Records `gate` and tells whether it changed the state. */
  update(gate: DiskGate): DiskTransition {
    if (!gate.ok && !this.paused) {
      this.paused = true;
      return 'paused';
    }
    if (gate.ok && this.paused) {
      this.paused = false;
      return 'resumed';
    }
    return null;
  }

  get isPaused(): boolean {
    return this.paused;
  }
}
