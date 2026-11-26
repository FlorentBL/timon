/** The size cap of an agent's `log.jsonl` (`agent-log.ts`), on a scratch folder. */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { appendCappedLine, rotatedLogPath, rotateIfOver } from './agent-log.js';

const scratch = (): string => join(mkdtempSync(join(tmpdir(), 'timon-agent-log-')), 'log.jsonl');
const lines = (file: string): string[] => readFileSync(file, 'utf8').split('\n').filter(Boolean);

test('the rotated file sits next to the log', () => {
  assert.equal(rotatedLogPath(join('a', 'memory', 'log.jsonl')), join('a', 'memory', 'log.1.jsonl'));
});

test('under the cap, lines are appended to the same file', () => {
  const file = scratch();
  for (let i = 0; i < 5; i++) appendCappedLine(file, JSON.stringify({ i }), 1000);
  assert.equal(lines(file).length, 5);
  assert.equal(existsSync(rotatedLogPath(file)), false);
});

test('past the cap, the file becomes log.1.jsonl and a new one starts; at most two caps stay', () => {
  const file = scratch();
  const line = JSON.stringify({ text: 'x'.repeat(80) });
  for (let i = 0; i < 100; i++) appendCappedLine(file, line, 1000);
  assert.ok(statSync(file).size <= 1000, 'the live file stays under the cap');
  assert.ok(statSync(rotatedLogPath(file)).size <= 1000, 'the rotated one too');
  for (const l of [...lines(file), ...lines(rotatedLogPath(file))]) assert.deepEqual(JSON.parse(l), JSON.parse(line));
});

test('a file far past the cap keeps only its last whole lines, never a cut one', () => {
  const file = scratch();
  const rows = Array.from({ length: 5000 }, (_, i) => JSON.stringify({ i, pad: 'y'.repeat(i % 37) }));
  writeFileSync(file, rows.join('\n') + '\n');
  const before = statSync(file).size;
  assert.ok(before > 3 * 4096);

  assert.equal(rotateIfOver(file, 4096, 10), true);
  assert.equal(existsSync(file), false);
  const kept = lines(rotatedLogPath(file));
  assert.ok(statSync(rotatedLogPath(file)).size <= 4096);
  assert.ok(kept.length > 10);
  for (const l of kept) JSON.parse(l);
  assert.deepEqual(JSON.parse(kept[kept.length - 1]!), JSON.parse(rows[rows.length - 1]!), 'the newest line is kept');
  assert.equal(existsSync(`${rotatedLogPath(file)}.tmp`), false);
});

test('a tail spanning several read chunks is copied whole', () => {
  const file = scratch();
  const row = JSON.stringify({ pad: 'z'.repeat(1000) });
  writeFileSync(file, `${row}\n`.repeat(8000));
  const cap = 3 * 1024 * 1024;
  assert.equal(rotateIfOver(file, cap, 1), true);
  const kept = lines(rotatedLogPath(file));
  assert.ok(kept.length >= Math.floor(cap / (row.length + 1)) - 1);
  for (const l of kept) assert.equal(l, row);
});

test('a cap of 0 never rotates', () => {
  const file = scratch();
  writeFileSync(file, 'a'.repeat(10_000));
  appendCappedLine(file, '{}', 0);
  assert.equal(existsSync(rotatedLogPath(file)), false);
});
