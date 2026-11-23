import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, test } from 'node:test';
import Database from 'better-sqlite3';

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-backup-recovery-'));
process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';
const { db, dbApi } = await import('./db.js');
const { config } = await import('./config/load.js');
const { listDeliveries } = await import('./triggers/store.js');
const { BACKUP_ROUTINE_ID: id, backupsDir, backupArchiveName, createRoutine, enableBackupRoutine, tickRoutines } =
  await import('./routines.js');
const { importTimon } = await import('./export.js');
const when = Date.now() - 1000;
const dir = backupsDir();
const out = join(dir, backupArchiveName());
const receiptPath = join(dir, '.nightly-backup.receipt.json');
const due = () => dbApi.getRoutine(id)?.next_run_at;
const journal = () => listDeliveries(id);

beforeEach(() => {
  db.exec('DROP TRIGGER IF EXISTS backup_stop_before_commit');
  dbApi.deleteRoutine(id);
  db.prepare('DELETE FROM trigger_deliveries WHERE trigger_id = ?').run(id);
  rmSync(dir, { recursive: true, force: true });
  enableBackupRoutine();
  dbApi.updateRoutine(id, { next_run_at: when });
  delete config().host.binaries.tar;
});

async function publishWithoutCommitting(): Promise<void> {
  db.exec(`CREATE TRIGGER backup_stop_before_commit BEFORE UPDATE OF last_run_at ON triggers
           WHEN OLD.id = '${id}' BEGIN SELECT RAISE(ABORT, 'simulated failed commit'); END`);
  await tickRoutines();
  assert.equal(due(), when);
  assert.equal(dbApi.getRoutine(id)?.last_run_at, null);
  assert.equal(journal().length, 0, 'the delivery and schedule update roll back together');
  assert.ok(existsSync(out));
  db.exec('DROP TRIGGER backup_stop_before_commit');
}

test('the held worker lock does not advance the occurrence or delay an ordinary routine', async () => {
  const lock = new Database(join(dir, '.nightly-backup.sqlite'));
  lock.exec('BEGIN IMMEDIATE');
  try {
    const r = createRoutine({ name: 'other', agent_name: 'probe', prompt: 'noop', cron_expr: '0 4 * * *' });
    dbApi.updateRoutine(r.id, { next_run_at: when });
    const pending = tickRoutines();
    assert.ok(dbApi.listTasks().some((task) => task.routine_id === r.id));
    await Promise.all([pending, tickRoutines()]);
    assert.equal(due(), when);
    assert.equal(journal().length, 0);
    assert.ok(!existsSync(out));
  } finally {
    lock.close();
  }
  await Promise.all([tickRoutines(), tickRoutines()]);
  assert.ok((due() ?? 0) > Date.now());
  assert.equal(journal().length, 1);
  assert.ok(existsSync(out));
});

test('a published archive is recovered once with the original bytes and is restorable', async () => {
  await publishWithoutCommitting();
  const original = readFileSync(out);
  config().host.binaries.tar = process.execPath; // A new export would fail.
  await Promise.all([tickRoutines(), tickRoutines()]);
  delete config().host.binaries.tar;
  assert.ok((due() ?? 0) > Date.now());
  assert.deepEqual(readFileSync(out), original);
  assert.deepEqual(journal().map((d) => d.status), ['received']);
  assert.match(journal()[0]?.reason ?? '', /recovered/);
  const restored = mkdtempSync(join(tmpdir(), 'timon-backup-restored-'));
  const result = importTimon({ file: out, to: restored });
  assert.equal(result.manifest.withArchive, false);
  const copy = new Database(join(restored, 'timon.db'), { readonly: true });
  try { assert.equal(copy.pragma('integrity_check', { simple: true }), 'ok'); }
  finally { copy.close(); }
});

test('a durable receipt also recovers the archive from its pre-rename partial', async () => {
  await publishWithoutCommitting();
  const { partial, startedAt } = JSON.parse(readFileSync(receiptPath, 'utf8')) as { partial: string; startedAt: number };
  renameSync(out, join(dir, partial));
  config().host.binaries.tar = process.execPath;
  await tickRoutines();
  assert.equal(dbApi.getRoutine(id)?.last_run_at, startedAt);
  assert.ok(existsSync(out));
  assert.ok(!readdirSync(dir).some((name) => name.endsWith('.partial')));
  assert.deepEqual(journal().map((d) => d.status), ['received']);
});

test('an archive without its receipt or with other bytes does not count as a run', async () => {
  await publishWithoutCommitting();
  const proof = readFileSync(receiptPath);
  rmSync(receiptPath);
  await tickRoutines();
  assert.equal(due(), when);
  assert.equal(journal().length, 0);
  writeFileSync(receiptPath, proof);
  const modified = readFileSync(out);
  modified[modified.length - 1]! ^= 1;
  writeFileSync(out, modified);
  await tickRoutines();
  assert.equal(due(), when);
  assert.equal(dbApi.getRoutine(id)?.last_run_at, null);
  assert.equal(journal().length, 0);
  assert.deepEqual(readFileSync(out), modified);
});

test('a replaced occurrence is not marked, even if its older worker succeeded', async () => {
  const tick = tickRoutines();
  const future = Date.now() + 86_400_000;
  dbApi.updateRoutine(id, { next_run_at: future });
  await tick;
  assert.equal(due(), future);
  assert.equal(journal().length, 0);
  assert.equal(dbApi.getRoutine(id)?.last_run_at, null);
});

test('an ordinary export failure is journaled but is not a successful run', async () => {
  config().host.binaries.tar = process.execPath;
  await tickRoutines();
  assert.ok((due() ?? 0) > Date.now());
  assert.equal(dbApi.getRoutine(id)?.last_run_at, null);
  assert.deepEqual(journal().map((d) => d.status), ['error']);
  assert.ok(!existsSync(out));
});
