import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdtempSync, readFileSync, readlinkSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArchiveError, extractTarGz, extractZip, installRaw } from './archive.js';
import { buildTarGzWithModes, buildZip } from './archive-fixtures.js';

const posix = process.platform !== 'win32';
const scratch = () => mkdtempSync(join(tmpdir(), 'timon-archive-'));
function archiveFile(bytes: Buffer, name: string): string {
  const file = join(scratch(), name);
  writeFileSync(file, bytes);
  return file;
}
const rejects = async (run: () => Promise<void>, code: string) => assert.rejects(run, (err: unknown) => err instanceof ArchiveError && err.code === code, code);

test('tar.gz: layout is kept (nothing stripped) and only the executable bit survives', async () => {
  const dest = join(scratch(), 'out');
  const file = archiveFile(buildTarGzWithModes([
    { path: 'dist-package/', type: '5', mode: 0o755 },
    { path: 'dist-package/cursor-agent', data: '#!/bin/sh\n', mode: 0o755 },
    { path: 'dist-package/node', data: 'ELF', mode: 0o755 },
    { path: 'dist-package/index.js', data: 'x', mode: 0o666 },
  ]), 'a.tar.gz');
  await extractTarGz(file, dest);
  assert.equal(readFileSync(join(dest, 'dist-package', 'cursor-agent'), 'utf8'), '#!/bin/sh\n');
  if (posix) {
    assert.equal(statSync(join(dest, 'dist-package', 'cursor-agent')).mode & 0o777, 0o755);
    assert.equal(statSync(join(dest, 'dist-package', 'index.js')).mode & 0o777, 0o644, 'a world-writable file does not stay so');
  }
});

test('tar.gz: traversal, absolute paths, links and devices are refused, and nothing escapes', async () => {
  const base = scratch();
  const cases: Array<[string, Parameters<typeof buildTarGzWithModes>[0], string]> = [
    ['dotdot', [{ path: '../evil', data: 'x' }], 'unsafe-path'],
    ['nested dotdot', [{ path: 'a/../../evil', data: 'x' }], 'unsafe-path'],
    ['absolute', [{ path: '/etc/evil', data: 'x' }], 'unsafe-path'],
    ['backslash', [{ path: '..\\evil', data: 'x' }], 'unsafe-path'],
    ['drive', [{ path: 'C:evil', data: 'x' }], 'unsafe-path'],
    ['symlink', [{ path: 'link', type: '2', link: '/etc/passwd' }], 'link'],
    ['hardlink', [{ path: 'link', type: '1', link: 'ok' }], 'link'],
    ['device', [{ path: 'dev', type: '3' }], 'link'],
  ];
  for (const [label, files, code] of cases) {
    const dest = join(base, label.replaceAll(' ', '-'));
    await rejects(() => extractTarGz(archiveFile(buildTarGzWithModes(files), 'x.tar.gz'), dest), code);
  }
  assert.equal(existsSync(join(base, 'evil')), false);
});

/** The four links of the macOS build of Mistral Vibe (a PyInstaller bundle), as published. */
const FRAMEWORK: Parameters<typeof buildTarGzWithModes>[0] = [
  { path: 'vibe-acp', data: 'launcher', mode: 0o755 },
  { path: '_internal/Python.framework/Versions/3.12/Python', data: 'libpython', mode: 0o755 },
  { path: '_internal/Python.framework/Versions/3.12/Resources/Info.plist', data: 'plist' },
  { path: '_internal/Python', type: '2', link: 'Python.framework/Versions/3.12/Python' },
  { path: '_internal/Python.framework/Python', type: '2', link: 'Versions/Current/Python' },
  { path: '_internal/Python.framework/Resources', type: '2', link: 'Versions/Current/Resources' },
  { path: '_internal/Python.framework/Versions/Current', type: '2', link: '3.12' },
];

test('tar.gz: relative links that stay inside the bundle are kept (macOS framework layout)', { skip: !posix }, async () => {
  const dest = join(scratch(), 'out');
  await extractTarGz(archiveFile(buildTarGzWithModes(FRAMEWORK), 'v.tar.gz'), dest);
  const fw = join(dest, '_internal', 'Python.framework');
  assert.ok(lstatSync(join(fw, 'Versions', 'Current')).isSymbolicLink());
  assert.equal(readlinkSync(join(fw, 'Versions', 'Current')), '3.12');
  assert.equal(readFileSync(join(dest, '_internal', 'Python'), 'utf8'), 'libpython', 'a link through another link resolves');
  assert.equal(readFileSync(join(fw, 'Resources', 'Info.plist'), 'utf8'), 'plist');
  // `../` first, then names: the shape a sibling folder takes.
  const up = join(scratch(), 'up');
  await extractTarGz(archiveFile(buildTarGzWithModes([
    { path: 'lib/real.so', data: 'so' },
    { path: 'bin/lib.so', type: '2', link: '../lib/real.so' },
  ]), 'u.tar.gz'), up);
  assert.equal(readFileSync(join(up, 'bin', 'lib.so'), 'utf8'), 'so');
});

test('tar.gz: a long link target in a PAX record is read', { skip: !posix }, async () => {
  const target = `${'d'.repeat(60)}/${'e'.repeat(60)}/file`;
  const record = (body: string) => { let n = body.length + 3; while (`${n} ${body}\n`.length !== n) n += 1; return `${n} ${body}\n`; };
  const dest = join(scratch(), 'out');
  await extractTarGz(archiveFile(buildTarGzWithModes([
    { path: target, data: 'deep' },
    { path: 'PaxHeader', type: 'x', data: record(`linkpath=${target}`) },
    { path: 'short', type: '2', link: 'ignored-by-pax' },
  ]), 'p.tar.gz'), dest);
  assert.equal(readlinkSync(join(dest, 'short')), target);
});

test('tar.gz: links that could leave the folder, or be written through, are refused', async () => {
  const base = scratch();
  const cases: Array<[string, Parameters<typeof buildTarGzWithModes>[0], string]> = [
    // An absolute target, on either system.
    ['absolute', [{ path: 'l', type: '2', link: '/etc/passwd' }], 'link'],
    ['drive', [{ path: 'l', type: '2', link: 'C:/Windows' }], 'link'],
    // Out by `..`, from the root and from a sub-folder.
    ['dotdot', [{ path: 'l', type: '2', link: '../outside' }], 'link'],
    ['nested dotdot', [{ path: 'a/b/l', type: '2', link: '../../../outside' }], 'link'],
    // The root itself, and tricks in the target string.
    ['root itself', [{ path: 'a/l', type: '2', link: '..' }], 'link'],
    ['dot', [{ path: 'l', type: '2', link: '.' }], 'link'],
    ['backslash', [{ path: 'l', type: '2', link: '..\\outside' }], 'link'],
    ['empty', [{ path: 'l', type: '2', link: '' }], 'link'],
    // A chain: `l1` points to `c` (shallower than its own name), so `l1/../../../evil` resolves inside on paper and
    // outside for the system.
    ['chain escape', [
      { path: 'c/', type: '5' },
      { path: 'a/b/l1', type: '2', link: '../../c' },
      { path: 'a/b/l2', type: '2', link: 'l1/../../../evil' },
    ], 'link'],
    ['climb after a name', [{ path: 'sub/', type: '5' }, { path: 'l', type: '2', link: 'sub/../sub' }], 'link'],
    // Written through a link: a file below it, before or after it in the archive, and a link below a link.
    ['file through link', [{ path: 'sub/', type: '5' }, { path: 'd', type: '2', link: 'sub' }, { path: 'd/evil', data: 'x' }], 'unsafe-path'],
    ['file then link', [{ path: 'sub/', type: '5' }, { path: 'd/evil', data: 'x' }, { path: 'd', type: '2', link: 'sub' }], 'unsafe-path'],
    ['link through link', [{ path: 'sub/', type: '5' }, { path: 'd', type: '2', link: 'sub' }, { path: 'd/l', type: '2', link: '../x' }], 'link'],
    ['same name twice', [{ path: 'f', data: 'x' }, { path: 'f', type: '2', link: 'g' }], 'unsafe-path'],
  ];
  for (const [label, files, code] of cases) {
    const dest = join(base, label.replaceAll(' ', '-'));
    await assert.rejects(
      () => extractTarGz(archiveFile(buildTarGzWithModes(files), 'x.tar.gz'), dest, undefined, 'symlink'),
      (err: unknown) => err instanceof ArchiveError && err.code === code,
      `${label}: ${code}`,
    );
  }
  assert.equal(existsSync(join(base, 'evil')), false);
  assert.equal(existsSync(join(base, 'outside')), false);
  if (posix) {
    // The file written "through" `d` landed in a real folder, never in `sub`.
    assert.equal(existsSync(join(base, 'file-through-link', 'sub', 'evil')), false);
    assert.equal(existsSync(join(base, 'link-through-link', 'sub', 'l')), false);
  }
});

test('tar.gz: a loop of links is refused', { skip: !posix }, async () => {
  const loop = buildTarGzWithModes([{ path: 'a', type: '2', link: 'b' }, { path: 'b', type: '2', link: 'a' }]);
  await rejects(() => extractTarGz(archiveFile(loop, 'l.tar.gz'), join(scratch(), 'o'), undefined, 'symlink'), 'link');
});

test('tar.gz: where links cannot be made (Windows), each one becomes a copy of its target', async () => {
  const dest = join(scratch(), 'out');
  await extractTarGz(archiveFile(buildTarGzWithModes([
    ...FRAMEWORK,
    { path: 'up', type: '2', link: '_internal' },
    { path: 'dangling', type: '2', link: 'nowhere' },
  ]), 'c.tar.gz'), dest, undefined, 'copy');
  const fw = join(dest, '_internal', 'Python.framework');
  assert.equal(readFileSync(join(dest, '_internal', 'Python'), 'utf8'), 'libpython');
  assert.equal(readFileSync(join(fw, 'Versions', 'Current', 'Resources', 'Info.plist'), 'utf8'), 'plist');
  assert.equal(readFileSync(join(fw, 'Resources', 'Info.plist'), 'utf8'), 'plist');
  assert.equal(lstatSync(join(fw, 'Versions', 'Current')).isDirectory(), true);
  assert.equal(readFileSync(join(dest, 'up', 'Python'), 'utf8'), 'libpython', 'a folder is copied once its own links are in place');
  if (posix) assert.equal(statSync(join(fw, 'Python')).mode & 0o777, 0o755);
  assert.equal(existsSync(join(dest, 'dangling')), false, 'a dangling link is skipped');

  // The copies count against the same budget: a link cannot multiply a big file past the limit.
  const many = buildTarGzWithModes([
    { path: 'big', data: Buffer.alloc(30_000, 1) },
    { path: 'c1', type: '2', link: 'big' },
    { path: 'c2', type: '2', link: 'big' },
  ]);
  await rejects(() => extractTarGz(archiveFile(many, 'm.tar.gz'), join(scratch(), 'o'), { maxExpandedBytes: 70_000, maxEntries: 100 }, 'copy'), 'too-large');
  // And the refusals hold in this mode too.
  const out = buildTarGzWithModes([{ path: 'l', type: '2', link: '../outside' }]);
  await rejects(() => extractTarGz(archiveFile(out, 'o.tar.gz'), join(scratch(), 'o'), undefined, 'copy'), 'link');
});

test('tar.gz: a link to a folder above it is refused in both modes, even reached through another link', async () => {
  const modes = ['symlink', 'copy'] as const;
  for (const mode of modes) {
    // Spelled as an ancestor: refused before anything is placed.
    const self = buildTarGzWithModes([{ path: '_internal/sub/', type: '5' }, { path: '_internal/sub/self', type: '2', link: '..' }]);
    await rejects(() => extractTarGz(archiveFile(self, 's.tar.gz'), join(scratch(), 'o'), undefined, mode), 'link');
  }
  if (!posix) return;
  // `l -> a`, then `a/b/x -> ../../l`: no string says ancestor, the disk does (`x` is the folder `a` above it).
  const viaLink = buildTarGzWithModes([
    { path: 'a/b/', type: '5' },
    { path: 'l', type: '2', link: 'a' },
    { path: 'a/b/x', type: '2', link: '../../l' },
  ]);
  await rejects(() => extractTarGz(archiveFile(viaLink, 'v.tar.gz'), join(scratch(), 'o'), undefined, 'symlink'), 'link');
  // Copied, the two links wait on each other: both are skipped, nothing copies itself.
  const dest = join(scratch(), 'o');
  await extractTarGz(archiveFile(viaLink, 'v.tar.gz'), dest, undefined, 'copy');
  assert.equal(existsSync(join(dest, 'l')), false);
  assert.equal(existsSync(join(dest, 'a', 'b', 'x')), false);
});

test('tar.gz: where the disk folds case and Unicode form, two spellings of one name are refused', async () => {
  const nfc = 'caf\u00e9';
  const nfd = 'cafe\u0301';
  const cases: Array<[string, Parameters<typeof buildTarGzWithModes>[0], string]> = [
    ['case', [{ path: 'a/', type: '5' }, { path: 'A/f', data: 'x' }], 'unsafe-path'],
    ['case, files', [{ path: 'Readme', data: 'x' }, { path: 'README', data: 'y' }], 'unsafe-path'],
    ['unicode form', [{ path: `${nfc}/`, type: '5' }, { path: `${nfd}/f`, data: 'x' }], 'unsafe-path'],
    // The reviewed case: on APFS or NTFS `../A` is `a` itself, which the string checks call another folder.
    ['link to its folder by case', [{ path: 'a/', type: '5' }, { path: 'a/x', type: '2', link: '../A' }], 'link'],
    ['link by unicode form', [{ path: `${nfc}/f`, data: 'x' }, { path: 'l', type: '2', link: `${nfd}/f` }], 'link'],
    // The link entry comes first: its target is checked once every entry is known.
    ['link before its target', [{ path: 'l', type: '2', link: 'LIB' }, { path: 'lib/', type: '5' }], 'link'],
  ];
  for (const mode of ['symlink', 'copy'] as const) {
    if (mode === 'symlink' && !posix) continue;
    for (const [label, files, code] of cases) {
      const dest = join(scratch(), 'o');
      await assert.rejects(
        () => extractTarGz(archiveFile(buildTarGzWithModes(files), 'x.tar.gz'), dest, undefined, mode, true),
        (err: unknown) => err instanceof ArchiveError && err.code === code,
        `${mode}, ${label}: ${code}`,
      );
      assert.equal(existsSync(join(dest, 'a', 'x', 'x')), false, `${mode}, ${label}: nothing copied into itself`);
    }
  }
  // Same spelling twice is no collision, and where the disk compares bytes both names are kept.
  const dest = join(scratch(), 'o');
  await extractTarGz(archiveFile(buildTarGzWithModes([
    { path: 'lib/', type: '5' }, { path: 'lib/', type: '5' }, { path: 'lib/f', data: 'x' }, { path: 'l', type: '2', link: 'lib/f' },
  ]), 'same.tar.gz'), dest, undefined, 'copy', true);
  assert.equal(readFileSync(join(dest, 'l'), 'utf8'), 'x');
  if (process.platform === 'linux') {
    const bytes = join(scratch(), 'o');
    await extractTarGz(archiveFile(buildTarGzWithModes([{ path: 'Readme', data: 'x' }, { path: 'README', data: 'y' }]), 'r.tar.gz'), bytes);
    assert.equal(readFileSync(join(bytes, 'README'), 'utf8'), 'y');
  }
});

/** Whether the scratch disk calls two spellings one name (APFS, NTFS: case; APFS: Unicode form too). */
function diskFolds(a: string, b: string): boolean {
  const dir = scratch();
  writeFileSync(join(dir, a), '');
  return existsSync(join(dir, b));
}

test('tar.gz: on a disk that folds names, a link to its own folder by another spelling is refused by identity alone', async (t) => {
  const nfc = 'caf\u00e9';
  const nfd = 'cafe\u0301';
  const cases: Array<[string, Parameters<typeof buildTarGzWithModes>[0], boolean]> = [
    ['case', [{ path: 'a/', type: '5' }, { path: 'a/x', type: '2', link: '../A' }], diskFolds('Probe', 'probe')],
    ['unicode form', [{ path: `${nfc}/`, type: '5' }, { path: `${nfc}/x`, type: '2', link: `../${nfd}` }], diskFolds(nfc, nfd)],
  ];
  if (!cases.some(([, , folds]) => folds)) return t.skip('this disk compares names byte for byte');
  for (const mode of ['symlink', 'copy'] as const) {
    if (mode === 'symlink' && !posix) continue;
    for (const [label, files, folds] of cases) {
      if (!folds) continue;
      // `foldNames` off: the spelling check stays out of the way, the disk identity check alone must refuse.
      await assert.rejects(
        () => extractTarGz(archiveFile(buildTarGzWithModes(files), 'x.tar.gz'), join(scratch(), 'o'), undefined, mode, false),
        (err: unknown) => err instanceof ArchiveError && err.code === 'link',
        `${mode}, ${label}`,
      );
    }
  }
});

test('tar.gz: GNU long name and long link records are read', { skip: !posix }, async () => {
  const deep = `${'d'.repeat(70)}/${'e'.repeat(70)}`;
  const dest = join(scratch(), 'out');
  await extractTarGz(archiveFile(buildTarGzWithModes([
    { path: '././@LongLink', type: 'L', data: `${deep}/file\0` },
    { path: 'cut-name', data: 'deep' },
    { path: '././@LongLink', type: 'K', data: `${deep}/file\0` },
    { path: 'short', type: '2', link: 'cut-link' },
  ]), 'k.tar.gz'), dest, undefined, 'symlink');
  assert.equal(readFileSync(join(dest, ...deep.split('/'), 'file'), 'utf8'), 'deep');
  assert.equal(readlinkSync(join(dest, 'short')), `${deep}/file`);
  // A long target is held to the same rules as a short one.
  const out = buildTarGzWithModes([{ path: '././@LongLink', type: 'K', data: `../${deep}\0` }, { path: 'l', type: '2', link: 'ok' }]);
  await rejects(() => extractTarGz(archiveFile(out, 'o.tar.gz'), join(scratch(), 'o'), undefined, 'symlink'), 'link');
});

test('tar.gz: limits cut a bomb and a flood; garbage is "corrupt"', async () => {
  const dest = join(scratch(), 'o');
  const big = archiveFile(buildTarGzWithModes([{ path: 'big', data: Buffer.alloc(100_000, 1) }]), 'b.tar.gz');
  await rejects(() => extractTarGz(big, dest, { maxExpandedBytes: 50_000, maxEntries: 10 }), 'too-large');
  const many = archiveFile(buildTarGzWithModes([{ path: 'a', data: '1' }, { path: 'b', data: '2' }, { path: 'c', data: '3' }]), 'm.tar.gz');
  await rejects(() => extractTarGz(many, join(scratch(), 'o'), { maxExpandedBytes: 1e6, maxEntries: 2 }), 'too-many-entries');
  await rejects(() => extractTarGz(archiveFile(Buffer.from('not a gzip'), 'g.tar.gz'), join(scratch(), 'o')), 'corrupt');
});

test('zip: stored and deflated entries extract, unix modes kept, directories made', async () => {
  const dest = join(scratch(), 'out');
  const file = archiveFile(buildZip([
    { path: 'dist/', data: '' },
    { path: 'dist/agent', data: 'program', unixMode: 0o755 },
    { path: 'dist/notes.txt', data: 'a'.repeat(5000), unixMode: 0o666 },
    { path: 'dist/raw.bin', data: 'stored', stored: true },
  ]), 'a.zip');
  await extractZip(file, dest);
  assert.equal(readFileSync(join(dest, 'dist', 'agent'), 'utf8'), 'program');
  assert.equal(readFileSync(join(dest, 'dist', 'notes.txt'), 'utf8').length, 5000);
  assert.equal(readFileSync(join(dest, 'dist', 'raw.bin'), 'utf8'), 'stored');
  if (posix) assert.equal(statSync(join(dest, 'dist', 'agent')).mode & 0o777, 0o755);
});

test('zip: Windows separators are read as folders, traversal and links are refused', async () => {
  const dest = join(scratch(), 'out');
  await extractZip(archiveFile(buildZip([{ path: 'dist-package\\cursor-agent.cmd', data: '@echo off' }]), 'w.zip'), dest);
  assert.equal(readFileSync(join(dest, 'dist-package', 'cursor-agent.cmd'), 'utf8'), '@echo off');

  const base = scratch();
  await rejects(() => extractZip(archiveFile(buildZip([{ path: '../evil', data: 'x' }]), 'a.zip'), join(base, 'a')), 'unsafe-path');
  await rejects(() => extractZip(archiveFile(buildZip([{ path: '..\\evil', data: 'x' }]), 'b.zip'), join(base, 'b')), 'unsafe-path');
  await rejects(() => extractZip(archiveFile(buildZip([{ path: '/abs', data: 'x' }]), 'c.zip'), join(base, 'c')), 'unsafe-path');
  await rejects(() => extractZip(archiveFile(buildZip([{ path: 'l', data: '/etc/passwd', symlink: true }]), 'd.zip'), join(base, 'd')), 'link');
  await rejects(() => extractZip(archiveFile(buildZip([{ path: 'e', data: 'x', encrypted: true }]), 'e.zip'), join(base, 'e')), 'unsupported');
  await rejects(() => extractZip(archiveFile(Buffer.from('not a zip at all, long enough to scan for a directory'), 'f.zip'), join(base, 'f')), 'corrupt');
  assert.equal(existsSync(join(base, 'evil')), false);
});

test('zip: an entry cannot inflate past its declared size, nor the archive past the limit', async () => {
  const lying = buildZip([{ path: 'f', data: 'a'.repeat(4000) }]);
  // Declared size in the central directory shrunk to 10 bytes.
  const at = lying.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  lying.writeUInt32LE(10, at + 24);
  await rejects(() => extractZip(archiveFile(lying, 'l.zip'), join(scratch(), 'o')), 'too-large');
  const honest = archiveFile(buildZip([{ path: 'f', data: 'a'.repeat(4000) }]), 'h.zip');
  await rejects(() => extractZip(honest, join(scratch(), 'o'), { maxExpandedBytes: 1000, maxEntries: 10 }), 'too-large');
});

test('raw program: installed under its own basename, executable', () => {
  const src = archiveFile(Buffer.from('#!/bin/sh\n'), 'download');
  const dest = join(scratch(), 'bin');
  const path = installRaw(src, dest, './sub/agent');
  assert.equal(path, join(dest, 'agent'));
  if (posix) assert.equal(statSync(path).mode & 0o777, 0o755);
  assert.throws(() => installRaw(src, dest, '..'), ArchiveError);
});
