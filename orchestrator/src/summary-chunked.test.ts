import './test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitTranscript, summarizeTranscript } from './summary.js';

test('splitTranscript keeps short transcripts in one piece', () => {
  const text = 'User: hi\n\nAssistant: hello';
  assert.deepEqual(splitTranscript(text, 100), [text]);
});

test('splitTranscript packs paragraphs within maxChars and slices oversized blocks', () => {
  const blockA = 'A'.repeat(40);
  const blockB = 'B'.repeat(40);
  const huge = `${'L'.repeat(55)}\n${'M'.repeat(55)}`;
  const blockC = 'C'.repeat(30);
  const transcript = [blockA, blockB, huge, blockC].join('\n\n');

  const sections = splitTranscript(transcript, 90);
  assert.equal(sections.length, 4);
  for (const s of sections) {
    assert.ok(s.length <= 90, `section length ${s.length} exceeded 90`);
  }
  assert.equal(sections[0], `${blockA}\n\n${blockB}`);
  assert.equal(sections[1], `${'L'.repeat(55)}\n`);
  assert.equal(sections[2], 'M'.repeat(55));
  assert.equal(sections[3], blockC);
});

test('summarizeTranscript uses a single pass when under the threshold', async () => {
  const calls: Array<{ prompt: string; timeoutMs: number }> = [];
  const out = await summarizeTranscript(
    'User: hello\n\nAssistant: world',
    async (prompt, _sys, timeoutMs) => {
      calls.push({ prompt, timeoutMs });
      return 'short summary';
    },
    { timeoutMs: 30_000, singlePassMaxChars: 100 },
  );
  assert.equal(out, 'short summary');
  assert.equal(calls.length, 1);
  assert.match(calls[0]!.prompt, /^# Transcript to summarize\n\n/);
  assert.equal(calls[0]!.timeoutMs, 30_000);
});

test('summarizeTranscript runs sections in parallel waves then merges in order', async () => {
  const transcript = ['p1'.repeat(25), 'p2'.repeat(25), 'p3'.repeat(25), 'p4'.repeat(25)].join('\n\n');
  let active = 0;
  let maxActive = 0;
  const seenPrompts: string[] = [];

  const out = await summarizeTranscript(
    transcript,
    async (prompt) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      seenPrompts.push(prompt);
      await new Promise((r) => setTimeout(r, 15));
      active -= 1;
      const match = prompt.match(/section (\d+) of (\d+)/);
      if (match) return `S${match[1]}`;
      return `MERGED:\n${prompt}`;
    },
    {
      timeoutMs: 30_000,
      singlePassMaxChars: 120,
      sectionMaxChars: 55,
      concurrency: 3,
    },
  );

  assert.equal(maxActive, 3, 'sections should execute concurrently up to concurrency limit');
  assert.equal(seenPrompts.length, 5); // 4 sections + 1 merge
  assert.match(out, /^MERGED:/);
  // Section order is preserved in the merge input regardless of completion order.
  const idx1 = out.indexOf('## Section 1 of 4\n\nS1');
  const idx2 = out.indexOf('## Section 2 of 4\n\nS2');
  const idx3 = out.indexOf('## Section 3 of 4\n\nS3');
  const idx4 = out.indexOf('## Section 4 of 4\n\nS4');
  assert.ok(idx1 >= 0 && idx2 > idx1 && idx3 > idx2 && idx4 > idx3);
});

test('summarizeTranscript enforces the shared deadline across stages', async () => {
  let clock = 1_000;
  const timeouts: number[] = [];
  const transcript = `${'X'.repeat(60)}\n\n${'Y'.repeat(60)}`;

  await assert.rejects(
    () => summarizeTranscript(
      transcript,
      async (_prompt, _sys, timeoutMs) => {
        timeouts.push(timeoutMs);
        await Promise.resolve();
        // Simulate section wave exhausting the entire budget before the merge call.
        clock += 5_000;
        return 'part';
      },
      {
        timeoutMs: 5_000,
        singlePassMaxChars: 80,
        sectionMaxChars: 65,
        concurrency: 2,
        now: () => clock,
      },
    ),
    /summary timeout after 5s/,
  );
  assert.equal(timeouts.length, 2);
});
