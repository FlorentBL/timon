import { existsSync, lstatSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { TIMON_HOME } from './paths.js';
import { formatBytes, freeBytes } from './storage-failure.js';
import type { BackupArchive } from './plugins/contract/backup.js';

export const BACKUP_ARCHIVE_RE = /^timon-(\d{4})-(\d{2})-(\d{2})\.tar\.gz$/;
export const BACKUP_PARTIAL_SUFFIX = '.partial';
export const BACKUP_SPACE_FACTOR = 1.5;
const PRE_REBUILD_RE = /^pre-rebuild-(\d{4})-(\d{2})-(\d{2})\.db$/;
const DAY_MS = 86_400_000;

export type BackupRetention = { keep: number; maxAgeDays: number };

export function backupsDir(home = TIMON_HOME): string {
  return join(home, 'backups');
}

/** Local date, like the 03:30 cron. */
export function backupArchiveName(when = new Date()): string {
  const y = when.getFullYear();
  const m = String(when.getMonth() + 1).padStart(2, '0');
  const d = String(when.getDate()).padStart(2, '0');
  return `timon-${y}-${m}-${d}.tar.gz`;
}

export function listBackupArchives(dir = backupsDir()): BackupArchive[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => BACKUP_ARCHIVE_RE.test(name))
    .sort().reverse()
    .flatMap((name) => {
      const stat = lstatSync(join(dir, name), { throwIfNoEntry: false });
      return stat?.isFile() ? [{ name, bytes: stat.size }] : [];
    });
}

function archiveDay(name: string, re = BACKUP_ARCHIVE_RE): number | null {
  const m = re.exec(name);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
}

/** Keep the newest archive even past the age limit; snapshots follow newer archives. */
export function pruneArchives(dir: string, retention: BackupRetention, now: Date): string[] {
  const { keep, maxAgeDays } = retention;
  const cutoff = maxAgeDays > 0 ? now.getTime() - maxAgeDays * DAY_MS : null;
  const dropped: string[] = [];
  const keptDays: number[] = [];
  listBackupArchives(dir).forEach((file, index) => {
    const day = archiveDay(file.name);
    const tooMany = index >= Math.max(1, keep);
    const tooOld = cutoff !== null && day !== null && day < cutoff;
    if (index === 0 || (!tooMany && !tooOld)) {
      if (day !== null) keptDays.push(day);
      return;
    }
    rmSync(join(dir, file.name));
    dropped.push(file.name);
  });
  const snapshots = existsSync(dir) ? readdirSync(dir).filter((n) => PRE_REBUILD_RE.test(n)) : [];
  for (const name of snapshots) {
    const day = archiveDay(name, PRE_REBUILD_RE);
    if (day === null) continue;
    const newer = keptDays.filter((d) => d > day).length;
    const outOfWindow = newer >= Math.max(1, keep);
    const tooOld = cutoff !== null && day < cutoff && newer >= 1;
    if (!outOfWindow && !tooOld) continue;
    rmSync(join(dir, name), { force: true });
    dropped.push(name);
  }
  return dropped;
}

export class BackupSpaceError extends Error {
  constructor(readonly needed: number, readonly free: number, readonly dir: string) {
    super(`not enough free space for the nightly backup in ${dir}: ${formatBytes(free)} free, about ${formatBytes(needed)} needed`);
    this.name = 'BackupSpaceError';
  }
}

/** No prior archive or unavailable statfs: try the export. */
export function assertBackupSpace(dir: string, available = freeBytes(dir)): void {
  const newest = listBackupArchives(dir)[0];
  if (!newest || available === null) return;
  const needed = Math.ceil(newest.bytes * BACKUP_SPACE_FACTOR);
  if (available < needed) throw new BackupSpaceError(needed, available, dir);
}
