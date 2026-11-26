/**
 * The size cap of `agents/<name>/memory/log.jsonl`.
 *
 * The file is an append-only archive of every mission's events, which nothing
 * reads back on its own: it grew without any bound until the disk was full
 * (2026-11-25: 2.1 GB for the coder, 0.7 GB for the main agent, and the
 * daemon crash-looping on `database or disk is full`).
 *
 * One rotation: past the cap, the file becomes `log.1.jsonl` (replacing the
 * previous one) and a new file starts, so an agent keeps between one and two
 * caps of recent history. A file already far past the cap (one written before
 * the cap existed) keeps only its last cap's worth of whole lines.
 *
 * Kept free of `db.js` imports so it stays testable on a scratch folder.
 */
import {
  appendFileSync, closeSync, openSync, readSync, renameSync, statSync, unlinkSync, writeSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';

/** Name of the rotated file next to `file`: `log.jsonl` → `log.1.jsonl`. */
export function rotatedLogPath(file: string): string {
  const name = basename(file);
  const dot = name.lastIndexOf('.');
  const rotated = dot > 0 ? `${name.slice(0, dot)}.1${name.slice(dot)}` : `${name}.1`;
  return join(dirname(file), rotated);
}

function sizeOf(file: string): number {
  try {
    return statSync(file).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw error;
  }
}

const CHUNK = 1024 * 1024;

/**
 * Writes the last `keep` bytes of `file` to `target`, from the first line that
 * starts inside them, by chunks: the source may weigh gigabytes.
 */
function copyTail(file: string, target: string, size: number, keep: number): void {
  const temp = `${target}.tmp`;
  const src = openSync(file, 'r');
  try {
    const dst = openSync(temp, 'w');
    try {
      const buffer = Buffer.allocUnsafe(CHUNK);
      let position = Math.max(0, size - keep);
      let aligned = position === 0;
      while (position < size) {
        const read = readSync(src, buffer, 0, Math.min(CHUNK, size - position), position);
        if (read <= 0) break;
        position += read;
        let start = 0;
        if (!aligned) {
          const newline = buffer.subarray(0, read).indexOf(0x0a);
          if (newline < 0) continue;
          start = newline + 1;
          aligned = true;
        }
        writeSync(dst, buffer, start, read - start);
      }
    } finally {
      closeSync(dst);
    }
  } finally {
    closeSync(src);
  }
  renameSync(temp, target);
}

/** Rotates `file` when appending `incoming` bytes would take it past `maxBytes`. */
export function rotateIfOver(file: string, maxBytes: number, incoming: number): boolean {
  if (!(maxBytes > 0)) return false;
  const size = sizeOf(file);
  if (size === 0 || size + incoming <= maxBytes) return false;
  const rotated = rotatedLogPath(file);
  if (size <= 2 * maxBytes) {
    renameSync(file, rotated);
  } else {
    copyTail(file, rotated, size, maxBytes);
    unlinkSync(file);
  }
  return true;
}

/**
 * Appends one line to `file` under the cap. A rotation that fails leaves the
 * file as it is and the line is appended anyway: losing the cap once is
 * better than losing the history.
 */
export function appendCappedLine(file: string, line: string, maxBytes: number): void {
  const text = line.endsWith('\n') ? line : `${line}\n`;
  try {
    rotateIfOver(file, maxBytes, Buffer.byteLength(text));
  } catch (error) {
    console.warn(`[agent-log] rotation of ${file} failed: ${(error as Error).message}`);
  }
  appendFileSync(file, text);
}
