/** Fork entry point. No daemon database module: export opens read-only snapshots. */
import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync,
  readSync, readdirSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import {
  assertBackupSpace, BACKUP_ARCHIVE_RE, BACKUP_PARTIAL_SUFFIX, backupArchiveName,
  backupsDir, BackupSpaceError, listBackupArchives, pruneArchives, type BackupRetention,
} from './backup-archives.js';
import { loadConfig, setConfig } from './config/load.js';
import { exportTimon, type ExportResult } from './export.js';
import { instanceId } from './host/packaged-service.js';
import { TIMON_HOME } from './paths.js';

export type BackupRequest = {
  when: number;
  occurrence: number | null;
  retention: BackupRetention;
  tarPin: string | null;
};

export type BackupReply =
  | { state: 'busy' }
  | { state: 'failed' | 'blocked'; message: string; space?: { needed: number; free: number } }
  | { state: 'verified'; occurrence: number | null; startedAt: number; out: string; bytes: number;
      recovered: boolean; result?: ExportResult };

const RECEIPT = '.nightly-backup.receipt.json';
const LOCK = '.nightly-backup.sqlite';
const PARTIAL = /^(timon-\d{4}-\d{2}-\d{2}\.tar\.gz)(?:\.[\da-f-]{36})?\.partial$/;
const READ_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
type Receipt = {
  version: 1; instance: string; occurrence: number; startedAt: number;
  name: string; partial: string; bytes: number; sha256: string;
};

function exists(path: string): boolean {
  return !!lstatSync(path, { throwIfNoEntry: false });
}

function openRegular(path: string): number {
  const entry = lstatSync(path);
  if (!entry.isFile() || entry.nlink !== 1) throw new Error(`Not a regular backup file: ${path}`);
  const fd = openSync(path, READ_FLAGS);
  const stat = fstatSync(fd);
  if (stat.isFile() && stat.nlink === 1 && stat.dev === entry.dev && stat.ino === entry.ino) return fd;
  closeSync(fd);
  throw new Error(`Backup file changed while opening: ${path}`);
}

function archiveDigest(path: string, bytes: number, flush = false): string {
  const fd = openRegular(path);
  try {
    const before = fstatSync(fd, { bigint: true });
    if (!Number.isSafeInteger(bytes) || bytes < 20 || before.size !== BigInt(bytes)) {
      throw new Error(`Invalid backup archive size: ${path}`);
    }
    const buffer = Buffer.allocUnsafe(128 * 1024);
    const hash = createHash('sha256');
    for (let offset = 0; offset < bytes;) {
      const count = readSync(fd, buffer, 0, Math.min(buffer.length, bytes - offset), offset);
      if (!count || (offset === 0 && (count < 3 || buffer[0] !== 0x1f || buffer[1] !== 0x8b || buffer[2] !== 8))) {
        throw new Error(`Invalid or incomplete gzip backup: ${path}`);
      }
      hash.update(buffer.subarray(0, count));
      offset += count;
    }
    if (flush) fsyncSync(fd);
    const after = lstatSync(path, { bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
        || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || after.nlink !== 1n) {
      throw new Error(`Backup archive changed during verification: ${path}`);
    }
    return hash.digest('hex');
  } finally {
    closeSync(fd);
  }
}

function syncDir(dir: string): void {
  // Windows' Node filesystem API cannot fsync directories. Files are flushed on all platforms.
  if (process.platform === 'win32') return;
  const fd = openSync(dir, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function readReceipt(dir: string, instance: string): Receipt | undefined {
  const path = join(dir, RECEIPT);
  if (!exists(path)) return undefined;
  const fd = openRegular(path);
  try {
    const size = fstatSync(fd).size;
    if (size < 1 || size > 4096) throw new Error('Invalid backup receipt size');
    const raw = readFileSync(fd, 'utf8');
    if (Buffer.byteLength(raw) !== size) throw new Error('Backup receipt changed while reading');
    const r = JSON.parse(raw) as Receipt;
    if (r?.version !== 1 || r.instance !== instance || !Number.isSafeInteger(r.occurrence)
        || !Number.isSafeInteger(r.startedAt) || r.startedAt < r.occurrence
        || !Number.isFinite(new Date(r.startedAt).getTime())
        || typeof r.name !== 'string' || !BACKUP_ARCHIVE_RE.test(r.name)
        || typeof r.partial !== 'string' || PARTIAL.exec(r.partial)?.[1] !== r.name
        || !Number.isSafeInteger(r.bytes) || r.bytes < 20
        || typeof r.sha256 !== 'string' || !/^[\da-f]{64}$/.test(r.sha256)) {
      throw new Error('Invalid backup receipt');
    }
    return r;
  } finally {
    closeSync(fd);
  }
}

function writeReceipt(dir: string, receipt: Receipt): void {
  const tmp = join(dir, `${RECEIPT}.${randomUUID()}.tmp`);
  try {
    writeFileSync(tmp, `${JSON.stringify(receipt)}\n`, { mode: 0o600, flag: 'wx', flush: true });
    renameSync(tmp, join(dir, RECEIPT));
    syncDir(dir);
  } finally {
    rmSync(tmp, { force: true });
  }
}

function publish(dir: string, partial: string, out: string): void {
  if (exists(out)) throw new Error(`Backup archive already exists: ${out}`);
  renameSync(partial, out);
  syncDir(dir);
}

function performBackup(dir: string, request: BackupRequest): BackupReply {
  const { when, occurrence, retention, tarPin } = request;
  const instance = instanceId(TIMON_HOME);
  const pending = readReceipt(dir, instance);
  if (pending && pending.occurrence === occurrence) {
    const out = join(dir, pending.name);
    const partial = join(dir, pending.partial);
    const published = exists(out);
    if (published && exists(partial)) throw new Error(`Ambiguous backup publication: ${out}`);
    if (archiveDigest(published ? out : partial, pending.bytes, true) !== pending.sha256) {
      throw new Error(`Backup archive does not match its receipt: ${out}`);
    }
    if (!published) publish(dir, partial, out);
    else syncDir(dir);
    return { state: 'verified', occurrence, startedAt: pending.startedAt, out, bytes: pending.bytes, recovered: true };
  }

  const date = new Date(when);
  const name = backupArchiveName(date);
  if (!BACKUP_ARCHIVE_RE.test(name) || (occurrence !== null && when < occurrence)) throw new Error('Invalid backup date');
  const out = join(dir, name);
  if (exists(out)) throw new Error(`Backup archive already exists without a matching receipt: ${out}`);
  const partialName = `${name}.${randomUUID()}${BACKUP_PARTIAL_SUFFIX}`;
  const partial = join(dir, partialName);
  const prune = () => {
    const pruned = pruneArchives(dir, retention, date);
    if (pruned.length) console.log(`[routines] backup prune: ${pruned.join(', ')}`);
  };
  let result: ExportResult;
  try {
    // Each attempt has its own name, so even a tar orphaned by a killed worker
    // cannot publish anything or write into a later attempt's archive.
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name !== pending?.partial && PARTIAL.test(entry.name)) {
        try { rmSync(join(dir, entry.name), { force: true }); }
        catch (err) { if (!['EPERM', 'EBUSY'].includes((err as NodeJS.ErrnoException).code ?? '')) throw err; }
      }
    }
    prune();
    assertBackupSpace(dir);
    const cfg = loadConfig(undefined, { readonly: true });
    cfg.host.binaries.tar = tarPin;
    setConfig(cfg);
    result = exportTimon({ out: partial });
  } catch (err) {
    rmSync(partial, { force: true });
    const space = err instanceof BackupSpaceError ? { needed: err.needed, free: err.free } : undefined;
    return { state: 'failed', message: (err as Error).message, space };
  }

  if (result.out !== partial) throw new Error('Export did not return the reserved backup path');
  const sha256 = archiveDigest(partial, result.bytes, true);
  // Persist proof before the rename so either side of it can be recovered.
  if (occurrence !== null) {
    writeReceipt(dir, { version: 1, instance, occurrence, startedAt: when, name, partial: partialName,
      bytes: result.bytes, sha256 });
  }
  publish(dir, partial, out);
  try {
    // A backwards clock must not immediately prune the archive just published.
    if (listBackupArchives(dir)[0]?.name === name) prune();
  } catch (err) {
    console.error(`[routines] backup published but pruning failed: ${(err as Error).message}`);
  }
  return { state: 'verified', occurrence, startedAt: when, out, bytes: result.bytes, recovered: false,
    result: { ...result, out } };
}

function run(request: BackupRequest): BackupReply {
  const dir = backupsDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!lstatSync(dir).isDirectory()) throw new Error('Backup path is not a directory');
  const path = join(dir, LOCK);
  const file = lstatSync(path, { throwIfNoEntry: false });
  if (file && (!file.isFile() || file.nlink !== 1)) throw new Error('Invalid backup lock file');
  // Separate database: the worker owns this OS lock even if the daemon dies.
  // Never unlink it; another worker may already hold the open file.
  const lock = new Database(path, { timeout: 0 });
  try {
    try { lock.exec('BEGIN IMMEDIATE'); }
    catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'SQLITE_BUSY') return { state: 'busy' };
      throw err;
    }
    return performBackup(dir, request);
  } finally {
    lock.close();
  }
}

if (process.send) {
  process.umask(0o077);
  process.once('message', (request: BackupRequest) => {
    let reply: BackupReply;
    try { reply = run(request); }
    catch (err) { reply = { state: 'blocked', message: (err as Error).message }; }
    if (process.connected) process.send!(reply, () => { if (process.connected) process.disconnect!(); });
  });
}
