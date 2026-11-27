/**
 * TODO #476 — the nightly backup keeps what the settings say (`TIMON_BACKUP_KEEP`,
 * `TIMON_BACKUP_MAX_AGE_DAYS`), pruned right after each archive, instead of a
 * hard-coded 7.
 */
import { existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-backup-retention-'));
process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';
delete process.env.TIMON_BACKUP_KEEP;
delete process.env.TIMON_BACKUP_MAX_AGE_DAYS;

import { test } from 'node:test';
import assert from 'node:assert/strict';

const HOME = process.env.TIMON_HOME;
const { backupRetention, backupStatus, backupsDir, pruneBackupArchives, runNightlyBackup, BACKUP_KEEP } = await import('./routines.js');
const { setSetting } = await import('./settings.js');

function archivesIn(dir: string): string[] {
  return readdirSync(dir).filter((n) => /^timon-\d{4}-\d{2}-\d{2}\.tar\.gz$/.test(n)).sort();
}

function seedDays(dir: string, month: string, from: number, to: number): void {
  mkdirSync(dir, { recursive: true });
  for (let day = from; day <= to; day++) {
    writeFileSync(join(dir, `timon-2026-${month}-${String(day).padStart(2, '0')}.tar.gz`), `a-${day}`);
  }
}

test('defaults: 7 archives, no age limit', () => {
  assert.deepEqual(backupRetention(), { keep: BACKUP_KEEP, maxAgeDays: 0 });
  const st = backupStatus();
  assert.equal(st.keep, 7);
  assert.equal(st.max_age_days, 0);
});

test('keep: only the N newest survive', () => {
  const dir = mkdtempSync(join(tmpdir(), 'timon-retention-keep-'));
  seedDays(dir, '08', 10, 15);
  writeFileSync(join(dir, 'notes.txt'), 'untouched');
  const dropped = pruneBackupArchives(dir, { keep: 3, maxAgeDays: 0 });
  assert.deepEqual(dropped, ['timon-2026-08-12.tar.gz', 'timon-2026-08-11.tar.gz', 'timon-2026-08-10.tar.gz']);
  assert.deepEqual(readdirSync(dir).sort(), ['notes.txt', 'timon-2026-08-13.tar.gz', 'timon-2026-08-14.tar.gz', 'timon-2026-08-15.tar.gz']);
});

test('max age: archives older than the limit go, even under the count', () => {
  const dir = mkdtempSync(join(tmpdir(), 'timon-retention-age-'));
  seedDays(dir, '08', 1, 20);
  const now = new Date(2026, 7, 20, 3, 31, 0);
  pruneBackupArchives(dir, { keep: 30, maxAgeDays: 5 }, now);
  // Cutoff: 15 Aug 03:31 — the 15th (midnight) is already past it.
  assert.deepEqual(archivesIn(dir), [
    'timon-2026-08-16.tar.gz', 'timon-2026-08-17.tar.gz', 'timon-2026-08-18.tar.gz',
    'timon-2026-08-19.tar.gz', 'timon-2026-08-20.tar.gz',
  ]);
});

test('the newest archive survives an age limit shorter than the gap since it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'timon-retention-newest-'));
  seedDays(dir, '01', 1, 3);
  pruneBackupArchives(dir, { keep: 7, maxAgeDays: 1 }, new Date(2026, 9, 28));
  assert.deepEqual(archivesIn(dir), ['timon-2026-01-03.tar.gz']);
});

test('a numeric retention still means a count (older callers)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'timon-retention-num-'));
  seedDays(dir, '08', 1, 4);
  pruneBackupArchives(dir, 2);
  assert.deepEqual(archivesIn(dir), ['timon-2026-08-03.tar.gz', 'timon-2026-08-04.tar.gz']);
});

test('settings drive the status and the prune that follows a backup', async () => {
  assert.deepEqual(setSetting('TIMON_BACKUP_KEEP', '3'), { ok: true });
  assert.deepEqual(setSetting('TIMON_BACKUP_MAX_AGE_DAYS', '30'), { ok: true });
  try {
    const st = backupStatus();
    assert.equal(st.keep, 3);
    assert.equal(st.max_age_days, 30);

    mkdirSync(join(HOME, 'agents', 'witness'), { recursive: true });
    writeFileSync(join(HOME, 'agents', 'witness', 'config.json'), '{}\n');
    seedDays(backupsDir(), '08', 15, 21);
    const result = await runNightlyBackup(new Date(2026, 7, 22, 3, 30, 0));
    assert.ok(result.bytes > 0);
    assert.deepEqual(archivesIn(backupsDir()), [
      'timon-2026-08-20.tar.gz', 'timon-2026-08-21.tar.gz', 'timon-2026-08-22.tar.gz',
    ]);
  } finally {
    setSetting('TIMON_BACKUP_KEEP', null);
    setSetting('TIMON_BACKUP_MAX_AGE_DAYS', null);
  }
});

test('keeping zero archives is refused at write time', () => {
  const r = setSetting('TIMON_BACKUP_KEEP', '0');
  assert.equal(r.ok, false);
  assert.equal(backupRetention().keep, 7);
});

// A full disk cut `tar` short: the truncated archive kept the day's name, ranked
// newest and pushed valid backups out, while the prune never ran again.

const routines = await import('./routines.js');
const { dbApi } = await import('./db.js');
const { config } = await import('./config/load.js');
const { assertBackupSpace } = await import('./backup-archives.js');
const { freeBytes } = await import('./storage-failure.js');

function backupAlerts() {
  return dbApi.listActiveNotificationsByAnchorPrefix(routines.BACKUP_ALERT_ANCHOR, 'alert');
}

function resetBackupDir(): string {
  const dir = backupsDir();
  mkdirSync(dir, { recursive: true });
  for (const name of readdirSync(dir)) rmSync(join(dir, name), { recursive: true, force: true });
  dbApi.deleteSetting(routines.BACKUP_FAILURES_KEY);
  dbApi.dismissNotificationsByAnchor(routines.BACKUP_ALERT_ANCHOR, 'alert');
  return dir;
}

function failTar(t: import('node:test').TestContext): void {
  const pins = config().host.binaries;
  const tar = pins.tar ?? null;
  pins.tar = process.execPath; // Node rejects tar's -czf argument.
  t.after(() => { pins.tar = tar; });
}

test('a failed export leaves no archive under the day name and evicts nothing', async (t) => {
  const dir = resetBackupDir();
  seedDays(dir, '08', 15, 21);
  failTar(t);
  await assert.rejects(runNightlyBackup(new Date(2026, 7, 22, 3, 30, 0)), /tar failed/);
  assert.deepEqual(readdirSync(dir).filter((name) => !name.startsWith('.')).sort(), archivesIn(dir));
  assert.equal(archivesIn(dir).length, 7);
  assert.equal(archivesIn(dir)[6], 'timon-2026-08-21.tar.gz');
});

test('an unfinished export is not counted and is cleared by the next run', async () => {
  const dir = resetBackupDir();
  seedDays(dir, '08', 18, 20);
  writeFileSync(join(dir, `timon-2026-08-21.tar.gz${routines.BACKUP_PARTIAL_SUFFIX}`), 'cut');
  writeFileSync(join(dir, 'other.partial'), 'not ours');
  pruneBackupArchives(dir, { keep: 3, maxAgeDays: 0 });
  assert.deepEqual(archivesIn(dir), ['timon-2026-08-18.tar.gz', 'timon-2026-08-19.tar.gz', 'timon-2026-08-20.tar.gz']);

  const result = await runNightlyBackup(new Date(2026, 7, 22, 3, 30, 0));
  assert.equal(result.out, join(dir, 'timon-2026-08-22.tar.gz'));
  assert.ok(existsSync(result.out));
  assert.ok(!readdirSync(dir).some((n) => n.startsWith('timon-') && n.endsWith('.partial')));
  assert.ok(existsSync(join(dir, 'other.partial')), 'a file the backup did not write stays');
});

test('the prune runs even when the export fails', async (t) => {
  const dir = resetBackupDir();
  seedDays(dir, '08', 1, 12);
  failTar(t);
  await assert.rejects(runNightlyBackup(new Date(2026, 7, 13, 3, 30, 0)), /tar failed/);
  assert.deepEqual(archivesIn(dir), [
    'timon-2026-08-06.tar.gz', 'timon-2026-08-07.tar.gz', 'timon-2026-08-08.tar.gz', 'timon-2026-08-09.tar.gz',
    'timon-2026-08-10.tar.gz', 'timon-2026-08-11.tar.gz', 'timon-2026-08-12.tar.gz',
  ]);
});

test('not enough free space: no export, an alert at once', { skip: process.platform === 'win32' }, async () => {
  const dir = resetBackupDir();
  const archive = join(dir, 'timon-2026-08-20.tar.gz');
  writeFileSync(archive, Buffer.alloc(1000));
  assert.throws(
    () => assertBackupSpace(dir, 1400),
    (err: unknown) => err instanceof routines.BackupSpaceError && err.needed === 1500 && err.free === 1400,
  );
  const available = freeBytes(dir);
  assert.notEqual(available, null);
  // A sparse file exercises the actual worker preflight without filling the test disk.
  truncateSync(archive, (available ?? 0) + 1024);
  await assert.rejects(runNightlyBackup(new Date(2026, 7, 21, 3, 30, 0)), routines.BackupSpaceError);
  assert.deepEqual(readdirSync(dir).filter((name) => !name.startsWith('.')), ['timon-2026-08-20.tar.gz']);
  const alerts = backupAlerts();
  assert.equal(alerts.length, 1);
  assert.match(alerts[0].title, /disk almost full/);

  await assert.rejects(runNightlyBackup(new Date(2026, 7, 22, 3, 30, 0)), routines.BackupSpaceError);
  assert.equal(backupAlerts().length, 1, 'one card while the first is open');
});

test('enough free space: the export runs', async () => {
  const dir = resetBackupDir();
  writeFileSync(join(dir, 'timon-2026-08-20.tar.gz'), Buffer.alloc(1000));
  assert.doesNotThrow(() => assertBackupSpace(dir, 1500));
  const result = await runNightlyBackup(new Date(2026, 7, 21, 3, 30, 0));
  assert.ok(existsSync(result.out));
});

test('three failed nights in a row raise an alert, a success clears it', async (t) => {
  resetBackupDir();
  const tar = config().host.binaries.tar ?? null;
  failTar(t);
  const fail = (day: number) => assert.rejects(runNightlyBackup(new Date(2026, 7, day, 3, 30, 0)), /tar failed/);
  await fail(10);
  await fail(11);
  assert.equal(backupAlerts().length, 0, 'two bad nights stay quiet');
  await fail(12);
  const alerts = backupAlerts();
  assert.equal(alerts.length, 1);
  assert.match(alerts[0].title, /failed 3 nights in a row/);
  assert.match(alerts[0].body ?? '', /tar failed/);
  await fail(13);
  assert.equal(backupAlerts().length, 1);
  assert.equal(dbApi.getAllSettings()[routines.BACKUP_FAILURES_KEY], '4');

  config().host.binaries.tar = tar;
  await runNightlyBackup(new Date(2026, 7, 14, 3, 30, 0));
  assert.equal(backupAlerts().length, 0);
  assert.equal(dbApi.getAllSettings()[routines.BACKUP_FAILURES_KEY], undefined);
});

test('a pre-rebuild snapshot leaves once the kept window is newer than it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'timon-retention-snapshot-'));
  writeFileSync(join(dir, 'pre-rebuild-2026-08-10.db'), 'snapshot');
  seedDays(dir, '08', 9, 11);
  pruneBackupArchives(dir, { keep: 3, maxAgeDays: 0 });
  assert.ok(existsSync(join(dir, 'pre-rebuild-2026-08-10.db')), 'one newer archive only: kept');

  seedDays(dir, '08', 12, 13);
  const dropped = pruneBackupArchives(dir, { keep: 3, maxAgeDays: 0 });
  assert.ok(dropped.includes('pre-rebuild-2026-08-10.db'));
  assert.ok(!existsSync(join(dir, 'pre-rebuild-2026-08-10.db')));
});

test('a pre-rebuild snapshot past the age limit leaves only behind a newer archive', () => {
  const dir = mkdtempSync(join(tmpdir(), 'timon-retention-snapshot-age-'));
  writeFileSync(join(dir, 'pre-rebuild-2026-08-01.db'), 'snapshot');
  const now = new Date(2026, 7, 20, 3, 30, 0);
  pruneBackupArchives(dir, { keep: 7, maxAgeDays: 5 }, now);
  assert.ok(existsSync(join(dir, 'pre-rebuild-2026-08-01.db')), 'no backup since: kept');
  seedDays(dir, '08', 19, 19);
  pruneBackupArchives(dir, { keep: 7, maxAgeDays: 5 }, now);
  assert.ok(!existsSync(join(dir, 'pre-rebuild-2026-08-01.db')));
});
