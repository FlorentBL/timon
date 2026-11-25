/**
 * `declares.binary.identity`: a program is checked by what it prints about itself, the answer is kept per file,
 * and a refusal says which file, what kind of answer it got and what to do — never what it printed. Two stubs stand for two CLIs that both install
 * an `agent`.
 */
import '../test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const {
  assertDeclaredIdentity, binaryIdentityRefusal, BinaryIdentityError, checkBinaryIdentity, probeEnv, probeLaunch, resetBinaryIdentityCache,
  testIdentityPattern,
} = await import('./binary-identity.js');
const { setDeclaredBinariesSource } = await import('../host/declared-binaries.js');
const { binaryIdentityProblem, declarationProblems } = await import('./provider-declarations.js');

const posix = process.platform !== 'win32';
const dir = mkdtempSync(join(tmpdir(), 'timon-identity-'));
process.on('exit', () => rmSync(dir, { recursive: true, force: true }));

function stub(name: string, body: string): string {
  const file = join(dir, name);
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
  return file;
}

const CURSOR = { pattern: '^\\d{4}\\.\\d{2}\\.\\d{2}', expected: "Cursor's agent CLI" };

test('the right program passes, a namesake is refused with a fixed sentence', { skip: !posix }, async () => {
  resetBinaryIdentityCache();
  const right = stub('cursor-agent', 'echo "2026.10.16-0a1b2c3"');
  const wrong = stub('agent', 'echo "grok-cli 0.9.1" >&2');
  assert.deepEqual(await checkBinaryIdentity(right, CURSOR), { ok: true });
  assert.deepEqual(await checkBinaryIdentity(wrong, CURSOR), { ok: false, reason: 'mismatch' });
  assert.equal(
    binaryIdentityRefusal('backend `cursor`', wrong, CURSOR, 'mismatch'),
    "`agent` is not Cursor's agent CLI, the program backend `cursor` runs: its `--version` answer does not match. "
    + 'Install the right program, or pin its path in `host.binaries` (timon.config.json).',
  );
});

/**
 * A stranger's `--version` can print anything: a private path, a token it read from the environment. None of
 * it reaches a refusal, a log or a report, and neither does the full path of the file, which names the home.
 */
test('what the program printed and its full path never reach the refusal', { skip: !posix }, async () => {
  resetBinaryIdentityCache();
  const secret = 'sk-live-0123456789abcdefSECRET';
  const leaky = stub('leaky', `echo "token=${secret} at /home/someone/.private/vault"`);
  const result = await checkBinaryIdentity(leaky, CURSOR);
  assert.deepEqual(result, { ok: false, reason: 'mismatch' });
  for (const reason of ['mismatch', 'no_answer', 'slow_pattern'] as const) {
    const refusal = binaryIdentityRefusal('backend `cursor`', leaky, CURSOR, reason);
    assert.equal(refusal.includes(secret), false, reason);
    assert.equal(refusal.includes('.private'), false, reason);
    assert.equal(refusal.includes(dir), false, `${reason}: the folder of the file is not named`);
    assert.match(refusal, /`leaky`/, `${reason}: the file is named by its own name`);
  }
  await assert.rejects(
    assertDeclaredIdentityFor(leaky),
    (err: unknown) => err instanceof BinaryIdentityError && !err.message.includes(secret) && !err.message.includes(dir),
  );
});

async function assertDeclaredIdentityFor(file: string): Promise<void> {
  setDeclaredBinariesSource(() => [{ names: ['leaky'], identity: CURSOR }]);
  try {
    await assertDeclaredIdentity('leaky', file, 'provider `acme`');
  } finally {
    setDeclaredBinariesSource(() => []);
  }
}

test('the answer is kept per file: replacing the program asks again', { skip: !posix }, async () => {
  resetBinaryIdentityCache();
  const counter = join(dir, 'runs');
  writeFileSync(counter, '');
  const file = stub('counted', `echo x >> "${counter}"; echo "2026.10.16"`);
  await checkBinaryIdentity(file, CURSOR);
  await checkBinaryIdentity(file, CURSOR);
  assert.equal((await import('node:fs')).readFileSync(counter, 'utf8').split('\n').filter(Boolean).length, 1, 'one run for an unchanged file');
  stub('counted', `echo x >> "${counter}"; echo "grok 1.0.0 and some more words to change the size"`);
  assert.equal((await checkBinaryIdentity(file, CURSOR)).ok, false, 'the replaced program is asked again');
});

test('the arguments are the declared ones, and `^` and `$` match a line', { skip: !posix }, async () => {
  resetBinaryIdentityCache();
  const file = stub('args', 'echo "banner"; echo "args: $*"');
  assert.deepEqual(await checkBinaryIdentity(file, { args: ['about', '--short'], pattern: '^args: about --short$' }), { ok: true });
  const long = stub('long', `echo; echo "${'w'.repeat(300)}"; echo second`);
  assert.deepEqual(await checkBinaryIdentity(long, { pattern: '^never$' }), { ok: false, reason: 'mismatch' });
});

test('a program stopped by the timeout is not remembered: the next try asks again', { skip: !posix }, async () => {
  resetBinaryIdentityCache();
  const marker = join(dir, 'slow-once');
  const file = stub('slow-once-agent', `if [ -e "${marker}" ]; then echo "2026.10.16"; else : > "${marker}"; exec sleep 30; fi`);
  assert.deepEqual(await checkBinaryIdentity(file, CURSOR), { ok: false, reason: 'no_answer' });
  assert.deepEqual(await checkBinaryIdentity(file, CURSOR), { ok: true });
});

test('a pattern that backtracks out of control is stopped, the daemon goes on, and the refusal says so', { skip: !posix }, async () => {
  resetBinaryIdentityCache();
  const counter = join(dir, 'runs-slow');
  writeFileSync(counter, '');
  const file = stub('catastrophic', `echo x >> "${counter}"; echo "${'a'.repeat(40)}!"`);
  const evil = { pattern: '^(a+)+$' };
  const started = Date.now();
  const result = await checkBinaryIdentity(file, evil, { runTimeoutMs: 5_000, patternTimeoutMs: 100 });
  assert.deepEqual(result, { ok: false, reason: 'slow_pattern' });
  assert.ok(Date.now() - started < 3_000, 'the match is interrupted, not run to its end');
  await checkBinaryIdentity(file, evil, { runTimeoutMs: 5_000, patternTimeoutMs: 100 });
  assert.equal(readFileSync(counter, 'utf8').split('\n').filter(Boolean).length, 2, 'a timeout is not kept as the answer');
  assert.equal(
    binaryIdentityRefusal('backend `acme`', file, evil, 'slow_pattern'),
    '`catastrophic` could not be checked as the program backend `acme` runs: its `declares.binary.identity.pattern` '
    + 'ran past 250 ms on what `--version` printed. The provider must declare a simpler pattern.',
  );
});

test('a refusal names the field the pattern came from when it is at fault, and no field otherwise', () => {
  const identity = { pattern: '^x', expected: 'Acme' };
  const slow = binaryIdentityRefusal('provider `acme`', '/bin/acme', identity, 'slow_pattern', 'provider.binaries[].identity');
  assert.match(slow, /its `provider\.binaries\[\]\.identity\.pattern` ran past/);
  assert.doesNotMatch(slow, /declares\.binary/);
  assert.match(binaryIdentityRefusal('backend `acme`', '/bin/acme', identity, 'slow_pattern'), /its `declares\.binary\.identity\.pattern` ran past/);
  for (const reason of ['mismatch', 'no_answer'] as const) {
    assert.equal(
      binaryIdentityRefusal('provider `acme`', '/bin/acme', identity, reason, 'provider.binaries[].identity'),
      binaryIdentityRefusal('provider `acme`', '/bin/acme', identity, reason),
      'the program is at fault: the provider has no field to change',
    );
  }
  assert.equal(
    binaryIdentityRefusal('backend `acme`', '/bin/acme', identity, 'no_answer'),
    '`acme`, the program backend `acme` runs, did not answer `--version`. '
    + 'Install the right program, or pin its path in `host.binaries` (timon.config.json).',
  );
});

test('a pattern past its time limit, read from the plugin\'s declaration, names that declaration', { skip: !posix }, async (t) => {
  resetBinaryIdentityCache();
  t.after(() => setDeclaredBinariesSource(() => []));
  setDeclaredBinariesSource(() => [{ names: ['acme-declared'], identity: { pattern: '^(a+)+$' } }]);
  const file = stub('acme-declared', `echo "${'a'.repeat(40)}!"`);
  await assert.rejects(
    assertDeclaredIdentity('acme-declared', file, 'provider `acme`'),
    (err: unknown) => err instanceof BinaryIdentityError && err.message.includes('`declares.binary.identity.pattern`'),
  );
});

test('the pattern keeps its JavaScript meaning: lookarounds, backreferences, lines', () => {
  assert.equal(testIdentityPattern('^(?=\\d)(\\d)\\1\\.', 'banner\n11.2'), true);
  assert.equal(testIdentityPattern('^(\\d)\\1$', 'banner\n12'), false);
  assert.equal(testIdentityPattern('^(a+)+$', `${'a'.repeat(40)}!`, 50), null);
});

test('a program that ignores SIGTERM is killed at the time limit, and the right version printed first is no answer', { skip: !posix }, async () => {
  resetBinaryIdentityCache();
  const file = stub('stubborn', `trap '' TERM; echo "2026.10.16"; exec sleep 30`);
  const started = Date.now();
  const result = await checkBinaryIdentity(file, CURSOR, { runTimeoutMs: 300, patternTimeoutMs: 250 });
  assert.ok(Date.now() - started < 5_000, `the check returned after ${Date.now() - started} ms`);
  assert.deepEqual(result, { ok: false, reason: 'no_answer' }, 'a program that never finished did not answer');
});

/** The identity is read only from a run that succeeded: a program can print the expected line and then fail. */
test('the right version followed by exit 1 is no answer, and is asked again next time', { skip: !posix }, async () => {
  resetBinaryIdentityCache();
  const counter = join(dir, 'runs-exit1');
  writeFileSync(counter, '');
  const file = stub('fails-after', `echo x >> "${counter}"; echo "2026.10.16"; exit 1`);
  assert.deepEqual(await checkBinaryIdentity(file, CURSOR), { ok: false, reason: 'no_answer' });
  assert.deepEqual(await checkBinaryIdentity(file, CURSOR), { ok: false, reason: 'no_answer' });
  assert.equal(readFileSync(counter, 'utf8').split('\n').filter(Boolean).length, 2, 'a failed run is not remembered');
});

test('the right version drowned in more than the output cap is no answer', { skip: !posix }, async () => {
  resetBinaryIdentityCache();
  const file = stub('floods', 'echo "2026.10.16"; head -c 200000 /dev/zero | tr "\\0" x; echo');
  assert.deepEqual(await checkBinaryIdentity(file, CURSOR), { ok: false, reason: 'no_answer' });
});

/** Gone, or a zombie nobody reaped yet: either way it runs nothing any more. */
function running(pid: number): boolean {
  try { process.kill(pid, 0); } catch { return false; }
  if (process.platform !== 'linux') return true;
  // portability: Linux pseudo-fs, behind the platform guard above
  try { return !/^\d+ \(.*\) Z /s.test(readFileSync(`/proc/${pid}/stat`, 'utf8')); } catch { return false; }
}

async function stopsRunning(pid: number, withinMs = 2_000): Promise<boolean> {
  for (const end = Date.now() + withinMs; Date.now() < end; await new Promise((r) => { setTimeout(r, 20); })) {
    if (!running(pid)) return true;
  }
  return !running(pid);
}

// The measure of TODO #730: the script leaves `sleep 8` on its stdout and exits at once.
test('a program that exits and leaves a grandchild on stdout answers at once, and the grandchild is gone', { skip: !posix }, async () => {
  resetBinaryIdentityCache();
  const pidFile = join(dir, 'grandchild-pid');
  const file = stub('leaves-a-child', `sleep 8 &\necho $! > "${pidFile}"\necho "2026.10.16"`);
  const started = Date.now();
  const result = await checkBinaryIdentity(file, CURSOR);
  const took = Date.now() - started;
  const grandchild = Number(readFileSync(pidFile, 'utf8').trim());
  try {
    assert.deepEqual(result, { ok: true }, 'the answer is read');
    assert.ok(took < 2_500, `the check returned after ${took} ms, the limit is 5000`);
    assert.ok(await stopsRunning(grandchild), `sleep ${grandchild} survived the check`);
  } finally {
    if (grandchild > 1) { try { process.kill(grandchild, 'SIGKILL'); } catch { /* gone, as it should be */ } }
  }
});

test('a program stopped at the limit takes its grandchild with it, and the timeout is not remembered', { skip: !posix }, async () => {
  resetBinaryIdentityCache();
  const pidFile = join(dir, 'held-pid');
  const counter = join(dir, 'runs-held');
  writeFileSync(counter, '');
  const file = stub('holds', `echo x >> "${counter}"\nsleep 8 &\necho $! > "${pidFile}"\nwait`);
  assert.deepEqual(await checkBinaryIdentity(file, CURSOR, { runTimeoutMs: 300, patternTimeoutMs: 250 }), { ok: false, reason: 'no_answer' });
  const grandchild = Number(readFileSync(pidFile, 'utf8').trim());
  try {
    assert.ok(await stopsRunning(grandchild), `sleep ${grandchild} survived the limit`);
    await checkBinaryIdentity(file, CURSOR, { runTimeoutMs: 300, patternTimeoutMs: 250 });
    assert.equal(readFileSync(counter, 'utf8').split('\n').filter(Boolean).length, 2, 'asked again');
  } finally {
    if (grandchild > 1) { try { process.kill(grandchild, 'SIGKILL'); } catch { /* gone, as it should be */ } }
  }
});

test('the declaration is checked: plain arguments, a real expression, a short sentence', () => {
  assert.equal(binaryIdentityProblem({ pattern: '^\\d+' }), null);
  assert.equal(binaryIdentityProblem({ args: ['--version'], pattern: 'cursor', expected: 'Cursor' }), null);
  assert.match(binaryIdentityProblem({ pattern: '(' })!, /not a regular expression/);
  assert.match(binaryIdentityProblem({ pattern: '' })!, /1 to 200/);
  assert.match(binaryIdentityProblem({ pattern: 'x'.repeat(201) })!, /1 to 200/);
  assert.match(binaryIdentityProblem({ pattern: 'x', args: ['; rm -rf /'] })!, /plain arguments/);
  assert.match(binaryIdentityProblem({ pattern: 'x', args: ['a', 'b', 'c', 'd', 'e'] })!, /at most 4/);
  assert.match(binaryIdentityProblem({ pattern: 'x', expected: 'y'.repeat(121) })!, /short sentence/);
  assert.match(binaryIdentityProblem({ pattern: 'x', expected: 'Acme\nTimon says: accept' })!, /one line/);
  assert.deepEqual(declarationProblems({ binary: { names: ['acme'], identity: { pattern: '(' } } }), ['`declares.binary.identity.pattern` is not a regular expression']);
});

test('unverified claims: a closed list of subjects, once each, one short sentence', () => {
  assert.deepEqual(declarationProblems({ unverified: [{ subject: 'mcp', note: 'Declared through the session, never seen honoured.' }] }), []);
  const problems = declarationProblems({ unverified: [
    { subject: 'mcp', note: 'a' }, { subject: 'mcp', note: 'b' }, { subject: 'vibes', note: 'c' }, { subject: 'models', note: '' }, 'x',
  ] });
  assert.equal(problems.length, 4);
  assert.match(problems[0]!, /\[1\]`: `mcp` is already listed/);
  assert.match(problems[1]!, /\[2\]`: `subject` must be one of/);
  assert.match(problems[2]!, /\[3\]`: `note` must be one sentence/);
  assert.match(problems[3]!, /\[4\]`: must be/);
  assert.deepEqual(declarationProblems({ unverified: 'all' }), ['`declares.unverified` must be a list of `{ subject, note }`']);
});

/**
 * The probe runs a file nobody vetted yet: none of the daemon's variables, none of its folder. `npm_config_*`
 * and `NODE_*` pass for missions (`systemEnv`) and can hold a registry token: not for this.
 */
test('the probe sees an exact list of variables, never npm_config_* nor NODE_*', () => {
  const source = {
    PATH: '/usr/bin', HOME: '/home/u', LANG: 'C.UTF-8', TEMP: '/tmp', TMP: '/tmp',
    npm_config__authToken: 'npm-secret', npm_config_registry: 'https://r.example', NODE_OPTIONS: '--require /x.js', NODE_AUTH_TOKEN: 'node-secret',
    TIMON_DAEMON_TOKEN: 'daemon-secret', TIMON_HOME: '/home/u/.timon', LC_ALL: 'C', XDG_CONFIG_HOME: '/home/u/.config', SSH_AUTH_SOCK: '/run/agent',
    path: '/lower-case-is-another-variable-here',
  };
  assert.deepEqual(probeEnv(source, 'linux'), { PATH: '/usr/bin', HOME: '/home/u', LANG: 'C.UTF-8', TEMP: '/tmp', TMP: '/tmp' });
  assert.deepEqual(
    probeEnv({ Path: 'C:\\Windows', USERPROFILE: 'C:\\Users\\u', SYSTEMROOT: 'C:\\Windows', Temp: 'C:\\T', NPM_CONFIG__AUTHTOKEN: 'x', ComSpec: 'cmd.exe' }, 'win32'),
    { Path: 'C:\\Windows', USERPROFILE: 'C:\\Users\\u', SYSTEMROOT: 'C:\\Windows', Temp: 'C:\\T' },
    'Windows matches names whatever their case, and keeps the spelling it read',
  );
});

test('the probe runs in an empty folder of its own, removed afterwards, and without the daemon\'s npm token', { skip: !posix }, async (t) => {
  resetBinaryIdentityCache();
  const saved = { npm: process.env.npm_config__authToken, node: process.env.NODE_OPTIONS };
  t.after(() => {
    for (const [key, value] of [['npm_config__authToken', saved.npm], ['NODE_OPTIONS', saved.node]] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  process.env.npm_config__authToken = 'npm-secret-token';
  process.env.NODE_OPTIONS = '--max-old-space-size=64';
  const seen = join(dir, 'probe-seen');
  const file = stub('nosy', [
    `{ pwd; ls -A | wc -l; env | cut -d= -f1 | sort | tr '\\n' ' '; } > "${seen}"`,
    '[ -z "$npm_config__authToken" ] && [ -z "$NODE_OPTIONS" ] && echo "2026.10.16"',
  ].join('\n'));
  assert.deepEqual(await checkBinaryIdentity(file, CURSOR), { ok: true }, 'neither variable reached the program');
  const [cwd, entries, names] = readFileSync(seen, 'utf8').split('\n');
  assert.notEqual(cwd, process.cwd(), 'not the daemon\'s folder');
  assert.match(cwd!, /timon-identity-/);
  assert.equal(entries!.trim(), '0', 'an empty folder');
  assert.equal(existsSync(cwd!), false, 'removed once the program is done');
  const allowed = new Set(['PATH', 'HOME', 'USERPROFILE', 'SystemRoot', 'TEMP', 'TMP', 'LANG', 'PWD', 'SHLVL', '_', 'OLDPWD']);
  assert.deepEqual(names!.trim().split(' ').filter((name) => name && !allowed.has(name)), [], 'only the listed variables, and what sh adds');
});

/** On Windows the probe never goes through `cmd.exe`: a `.exe`, or an npm shim it reads line for line. */
test('Windows: only a .exe or a known npm shim is started, anything else is refused without a shell', () => {
  assert.deepEqual(probeLaunch('C:\\x\\codex.exe', ['--version'], 'win32', () => null), { file: 'C:\\x\\codex.exe', args: ['--version'] });
  assert.deepEqual(probeLaunch('/usr/bin/codex', ['--version'], 'linux', () => null), { file: '/usr/bin/codex', args: ['--version'] });
  for (const refused of ['C:\\x\\run.bat', 'C:\\x\\tool.com', 'C:\\x\\codex', 'C:\\x\\codex.ps1', 'C:\\x\\unreadable.cmd']) {
    assert.equal(probeLaunch(refused, ['--version'], 'win32', () => 'C:\\node\\node.exe'), null, refused);
  }

  const npm = mkdtempSync(join(tmpdir(), 'timon-identity-npm-'));
  try {
    const target = 'node_modules\\@openai\\codex\\bin\\codex.js';
    mkdirSync(join(npm, 'node_modules', '@openai', 'codex', 'bin'), { recursive: true });
    writeFileSync(join(npm, 'node_modules', '@openai', 'codex', 'bin', 'codex.js'), '');
    const shim = join(npm, 'codex.cmd');
    writeFileSync(shim, ['@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start', 'SETLOCAL', 'CALL :find_dp0', '',
      'IF EXIST "%dp0%\\node.exe" (', '  SET "_prog=%dp0%\\node.exe"', ') ELSE (', '  SET "_prog=node"', '  SET PATHEXT=%PATHEXT:;.JS;=;%', ')', '',
      `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${target}" %*`, ''].join('\r\n'));
    const launch = probeLaunch(shim, ['--version'], 'win32', () => 'C:\\node\\node.exe');
    assert.deepEqual(launch, { file: 'C:\\node\\node.exe', args: [join(npm, 'node_modules', '@openai', 'codex', 'bin', 'codex.js'), '--version'] });
    assert.equal(probeLaunch(shim, ['--version'], 'win32', () => null), null, 'no runtime to start it directly: refused, not cmd.exe');
    assert.equal(probeLaunch(shim, ['--version'], 'win32', () => 'C:\\nvm\\node.cmd'), null, 'a runtime that is one more shim: refused');
  } finally {
    rmSync(npm, { recursive: true, force: true });
  }
  assert.match(binaryIdentityRefusal('the `codex` pin', 'C:\\x\\run.bat', CURSOR, 'unsupported'), /^`run\.bat` cannot be checked/);
});
