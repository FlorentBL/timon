/**
 * A pinned path refused by the daemon reads as a sentence of the locale: never
 * the path that was typed, never the daemon's own text for an unknown code.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { binaryErrorMessage, pinPathExample } from '@/lib/backend-binaries';

test('daemon codes become sentences; an unknown one does not leak its message', () => {
  assert.match(binaryErrorMessage(400, 'path_not_executable'), /not executable/);
  assert.match(binaryErrorMessage(403, 'operator'), /superadmin/);
  assert.match(binaryErrorMessage(500, 'whatever'), /error 500/);
});

test('a program pinned elsewhere is refused by name (#1101)', () => {
  assert.equal(binaryErrorMessage(400, 'wrong_program', 'codex'), 'This file is not the codex CLI.');
  assert.equal(binaryErrorMessage(400, 'no_answer', 'codex'), 'This program did not answer `--version`: it failed, took too long or printed too much.');
  assert.match(binaryErrorMessage(400, 'unsupported_program', 'codex'), /^On Windows, pick the program's \.exe/);
});

test('the example path is the program\'s own, on the OS of the daemon that runs it', () => {
  assert.equal(pinPathExample('codex', [null, null], 'Mozilla/5.0 (X11; Linux x86_64)'), '/usr/local/bin/codex');
  assert.equal(pinPathExample('codex', [null, null], 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'), 'C:\\…\\codex.exe');
  // A path the daemon reported wins over the browser: a phone reading a Windows daemon.
  assert.equal(pinPathExample('codex', ['C:\\Users\\u\\AppData\\Roaming\\npm\\codex.cmd'], 'Mozilla/5.0 (iPhone)'), 'C:\\…\\codex.exe');
  assert.equal(pinPathExample('codex', ['/opt/homebrew/bin/codex'], 'Mozilla/5.0 (Windows NT 10.0)'), '/usr/local/bin/codex');
});
