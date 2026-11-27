import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  GLIBC_FLOOR, LINUX_PACKAGE_NATIVES, NATIVE_BUILD_IMAGES, assertGlibcFloor, compareGlibc,
  containerBuildEnv, containerCommand, elfFilesUnder, elfVersionNeeds, glibcOffenders, nativeBuildImage, newestGlibc,
  requiredGlibc,
} from './native-linux.mjs';
import { NATIVE_BUILD_ARTEFACTS } from './native-build.mjs';

/**
 * A minimal 64-bit little-endian ELF holding only what `objdump -T` reads the
 * required versions from: a string table and a `.gnu.version_r` section that
 * points at it, one library needing `names`.
 */
function elfNeeding(names) {
  const strings = Buffer.from(`\0libc.so.6\0${names.join('\0')}\0`, 'latin1');
  const offsetOf = (name) => strings.indexOf(Buffer.from(`\0${name}\0`, 'latin1')) + 1;
  const verneed = Buffer.alloc(16 + 16 * names.length);
  verneed.writeUInt16LE(1, 0); // vn_version
  verneed.writeUInt16LE(names.length, 2); // vn_cnt
  verneed.writeUInt32LE(offsetOf('libc.so.6'), 4); // vn_file
  verneed.writeUInt32LE(16, 8); // vn_aux
  verneed.writeUInt32LE(0, 12); // vn_next
  names.forEach((name, i) => {
    const at = 16 + 16 * i;
    verneed.writeUInt32LE(offsetOf(name), at + 8); // vna_name
    verneed.writeUInt32LE(i === names.length - 1 ? 0 : 16, at + 12); // vna_next
  });
  const header = Buffer.alloc(64);
  header.writeUInt32BE(0x7f454c46, 0);
  header[4] = 2; // 64-bit
  header[5] = 1; // little-endian
  const stringsAt = 64;
  const verneedAt = stringsAt + strings.length;
  const sectionsAt = verneedAt + verneed.length;
  header.writeBigUInt64LE(BigInt(sectionsAt), 0x28);
  header.writeUInt16LE(64, 0x3a);
  header.writeUInt16LE(3, 0x3c);
  const section = (type, offset, size, link, info) => {
    const entry = Buffer.alloc(64);
    entry.writeUInt32LE(type, 4);
    entry.writeBigUInt64LE(BigInt(offset), 0x18);
    entry.writeBigUInt64LE(BigInt(size), 0x20);
    entry.writeUInt32LE(link, 0x28);
    entry.writeUInt32LE(info, 0x2c);
    return entry;
  };
  return Buffer.concat([
    header, strings, verneed,
    section(0, 0, 0, 0, 0),
    section(3, stringsAt, strings.length, 0, 0),
    section(0x6ffffffe, verneedAt, verneed.length, 1, 1),
  ]);
}

test('TIM-0162: the glibc versions an ELF requires are read as objdump -T prints them', () => {
  const names = ['GLIBC_2.2.5', 'GLIBC_2.34', 'GLIBC_2.9', 'GLIBC_PRIVATE'];
  assert.deepEqual(elfVersionNeeds(elfNeeding(names)), names);
  assert.equal(newestGlibc(names), '2.34', '2.34 is newer than 2.9; GLIBC_PRIVATE is no version');
  assert.equal(elfVersionNeeds(Buffer.from('MZ not an ELF at all, a Windows prebuild')), null);
  assert.equal(newestGlibc(null), null);
});

test('glibc versions compare numerically', () => {
  assert.equal(compareGlibc('2.9', '2.28'), -1);
  assert.equal(compareGlibc('2.28', '2.28'), 0);
  assert.equal(compareGlibc('2.29', '2.28'), 1);
  assert.equal(compareGlibc('2.2.5', '2.2'), 1);
});

test('TIM-0162: a shipped binary above the glibc floor stops the build, and says which', () => {
  const dir = mkdtempSync(join(tmpdir(), 'glibc-floor-'));
  const ok = join(dir, 'ok.node');
  const pty = join(dir, 'pty.node');
  const sqlite = join(dir, 'better_sqlite3.node');
  writeFileSync(ok, elfNeeding(['GLIBC_2.2.5', 'GLIBC_2.28']));
  writeFileSync(pty, elfNeeding(['GLIBC_2.2.5', 'GLIBC_2.42']));
  writeFileSync(sqlite, elfNeeding(['GLIBC_2.29']));
  assert.equal(GLIBC_FLOOR, '2.28', 'the floor public-docs promises');
  assert.equal(requiredGlibc(pty), '2.42');
  assert.deepEqual(glibcOffenders([ok, pty, sqlite]).map(({ file, version }) => [file, version]), [[pty, '2.42'], [sqlite, '2.29']]);
  assert.throws(() => assertGlibcFloor([ok, pty, sqlite]), (error) => {
    assert.match(error.message, /newer than 2\.28/);
    assert.match(error.message, /pty\.node: GLIBC_2\.42/);
    assert.match(error.message, /better_sqlite3\.node: GLIBC_2\.29/);
    return true;
  });
  assert.equal(assertGlibcFloor([ok]), 1);
});

test('every ELF under a folder is found, and nothing else', () => {
  const dir = mkdtempSync(join(tmpdir(), 'elf-walk-'));
  mkdirSync(join(dir, 'build', 'Release'), { recursive: true });
  writeFileSync(join(dir, 'build', 'Release', 'pty.node'), elfNeeding(['GLIBC_2.17']));
  writeFileSync(join(dir, 'index.js'), 'module.exports = 1;');
  writeFileSync(join(dir, 'tiny'), 'EL');
  assert.deepEqual(elfFilesUnder(dir), [join(dir, 'build', 'Release', 'pty.node')]);
  assert.deepEqual(elfFilesUnder(join(dir, 'absent')), []);
});

test('the Node binary running this test is read like any shipped binary', { skip: process.platform !== 'linux' }, () => {
  const version = requiredGlibc(process.execPath);
  // A static or musl Node requires none; a glibc one names a version.
  assert.ok(version === null || /^2\.\d+$/.test(version), String(version));
});

test('TIM-0162: the natives are rebuilt in an image pinned by digest, overridable', () => {
  assert.match(NATIVE_BUILD_IMAGES.x64, /^quay\.io\/pypa\/manylinux_2_28_x86_64@sha256:[0-9a-f]{64}$/);
  assert.equal(nativeBuildImage({}, 'x64'), NATIVE_BUILD_IMAGES.x64);
  assert.equal(nativeBuildImage({ TIMON_NATIVE_BUILD_IMAGE: ' mirror/manylinux:2_28 ' }, 'x64'), 'mirror/manylinux:2_28');
  assert.throws(() => nativeBuildImage({}, 'arm64'), /TIMON_NATIVE_BUILD_IMAGE/);
});

test('the container runs as the caller, mounts at the same paths, and keeps the image PATH', () => {
  const [command, argv] = containerCommand({
    image: 'img', uid: 1001, gid: 121, workdir: '/tmp/stage/orchestrator', writable: '/tmp/stage',
    readonly: ['/build/node', '/npm'], env: { HOME: '/tmp/stage/home' }, nodeDir: '/build/node', args: ['/build/node/node', '-v'],
  });
  assert.equal(command, 'docker');
  assert.deepEqual(argv.slice(0, 5), ['run', '--rm', '--user', '1001:121', '-w']);
  assert.ok(argv.includes('/tmp/stage:/tmp/stage'));
  assert.ok(argv.includes('/build/node:/build/node:ro'));
  assert.ok(argv.includes('/npm:/npm:ro'));
  assert.ok(argv.includes('HOME=/tmp/stage/home'));
  assert.ok(!argv.some((arg, i) => argv[i - 1] === '-e' && arg.startsWith('PATH=')), 'a PATH set with -e would hide the image compiler toolset');
  const at = argv.indexOf('img');
  assert.deepEqual(argv.slice(at + 1, at + 3), ['sh', '-c']);
  assert.deepEqual(argv.slice(-2), ['/build/node/node', '-v']);
});

test('TIM-0162: both modules are built from source in the image, never from a prebuild', () => {
  const env = containerBuildEnv('/tmp/stage/home');
  assert.equal(env.npm_config_build_from_source, 'true', 'better-sqlite3 prebuild needs glibc 2.29');
  assert.equal(env.HOME, '/tmp/stage/home');
  assert.ok(env.npm_config_cache.startsWith('/tmp/stage/home'));
  assert.ok(env.npm_config_devdir.startsWith('/tmp/stage/home'));
});

test('TIM-0162: the Linux package requires the terminal addon beside both database drivers', () => {
  const pty = LINUX_PACKAGE_NATIVES.find((path) => path.includes('node-pty'));
  assert.equal(pty, join('orchestrator', 'node_modules', 'node-pty', 'build', 'Release', 'pty.node'));
  for (const [moduleName, files] of Object.entries(NATIVE_BUILD_ARTEFACTS)) {
    for (const file of files) {
      assert.ok(LINUX_PACKAGE_NATIVES.some((path) => path.includes(moduleName) && path.endsWith(file)), `${moduleName}/${file}`);
    }
  }
});
