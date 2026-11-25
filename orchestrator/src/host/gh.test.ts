import '../test-home.js';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ghConfigFolder, ghCredentialsStamp, ghEnv, ghForgeHost, ghLogin, parseGhHosts, type GhRunner } from './gh.js';
import type { ExecOpts } from './types.js';

test('a named config folder wins: the tokens that would override it are removed', () => {
  const env = ghEnv('/home/u/.config/gh-work', { PATH: '/bin', GH_TOKEN: 't1', GITHUB_TOKEN: 't2', GH_ENTERPRISE_TOKEN: 't3' });
  assert.equal(env.GH_CONFIG_DIR, '/home/u/.config/gh-work');
  assert.equal(env.GH_TOKEN, undefined);
  assert.equal(env.GITHUB_TOKEN, undefined);
  assert.equal(env.GH_ENTERPRISE_TOKEN, undefined);
  assert.equal(env.GH_PROMPT_DISABLED, '1');
  assert.equal(env.PATH, '/bin');
});

test('without a folder, gh keeps its own default', () => {
  const env = ghEnv(null, { GH_CONFIG_DIR: '/elsewhere' });
  assert.equal(env.GH_CONFIG_DIR, '/elsewhere');
});

test('the forge host of a config folder: its hosts, never what is under them', () => {
  const yml = [
    'github.com:', '    oauth_token: gho_secret', '    user: a', '"ghe.example.com":', '    user: b', '# comment', 'bad host:', '',
  ].join('\n');
  assert.deepEqual(parseGhHosts(yml), ['github.com', 'ghe.example.com']);
  const read = (text: string) => () => text;
  assert.equal(ghForgeHost(null), 'github.com');
  assert.equal(ghForgeHost('/cfg', read(yml)), 'github.com', 'gh reaches github.com when it signs in there');
  assert.equal(ghForgeHost('/cfg', read('ghe.example.com:\n    user: b\n')), 'ghe.example.com');
  assert.equal(ghForgeHost('/cfg', read('a.example.com:\nb.example.com:\n')), null);
  assert.equal(ghForgeHost('/cfg', () => { throw new Error('ENOENT'); }), 'github.com');
});

function runner(answer: { code?: number; stdout?: string; stderr?: string; timedOut?: boolean } | 'missing') {
  const calls: Array<{ args: string[]; opts: ExecOpts }> = [];
  const run: GhRunner = async (args, opts) => {
    calls.push({ args, opts });
    if (answer === 'missing') throw new Error('binary not found: gh');
    return { code: answer.code ?? 0, stdout: answer.stdout ?? '', stderr: answer.stderr ?? '', timedOut: answer.timedOut };
  };
  return { run, calls };
}

test('reads the login gh answers for, in the folder it was given', async () => {
  const { run, calls } = runner({ stdout: 'ai-bot\n' });
  assert.deepEqual(await ghLogin('/home/u/.config/gh-work', run), { ok: true, login: 'ai-bot' });
  assert.deepEqual(calls[0].args, ['api', 'user', '--jq', '.login']);
  assert.equal(calls[0].opts.env?.GH_CONFIG_DIR, '/home/u/.config/gh-work');
});

test('a missing gh, a failure, a timeout or a strange answer are refusals', async () => {
  assert.equal((await ghLogin(null, runner('missing').run)).ok, false);
  const failed = await ghLogin(null, runner({ code: 1, stderr: 'HTTP 401: Bad credentials ghp_abcdefghijklmnopqrstuvwxyz0123' }).run);
  assert.equal(failed.ok, false);
  assert.ok(!failed.ok && failed.code === 'gh_failed' && !failed.reason.includes('ghp_') && failed.reason.includes('[redacted]'));
  const slow = await ghLogin(null, runner({ code: 1, timedOut: true }).run);
  assert.ok(!slow.ok && slow.code === 'timed_out');
  const odd = await ghLogin(null, runner({ stdout: '<html>' }).run);
  assert.ok(!odd.ok && odd.code === 'unexpected_answer');
});

test('the config folder gh reads: the named one, else its own default order', () => {
  assert.equal(ghConfigFolder('/x/gh', { GH_CONFIG_DIR: '/y' }), '/x/gh');
  assert.equal(ghConfigFolder(null, { GH_CONFIG_DIR: '/y', XDG_CONFIG_HOME: '/z' }), '/y');
  assert.equal(ghConfigFolder(null, { XDG_CONFIG_HOME: join('/z') }, 'linux'), join('/z', 'gh'));
  assert.equal(ghConfigFolder(null, { APPDATA: join('/app') }, 'win32'), join('/app', 'GitHub CLI'));
  assert.equal(ghConfigFolder(null, { APPDATA: join('/app') }, 'linux'), join(homedir(), '.config', 'gh'));
});

test('the credentials stamp follows hosts.yml: rewritten, replaced or gone', () => {
  const dir = mkdtempSync(join(tmpdir(), 'timon-gh-stamp-'));
  const file = join(dir, 'hosts.yml');
  try {
    assert.equal(ghCredentialsStamp(dir), null);
    writeFileSync(file, 'github.com:\n    user: alice\n');
    utimesSync(file, 1_000, 1_000);
    const first = ghCredentialsStamp(dir);
    assert.ok(first);
    assert.equal(ghCredentialsStamp(dir), first);
    // Same size, same inode, another time.
    writeFileSync(file, 'github.com:\n    user: carol\n');
    utimesSync(file, 2_000, 2_000);
    const second = ghCredentialsStamp(dir);
    assert.notEqual(second, first);
    // Another size at the same time.
    writeFileSync(file, 'github.com:\n    user: bob\n');
    utimesSync(file, 2_000, 2_000);
    assert.notEqual(ghCredentialsStamp(dir), second);
    // Only the stat is read: its content never.
    const stamp = ghCredentialsStamp(dir, () => ({ ino: 7n, size: 3n, mtimeNs: 9n }));
    assert.equal(stamp, '7:3:9');
    assert.equal(ghCredentialsStamp(dir, () => { throw new Error('EACCES'); }), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
