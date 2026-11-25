/**
 * The pure parts of the one-OS package build: arguments, version rules, paths,
 * keys, signing environment, plan, checksums and summary. No test runs npm or
 * electron-builder; `inspect` runs against a throwaway git repository.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_OUTPUT, KEY_FILE_ENV, KEY_PEM_ENV, PACKAGES, SUMS_FILE, SUMMARY_FILE,
  buildPlan, buildSummary, checkKeyLocation, checksumsText, compareRelease, describe, distTarget, foreignChanges, hashFile,
  inspect, materializeKeys, osName, outputPaths, parseArgs, releaseKind, resolveKeys, selectInstallers, setVersion,
  signingEnv, stepEnv, validateBuildSummary, versionKind, versionOf, writeOutputs,
} from './build-package.mjs';

const scratch = () => mkdtempSync(join(tmpdir(), 'build-package-'));
const SHA = 'a'.repeat(64);
const COMMIT = 'b'.repeat(40);
const info = { channel: 'beta', builtAt: '2026-11-16T10:00:00.000Z', expiresAt: '2027-02-14T10:00:00.000Z' };
const summaryOf = (extra = {}) => buildSummary({
  version: '0.2.0-rc.1', kind: 'rc', buildInfo: info, os: 'linux', arch: 'x64', commit: COMMIT, node: 'v22.12.0',
  signing: { mode: 'none' },
  files: [{ name: 'Timon-0.2.0-rc.1.AppImage', format: 'appimage', size: 10, sha256: SHA }, { name: 'timon-desktop_0.2.0-rc.1_amd64.deb', format: 'deb', size: 20, sha256: 'c'.repeat(64) }],
  ...extra,
});

test('parseArgs: version and channel are required, the rest is optional', () => {
  const opts = parseArgs(['--version', '0.2.0-rc.1', '--channel', 'beta', '--dry-run', '--output', 'out', '--expires', '2027-01-01']);
  assert.equal(opts.version, '0.2.0-rc.1');
  assert.equal(opts.channel, 'beta');
  assert.equal(opts.dryRun, true);
  assert.equal(opts.output, 'out');
  assert.equal(opts.expires, '2027-01-01');
  assert.equal(opts.allowLocal, false);
  assert.throws(() => parseArgs(['--channel', 'beta']), /--version is required/);
  assert.throws(() => parseArgs(['--version', '0.2.0']), /--channel is required/);
  assert.throws(() => parseArgs(['--version', '0.2.0', '--channel', 'dev']), /--channel must be one of beta, stable/);
  assert.throws(() => parseArgs(['--version', '0.2.0-beta.1', '--channel', 'beta']), /not a release version/);
  assert.throws(() => parseArgs(['--version', '0.2.0-rc.0', '--channel', 'beta']), /not a release version/);
  assert.throws(() => parseArgs(['--version', '--channel', 'beta']), /--version needs a value/);
  assert.throws(() => parseArgs(['0.2.0', '--channel', 'beta']), /unexpected argument 0\.2\.0/);
  assert.throws(() => parseArgs(['--version', '0.2.0', '--channel', 'beta', '--no-publish']), /unexpected argument --no-publish/);
});

test('compareRelease orders an rc before its final version', () => {
  assert.equal(compareRelease('0.1.9-rc.1', '0.1.8'), 1);
  assert.equal(compareRelease('0.1.9-rc.1', '0.1.9'), -1);
  assert.equal(compareRelease('0.1.9-rc.2', '0.1.9-rc.10'), -1);
  assert.equal(compareRelease('1.0.0', '1.0.0'), 0);
  assert.equal(compareRelease('0.10.0', '0.9.9'), 1);
});

test('releaseKind: an rc above the checkout, a final version equal to it', () => {
  assert.equal(releaseKind('0.1.9-rc.1', '0.1.8'), 'rc');
  assert.equal(releaseKind('0.1.8', '0.1.8'), 'final');
  assert.throws(() => releaseKind('0.1.8-rc.3', '0.1.8'), /not above the checkout's version 0\.1\.8/);
  assert.throws(() => releaseKind('0.0.0-rc.1', '0.1.8'), /not above/);
  assert.throws(() => releaseKind('0.1.9', '0.1.8'), /merge the version bump first/);
});

test('a nightly build: dated, above the checkout like an rc, and before any rc of its version', () => {
  assert.equal(parseArgs(['--version', '0.1.12-nightly.20261126', '--channel', 'beta']).version, '0.1.12-nightly.20261126');
  for (const bad of ['0.1.12-nightly.2026112', '0.1.12-nightly.020261126', '0.1.12-nightly.1', '0.1.12-nightly', '0.1.12-nightly.20261126.1', '0.1.12-rc.1-nightly.20261126']) {
    assert.throws(() => parseArgs(['--version', bad, '--channel', 'beta']), /not a release version/, bad);
  }
  assert.equal(versionKind('0.1.12-nightly.20261126'), 'nightly');
  assert.equal(versionKind('0.1.12-rc.2'), 'rc');
  assert.equal(versionKind('0.1.12'), 'final');
  assert.equal(releaseKind('0.1.12-nightly.20261126', '0.1.11'), 'nightly');
  assert.throws(() => releaseKind('0.1.11-nightly.20261126', '0.1.11'), /not above the checkout's version 0\.1\.11/);
  // SemVer: "nightly" sorts before "rc", so a tester on a nightly still takes the rc and the release.
  assert.equal(compareRelease('0.1.12-nightly.20261126', '0.1.12-rc.1'), -1);
  assert.equal(compareRelease('0.1.12-nightly.20261126', '0.1.12'), -1);
  assert.equal(compareRelease('0.1.12-nightly.20261127', '0.1.12-nightly.20261126'), 1);
  assert.equal(compareRelease('0.1.12-nightly.20261126', '0.1.12-nightly.20261126'), 0);
  const nightly = summaryOf({ version: '0.1.12-nightly.20261126', kind: 'nightly' });
  assert.equal(validateBuildSummary(nightly), nightly);
  assert.throws(() => validateBuildSummary({ ...nightly, kind: 'rc' }), /kind does not match/);
});

test('setVersion rewrites the first version field only', () => {
  const source = '{\n  "name": "timon-desktop",\n  "version": "0.1.8",\n  "dependencies": { "x": { "version": "1.0.0" } }\n}\n';
  const out = setVersion(source, '0.1.9-rc.1');
  assert.equal(versionOf(out), '0.1.9-rc.1');
  assert.equal(out, source.replace('"version": "0.1.8"', '"version": "0.1.9-rc.1"'));
  assert.throws(() => setVersion('{}', '1.0.0'), /no "version" field/);
  assert.throws(() => versionOf('{}'), /no "version" field/);
});

test('foreignChanges lets through the three package.json only', () => {
  const porcelain = ' M orchestrator/package.json\n M app/package.json\n M desktop/package.json\n M app/src/x.ts\n?? notes.txt\n';
  assert.deepEqual(foreignChanges(porcelain), [' M app/src/x.ts', '?? notes.txt']);
  assert.deepEqual(foreignChanges(''), []);
});

test('osName and distTarget refuse an unknown platform', () => {
  assert.deepEqual(['linux', 'darwin', 'win32'].map(osName), ['linux', 'mac', 'windows']);
  assert.deepEqual(['linux', 'darwin', 'win32'].map(distTarget), ['--linux', '--mac', '--win']);
  assert.throws(() => osName('freebsd'), /no desktop package for platform freebsd/);
  assert.throws(() => distTarget('aix'), /no desktop package/);
});

test('outputPaths: dist-release/<version>/<os> under the checkout by default', () => {
  const checkout = join(tmpdir(), 'checkout');
  const paths = outputPaths({ checkout, output: null, version: '0.2.0', os: 'mac' });
  assert.equal(paths.base, join(checkout, DEFAULT_OUTPUT));
  assert.equal(paths.dir, join(checkout, DEFAULT_OUTPUT, '0.2.0', 'mac'));
  assert.equal(paths.work, join(checkout, DEFAULT_OUTPUT, '0.2.0', '.work-mac'));
  const custom = outputPaths({ checkout, output: 'out', version: '0.2.0', os: 'windows', cwd: join(tmpdir(), 'here') });
  assert.equal(custom.dir, join(tmpdir(), 'here', 'out', '0.2.0', 'windows'));
});

test('resolveKeys: --key-dir, then file variables, then PEM variables, never a default', () => {
  const dir = join(tmpdir(), 'keys');
  assert.deepEqual(resolveKeys({ keyDir: dir, env: { [KEY_FILE_ENV.privateKey]: 'x' } }).privateKey, join(dir, 'dev-release.key.pem'));
  const files = resolveKeys({ env: { [KEY_FILE_ENV.privateKey]: join(dir, 'a.pem'), [KEY_FILE_ENV.publicKey]: join(dir, 'b.pem'), [KEY_PEM_ENV.privateKey]: 'p' } });
  assert.equal(files.source, 'key file variables');
  assert.equal(files.publicKey, join(dir, 'b.pem'));
  const pem = resolveKeys({ env: { [KEY_PEM_ENV.privateKey]: 'PRIV', [KEY_PEM_ENV.publicKey]: 'PUB' } });
  assert.deepEqual(pem.pem, { privateKey: 'PRIV', publicKey: 'PUB' });
  assert.equal(resolveKeys({ env: {} }), null);
  assert.throws(() => resolveKeys({ env: { [KEY_FILE_ENV.privateKey]: 'a' } }), /go together/);
  assert.throws(() => resolveKeys({ env: { [KEY_PEM_ENV.publicKey]: 'b' } }), /go together/);
});

test('checkKeyLocation refuses a key inside the checkout', () => {
  const checkout = join(tmpdir(), 'co');
  assert.throws(() => checkKeyLocation({ privateKey: join(checkout, 'k.pem'), publicKey: join(tmpdir(), 'p.pem') }, [checkout]), /lies inside/);
  checkKeyLocation({ privateKey: join(tmpdir(), 'k.pem'), publicKey: join(tmpdir(), 'p.pem') }, [checkout]);
});

test('materializeKeys writes owner-only files and removes them', () => {
  const base = scratch();
  const keys = materializeKeys({ privateKey: 'PRIVATE', publicKey: 'PUBLIC\n' }, base);
  assert.equal(readFileSync(keys.privateKey, 'utf8'), 'PRIVATE\n');
  assert.equal(readFileSync(keys.publicKey, 'utf8'), 'PUBLIC\n');
  if (process.platform !== 'win32') assert.equal(statSync(keys.privateKey).mode & 0o777, 0o600);
  keys.dispose();
  assert.equal(existsSync(keys.privateKey), false);
});

test('signingEnv turns discovery off unless an identity is given', () => {
  assert.deepEqual(signingEnv({}, 'darwin'), { mode: 'none', from: [], env: { CSC_IDENTITY_AUTO_DISCOVERY: 'false' } });
  assert.deepEqual(signingEnv({}, 'win32').env, { CSC_IDENTITY_AUTO_DISCOVERY: 'false' });
  // Linux packages carry no OS signature: a CSC_LINK there changes nothing.
  assert.equal(signingEnv({ CSC_LINK: 'x' }, 'linux').mode, 'none');
  const mac = signingEnv({ CSC_LINK: 'secret-value', CSC_KEY_PASSWORD: 'p' }, 'darwin');
  assert.deepEqual(mac, { mode: 'identity', from: ['CSC_LINK'], env: {} });
  assert.equal(JSON.stringify(mac).includes('secret-value'), false);
  assert.deepEqual(signingEnv({ WIN_CSC_LINK: 'x' }, 'win32').from, ['WIN_CSC_LINK']);
});

test('buildPlan: installs, builds, then packages into the work folder', () => {
  const checkout = join(tmpdir(), 'co');
  const work = join(tmpdir(), 'out', '.work-windows');
  const keys = { privateKey: join(tmpdir(), 'k', 'priv.pem'), publicKey: join(tmpdir(), 'k', 'pub.pem') };
  const plan = buildPlan({ checkout, platform: 'win32', keys, work, signing: signingEnv({}, 'win32') });
  assert.deepEqual(plan.map((step) => step.label), [
    'orchestrator: npm ci --include=dev', 'app: npm ci --include=dev', 'desktop: npm ci --include=dev',
    'app: npm run build', 'desktop: npm run build', 'desktop: npm run prepare:deps', 'desktop: npm run dist -- --win --publish never',
  ]);
  assert.deepEqual(plan.slice(0, 3).map((step) => step.cwd), PACKAGES.map((pkg) => join(checkout, pkg)));
  assert.deepEqual(plan[3].env, { NODE_ENV: 'production', TIMON_NEXT_STANDALONE: '1' });
  const dist = plan.at(-1);
  assert.deepEqual(dist.args, ['run', 'dist', '--', '--win', '--publish', 'never', `--config.directories.output=${work}`]);
  // electron-builder publishes on its own in CI when a token is present.
  assert.equal(dist.args[dist.args.indexOf('--publish') + 1], 'never');
  assert.equal(dist.env.NODE_ENV, 'development');
  assert.equal(dist.env.CSC_IDENTITY_AUTO_DISCOVERY, 'false');
  assert.equal(dist.env[KEY_FILE_ENV.privateKey], keys.privateKey);
  assert.equal(dist.env[KEY_FILE_ENV.publicKey], keys.publicKey);
  for (const step of plan.slice(0, -1)) assert.equal(step.env[KEY_FILE_ENV.privateKey], undefined);
});

test('stepEnv keeps the release key variables from every step but the signing one', () => {
  const plan = buildPlan({ checkout: join(tmpdir(), 'co'), platform: 'linux', keys: { privateKey: '/k/priv.pem', publicKey: '/k/pub.pem' }, work: join(tmpdir(), 'w'), signing: signingEnv({}, 'linux') });
  const caller = {
    PATH: '/usr/bin', NODE_ENV: 'production',
    [KEY_PEM_ENV.privateKey]: 'PRIVATE PEM', [KEY_PEM_ENV.publicKey]: 'PUBLIC PEM',
    [KEY_FILE_ENV.privateKey]: '/elsewhere/priv.pem', [KEY_FILE_ENV.publicKey]: '/elsewhere/pub.pem',
  };
  for (const step of plan.slice(0, -1)) {
    const env = stepEnv(caller, step);
    for (const name of [...Object.values(KEY_PEM_ENV), ...Object.values(KEY_FILE_ENV)]) assert.equal(env[name], undefined, `${step.label} sees ${name}`);
    assert.equal(env.PATH, '/usr/bin');
    assert.equal(env.NODE_ENV, step.env.NODE_ENV);
  }
  const dist = stepEnv(caller, plan.at(-1));
  assert.equal(dist[KEY_PEM_ENV.privateKey], undefined, 'the PEM text never reaches electron-builder');
  assert.equal(dist[KEY_FILE_ENV.privateKey], '/k/priv.pem');
  assert.equal(dist[KEY_FILE_ENV.publicKey], '/k/pub.pem');
  assert.equal(caller[KEY_PEM_ENV.privateKey], 'PRIVATE PEM', 'the caller keeps its own environment');
});

test('selectInstallers keeps the installers of the OS, sorted, with their format', () => {
  const names = ['latest-linux.yml', 'Timon-1.0.0.AppImage', 'linux-unpacked', 'builder-debug.yml', 'timon-desktop_1.0.0_amd64.deb'];
  assert.deepEqual(selectInstallers(names, 'linux'), [
    { name: 'Timon-1.0.0.AppImage', format: 'appimage' },
    { name: 'timon-desktop_1.0.0_amd64.deb', format: 'deb' },
  ]);
  assert.deepEqual(selectInstallers(['Timon Setup 1.0.0.exe', 'Timon Setup 1.0.0.exe.blockmap', 'latest.yml'], 'windows'), [{ name: 'Timon Setup 1.0.0.exe', format: 'nsis' }]);
  assert.deepEqual(selectInstallers(['Timon-1.0.0-arm64.dmg', 'Timon-1.0.0-arm64.pkg', 'Timon-1.0.0-arm64.dmg.blockmap', 'mac-arm64'], 'mac').map((f) => f.format), ['dmg', 'pkg']);
  assert.throws(() => selectInstallers([], 'beos'), /unknown OS/);
});

test('hashFile and checksumsText produce sha256sum-compatible lines', async () => {
  const dir = scratch();
  const file = join(dir, 'abc.bin');
  writeFileSync(file, 'abc');
  const described = await hashFile(file);
  assert.deepEqual(described, { name: 'abc.bin', size: 3, sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad' });
  assert.equal(checksumsText([{ name: 'z.deb', sha256: SHA }, described]), `${described.sha256}  abc.bin\n${SHA}  z.deb\n`);
  await assert.rejects(hashFile(dir), /not a regular file/);
});

test('buildSummary carries what the publication needs, and validates', () => {
  const summary = summaryOf();
  assert.deepEqual(Object.keys(summary), ['schema', 'version', 'kind', 'channel', 'builtAt', 'expiresAt', 'os', 'arch', 'commit', 'node', 'signing', 'checksums', 'files']);
  assert.equal(summary.checksums, SUMS_FILE);
  assert.equal(validateBuildSummary(summary), summary);
  assert.equal(validateBuildSummary(JSON.parse(JSON.stringify(summary))).version, '0.2.0-rc.1');
});

test('validateBuildSummary refuses an inconsistent summary', () => {
  const bad = (patch) => ({ ...summaryOf(), ...patch });
  assert.throws(() => validateBuildSummary(bad({ kind: 'final' })), /kind does not match/);
  assert.throws(() => validateBuildSummary(bad({ commit: 'abc1234' })), /full sha/);
  assert.throws(() => validateBuildSummary(bad({ os: 'beos' })), /invalid os/);
  assert.throws(() => validateBuildSummary(bad({ channel: 'dev' })), /invalid channel/);
  assert.throws(() => validateBuildSummary(bad({ files: [] })), /no installer/);
  assert.throws(() => validateBuildSummary(bad({ files: [{ name: 'Timon.dmg', format: 'dmg', size: 1, sha256: SHA }] })), /not one of linux/);
  assert.throws(() => validateBuildSummary(bad({ files: [{ name: '../x.deb', format: 'deb', size: 1, sha256: SHA }] })), /invalid file name/);
  assert.throws(() => validateBuildSummary(bad({ files: [{ name: 'x.deb', format: 'deb', size: 0, sha256: SHA }] })), /invalid size/);
  assert.throws(() => validateBuildSummary(bad({ schema: 2 })), /unknown schema/);
});

test('writeOutputs writes SHA256SUMS and build-summary.json side by side', () => {
  const dir = scratch();
  const summary = summaryOf();
  const written = writeOutputs(dir, summary);
  assert.equal(written.sums, join(dir, SUMS_FILE));
  assert.equal(readFileSync(written.sums, 'utf8'), checksumsText(summary.files));
  assert.deepEqual(JSON.parse(readFileSync(join(dir, SUMMARY_FILE), 'utf8')), summary);
});

/** A throwaway repository with the three package.json at `version`, committed. */
function fakeCheckout(version) {
  const dir = scratch();
  const git = (...args) => {
    const run = spawnSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd: dir, encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
  };
  git('init', '-q');
  for (const pkg of PACKAGES) {
    mkdirSync(join(dir, pkg));
    writeFileSync(join(dir, pkg, 'package.json'), `{\n  "name": "${pkg}",\n  "version": "${version}"\n}\n`);
  }
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  return dir;
}

test('inspect: a clean checkout on CI with keys has no blocker', () => {
  const checkout = fakeCheckout('0.1.8');
  const keys = scratch();
  writeFileSync(join(keys, 'dev-release.key.pem'), 'k');
  writeFileSync(join(keys, 'dev-release.pub.pem'), 'p');
  const opts = parseArgs(['--version', '0.1.9-rc.1', '--channel', 'beta', '--checkout', checkout, '--key-dir', keys]);
  const state = inspect(opts, { env: { CI: 'true' }, platform: 'linux', arch: 'x64' });
  assert.deepEqual(state.blockers, []);
  assert.equal(state.kind, 'rc');
  assert.equal(state.current, '0.1.8');
  assert.match(state.commit, /^[a-f0-9]{40}$/);
  assert.equal(state.paths.dir, join(checkout, DEFAULT_OUTPUT, '0.1.9-rc.1', 'linux'));
  const lines = describe(state, opts);
  assert.match(lines[0], /^rc 0\.1\.9-rc\.1 for linux \(linux-x64\)/);
  assert.ok(lines.some((line) => line.includes('desktop: npm run dist -- --linux --publish never')));
  assert.ok(lines.every((line) => !line.includes(keys)), 'the plan never prints where the keys are');
});

test('inspect lists every reason a real run would stop', () => {
  const checkout = fakeCheckout('0.1.8');
  writeFileSync(join(checkout, 'app', 'stray.txt'), 'x');
  const opts = parseArgs(['--version', '0.0.0-rc.1', '--channel', 'beta', '--checkout', checkout]);
  const { blockers, kind } = inspect(opts, { env: {}, platform: 'darwin', arch: 'arm64' });
  assert.equal(kind, null);
  assert.equal(blockers.length, 4);
  assert.match(blockers[0], /not above/);
  assert.match(blockers[1], /not clean/);
  assert.match(blockers[2], /--allow-local/);
  assert.match(blockers[3], /no release signing keys/);
  // A beta must expire: refused before anything else is looked at.
  assert.throws(() => inspect(parseArgs(['--version', '0.1.9-rc.1', '--channel', 'beta', '--no-expiry', '--checkout', checkout]), { env: {}, platform: 'linux' }), /refused for channel beta/);
});

test('inspect refuses to overwrite installers already built', () => {
  const checkout = fakeCheckout('0.1.8');
  const out = scratch();
  mkdirSync(join(out, '0.1.8', 'windows'), { recursive: true });
  writeFileSync(join(out, '0.1.8', 'windows', 'Timon Setup 0.1.8.exe'), 'x');
  const opts = parseArgs(['--version', '0.1.8', '--channel', 'stable', '--no-expiry', '--checkout', checkout, '--output', out, '--allow-local']);
  const { blockers, kind } = inspect(opts, { env: { [KEY_PEM_ENV.privateKey]: 'a', [KEY_PEM_ENV.publicKey]: 'b' }, platform: 'win32' });
  assert.equal(kind, 'final');
  assert.deepEqual(blockers.length, 1);
  assert.match(blockers[0], /is not empty/);
});
