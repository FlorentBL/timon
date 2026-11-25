/**
 * Opening the archive of a downloaded agent.
 *
 * The archive is attacker-reachable (a compromised release asset is exactly
 * what the sha256 is for, and half of the registry publishes none), so the
 * extraction is as strict as `plugins/tar-reader.ts` and differs from it in
 * the three ways an agent program needs:
 *  - it STREAMS (the Cursor package is 184 MB packed: a Buffer would double
 *    that), with a ceiling on the inflated size;
 *  - it keeps the layout as published — `./dist-package/cursor-agent` is a path
 *    inside the archive, nothing is stripped — and the executable bit
 *    (a 129 MB `node` ships beside the launcher and must stay runnable);
 *  - it also opens `.zip` (the Windows builds), by hand with `node:zlib`.
 *
 * Refused outright: absolute paths, `..`, backslash tricks, NUL, drive
 * letters, hard links, devices, anything past the limits. The resolved target
 * of every entry is checked to stay inside the destination.
 *
 * Symbolic links are accepted in a tar.gz only, because a macOS framework
 * bundled by PyInstaller is made of them (`Versions/Current -> 3.12`). A link
 * is kept only when its target cannot leave the destination, which
 * `linkTargetOf` proves without touching the disk, and links are placed after
 * every file and folder, so no entry is ever written through one. The zip
 * reader still refuses them: no agent needs one there.
 *
 * Path strings are not identities: on a disk that ignores case or Unicode form
 * (APFS, NTFS), `a` and `A`, or an accented letter written two ways, name one
 * entry. So two spellings of one name are refused on every system (`Spellings`):
 * the disk that folds them is not a property of the OS (vfat, exFAT, ntfs3 or
 * ext4 casefold on Linux), and no published agent archive holds such a pair.
 * What a link reaches on disk is also compared by file identity, never by
 * string, before it is kept or copied (`assertNotAncestor`), and a target the
 * disk cannot identify is refused rather than waved through.
 */
import {
  chmodSync, closeSync, copyFileSync, createReadStream, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readSync,
  realpathSync, statSync, symlinkSync, writeSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { createGunzip, createInflateRaw } from 'node:zlib';
import { windowsSegmentProblem } from '../../host/portable-names.js';
import type { Readable } from 'node:stream';

export class ArchiveError extends Error {
  constructor(
    readonly code: 'unsafe-path' | 'link' | 'too-large' | 'too-many-entries' | 'corrupt' | 'unsupported',
    message: string,
  ) {
    super(message);
    this.name = 'ArchiveError';
  }
}

export type ExtractLimits = { maxExpandedBytes: number; maxEntries: number };
export const DEFAULT_EXTRACT_LIMITS: ExtractLimits = Object.freeze({
  maxExpandedBytes: 2 * 1024 ** 3,
  maxEntries: 50_000,
});

function segmentsOf(raw: string): string[] {
  const name = raw.replaceAll('\\', '/');
  if (name.includes('\0')) throw new ArchiveError('unsafe-path', 'archive entry with an unsafe path');
  if (name.startsWith('/') || /^[a-zA-Z]:/.test(name) || isAbsolute(name)) {
    throw new ArchiveError('unsafe-path', 'archive entry with an absolute path');
  }
  const parts = name.split('/').filter((part) => part !== '' && part !== '.');
  if (parts.some((part) => part === '..')) throw new ArchiveError('unsafe-path', 'archive entry escaping its folder (`..`)');
  // Only where it bites: an agent archive is built per OS, and a Linux build may
  // legitimately hold a name Windows refuses. Here it is a clean code, not a raw `fs` error.
  if (process.platform === 'win32') {
    for (const part of parts) {
      const problem = windowsSegmentProblem(part);
      if (problem) throw new ArchiveError('unsafe-path', `archive entry ${JSON.stringify(parts.join('/'))} has ${problem}`);
    }
  }
  return parts;
}

/** Where an entry lands, proven to be inside `root`. */
function targetOf(root: string, raw: string): string | null {
  const parts = segmentsOf(raw);
  if (parts.length === 0) return null;
  const target = resolve(root, ...parts);
  if (target === root || !target.startsWith(root + sep)) {
    throw new ArchiveError('unsafe-path', 'archive entry escaping its folder');
  }
  return target;
}

/** Runnable stays runnable, nothing else gains a bit. */
function modeOf(unixMode: number): number {
  return unixMode & 0o111 ? 0o755 : 0o644;
}

class Budget {
  private expanded = 0;
  private entries = 0;
  constructor(private readonly limits: ExtractLimits) {}
  entry(): void {
    if (++this.entries > this.limits.maxEntries) throw new ArchiveError('too-many-entries', 'archive has too many entries');
  }
  bytes(n: number): void {
    this.expanded += n;
    if (this.expanded > this.limits.maxExpandedBytes) throw new ArchiveError('too-large', 'archive expands beyond the allowed size');
  }
}

/* ── tar.gz ─────────────────────────────────────────────────────────────── */

function cString(buf: Buffer, start: number, length: number): string {
  const slice = buf.subarray(start, start + length);
  const nul = slice.indexOf(0);
  return slice.subarray(0, nul === -1 ? slice.length : nul).toString('utf8');
}

function octal(buf: Buffer, start: number, length: number): number {
  const raw = cString(buf, start, length).trim();
  if (raw === '') return 0;
  if (!/^[0-7]+$/.test(raw)) throw new ArchiveError('corrupt', 'invalid number in an archive header');
  return Number.parseInt(raw, 8);
}

function paxRecord(data: Buffer, key: string): string | null {
  const text = data.toString('utf8');
  let offset = 0;
  while (offset < text.length) {
    const space = text.indexOf(' ', offset);
    if (space === -1) break;
    const length = Number.parseInt(text.slice(offset, space), 10);
    if (!Number.isFinite(length) || length <= 0) break;
    const record = text.slice(space + 1, offset + length - 1);
    if (record.startsWith(`${key}=`)) return record.slice(key.length + 1);
    offset += length;
  }
  return null;
}

/* ── symbolic links (tar.gz only) ───────────────────────────────────────── */

/** A link read from the archive, placed once every file and folder is written. */
type PendingLink = { path: string; target: string };

/**
 * How links are materialised. Creating one on Windows needs a privilege most
 * accounts lack, so there the target is copied instead.
 */
export type LinkMode = 'symlink' | 'copy';

/**
 * Checks a link target and returns it normalised (forward slashes).
 *
 * Accepted: relative, no NUL, no backslash, made of `..` segments first and
 * plain names after (`../Resources`, `Versions/Current/Python`), landing
 * strictly inside `root` when resolved from the link's own folder.
 *
 * Why the shape rule: the lexical check alone is fooled by a chain. With
 * `l1 -> ../../c` in `a/b/`, the target `l1/../../../evil` resolves to
 * `root/evil` on paper, but the system follows `l1` first and climbs out of
 * the root. Once every `..` comes first, the climb walks real folders only
 * (the link's parents are never links, see `assertNoLinkAbove`), so it stays
 * where the lexical check says; the names that follow descend from there, each
 * either a real entry or another link held to the same rule.
 */
function linkTargetOf(root: string, linkPath: string, raw: string): string {
  if (raw === '' || raw.includes('\0') || raw.includes('\\')) {
    throw new ArchiveError('link', 'archive contains a link with an unsafe target');
  }
  if (raw.startsWith('/') || /^[a-zA-Z]:/.test(raw) || isAbsolute(raw)) {
    throw new ArchiveError('link', 'archive contains a link to an absolute path');
  }
  const parts = raw.split('/').filter((part) => part !== '' && part !== '.');
  if (parts.length === 0) throw new ArchiveError('link', 'archive contains a link to its own folder');
  const firstName = parts.findIndex((part) => part !== '..');
  if (firstName !== -1 && parts.slice(firstName).includes('..')) {
    throw new ArchiveError('link', 'archive contains a link that climbs back after descending');
  }
  const resolved = resolve(dirname(linkPath), ...parts);
  if (resolved === root || !resolved.startsWith(root + sep)) {
    throw new ArchiveError('link', 'archive contains a link pointing outside its folder');
  }
  // A link to a folder above it makes an endless tree (`self/sub/self/…`), and its copy would never end. This is the
  // string check; `assertNotAncestor` repeats it on disk, where another spelling or another link reaches the same folder.
  if (linkPath.startsWith(resolved + sep)) throw new ArchiveError('link', 'archive contains a link to a folder above it');
  return parts.join('/');
}

/** Case and Unicode form folded the way APFS and NTFS compare names, a little stricter when unsure (sharp s = `ss`). */
function foldName(name: string): string {
  return name.normalize('NFD').toUpperCase().toLowerCase().normalize('NFC');
}

/**
 * One spelling per name, on every system. Where the disk folds case and Unicode
 * form, `a/` then `A/x`, or a link to `../A` beside `a/`, would reach an entry
 * the string checks believe distinct: refused instead. Which disk folds is not
 * known from the OS, so the rule never depends on it.
 *
 * The rule is the strictest one: two spellings of the same path are refused,
 * between entries as well as between an entry and a link target, whatever the
 * folder. It costs nothing to the real bundles: none of the tar.gz of the ACP
 * catalog (all 77, every platform, link targets included, 25/11/2026) holds
 * such a pair. The same name spelled two ways in two different folders
 * (`a/Readme`, `b/README`) is two paths, and stays accepted.
 */
class Spellings {
  private readonly seen = new Map<string, string>();
  constructor(private readonly root: string) {}

  private *prefixes(path: string): Generator<[key: string, spelled: string]> {
    const parts = path.slice(this.root.length + 1).split(sep);
    for (let i = 1; i <= parts.length; i += 1) {
      const spelled = parts.slice(0, i).join('/');
      yield [parts.slice(0, i).map(foldName).join('/'), spelled];
    }
  }

  /** Records an entry and every folder on its way. */
  claim(path: string): void {
    for (const [key, spelled] of this.prefixes(path)) {
      const known = this.seen.get(key);
      if (known === undefined) this.seen.set(key, spelled);
      else if (known !== spelled) {
        throw new ArchiveError('unsafe-path', 'archive holds two names that differ only by case or Unicode form');
      }
    }
  }

  /** Checks where a link points against the recorded entries, once they are all known. */
  checkTarget(path: string): void {
    for (const [key, spelled] of this.prefixes(path)) {
      const known = this.seen.get(key);
      if (known !== undefined && known !== spelled) {
        throw new ArchiveError('link', 'archive contains a link spelling an entry with another case or Unicode form');
      }
    }
  }
}

/**
 * How the identity check asks the disk what a path is (it follows links). A
 * parameter so that a test can play a volume that gives no usable identity.
 */
export type IdentityProbe = (path: string) => { dev: bigint; ino: bigint };
const diskIdentity: IdentityProbe = (path) => statSync(path, { bigint: true });

/**
 * What the disk calls a file, whatever the string spelling it. Fail-closed: a
 * path that exists but cannot be identified (an error, or `ino` 0 on a volume
 * without file ids) refuses the archive, since the check it serves would
 * otherwise be skipped exactly where names may fold.
 */
function identityOf(probe: IdentityProbe, path: string): string {
  let info: { dev: bigint; ino: bigint };
  try {
    info = probe(path);
  } catch {
    throw new ArchiveError('link', 'archive contains a link whose target the disk cannot identify');
  }
  if (info.ino === 0n) throw new ArchiveError('link', 'archive contains a link whose target the disk cannot identify');
  return `${info.dev}:${info.ino}`;
}

/** Refuses `target` when it is, on disk, `linkPath`'s own folder or one of the folders above it, up to `root`. */
function assertNotAncestor(probe: IdentityProbe, root: string, linkPath: string, target: string): void {
  const id = identityOf(probe, target);
  for (let dir = dirname(linkPath); dir.length >= root.length; dir = dirname(dir)) {
    if (identityOf(probe, dir) === id) throw new ArchiveError('link', 'archive contains a link to a folder above it');
    if (dir === root) return;
  }
}

function missing(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | null)?.code === 'ENOENT';
}

/** Refuses to create anything below a folder that is in fact a link. */
function assertNoLinkAbove(root: string, path: string): void {
  let current = root;
  for (const part of dirname(path).slice(root.length + 1).split(sep).filter(Boolean)) {
    current = join(current, part);
    let info;
    try {
      info = lstatSync(current);
    } catch (err) {
      // Not there yet: nothing below it can be a link, and `mkdir` makes real folders. Any other error refuses.
      if (missing(err)) return;
      throw new ArchiveError('unsafe-path', 'archive entry placed below a folder the disk cannot read');
    }
    if (info.isSymbolicLink()) throw new ArchiveError('link', 'archive writes through a link');
    if (!info.isDirectory()) throw new ArchiveError('unsafe-path', 'archive entry placed below a file');
  }
}

function alreadyThere(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | null)?.code === 'EEXIST';
}

function placeSymlinks(root: string, links: readonly PendingLink[], probe: IdentityProbe): void {
  for (const link of links) {
    assertNoLinkAbove(root, link.path);
    mkdirSync(dirname(link.path), { recursive: true });
    try {
      symlinkSync(link.target, link.path);
    } catch (err) {
      if (alreadyThere(err)) throw new ArchiveError('unsafe-path', 'archive writes the same entry twice');
      throw err;
    }
  }
  // Belt and braces over the shape rule: what the system really reaches. A loop is refused (nothing needs one, and
  // it would trap whoever follows it), whether the system sees it (ELOOP) or not (a link to a folder above it, reached
  // through another link or another spelling); a dangling link reaches nothing, so it may stay.
  const realRoot = realpathSync(root);
  for (const link of links) {
    let real: string;
    try {
      real = realpathSync(link.path);
    } catch (err) {
      if (missing(err)) continue;
      throw new ArchiveError('link', 'archive contains a link that loops');
    }
    // A string test, safe here: both sides come from `realpath` over the same root, so another spelling of the root
    // can only make it refuse a link that is inside, never accept one that is out.
    if (real === realRoot || !real.startsWith(realRoot + sep)) {
      throw new ArchiveError('link', 'archive contains a link pointing outside its folder');
    }
    assertNotAncestor(probe, root, link.path, link.path);
  }
}

/** Copies a file or a folder of the extracted tree, counted against the same budget as the archive. */
function copyEntry(from: string, to: string, budget: Budget): void {
  const info = lstatSync(from);
  budget.entry();
  if (info.isDirectory()) {
    mkdirSync(to);
    for (const name of readdirSync(from)) copyEntry(join(from, name), join(to, name), budget);
    return;
  }
  if (!info.isFile()) return;
  budget.bytes(info.size);
  copyFileSync(from, to);
  chmodSync(to, modeOf(info.mode));
}

/**
 * The Windows stand-in for links: each one becomes a copy of its target. A link
 * may point through another one (`Python -> Versions/Current/Python`), so
 * passes repeat until none progresses; what is left (dangling, or links that
 * wait on each other) is skipped, never followed. A link to a folder above it is
 * refused: its copy would contain itself.
 */
function placeCopies(root: string, links: readonly PendingLink[], budget: Budget, probe: IdentityProbe): void {
  let left = [...links];
  for (;;) {
    const waiting: PendingLink[] = [];
    for (const link of left) {
      const source = resolve(dirname(link.path), ...link.target.split('/'));
      let exists = true;
      try {
        lstatSync(source);
      } catch (err) {
        if (!missing(err)) throw new ArchiveError('link', 'archive contains a link whose target the disk cannot read');
        exists = false;
      }
      // Wait while another pending link sits on the way to the source or inside it: copied now, it would be missing.
      const blocked = left.some((other) => other !== link
        && (other.path === source || source.startsWith(other.path + sep) || other.path.startsWith(source + sep)));
      if (!exists || blocked) {
        waiting.push(link);
        continue;
      }
      assertNoLinkAbove(root, link.path);
      mkdirSync(dirname(link.path), { recursive: true });
      // By identity, once every folder above the link exists: on NTFS `../A` beside `a/` is the folder `a`, which the
      // strings call another one.
      assertNotAncestor(probe, root, link.path, source);
      try {
        copyEntry(source, link.path, budget);
      } catch (err) {
        if (alreadyThere(err)) throw new ArchiveError('unsafe-path', 'archive writes the same entry twice');
        throw err;
      }
    }
    if (waiting.length === 0 || waiting.length === left.length) return;
    left = waiting;
  }
}

/** Streams a `.tar.gz` into `dest`, layout and executable bits preserved. */
export async function extractTarGz(
  file: string,
  dest: string,
  limits: ExtractLimits = DEFAULT_EXTRACT_LIMITS,
  linkMode: LinkMode = process.platform === 'win32' ? 'copy' : 'symlink',
  probe: IdentityProbe = diskIdentity,
): Promise<void> {
  const root = resolve(dest);
  mkdirSync(root, { recursive: true });
  const budget = new Budget(limits);
  const spellings = new Spellings(root);
  const source: Readable = createReadStream(file).pipe(createGunzip());
  const chunks = source[Symbol.asyncIterator]() as AsyncIterator<Buffer>;
  let pending: Buffer = Buffer.alloc(0);

  const fill = async (min: number): Promise<boolean> => {
    while (pending.length < min) {
      let next: IteratorResult<Buffer>;
      try { next = await chunks.next(); } catch { throw new ArchiveError('corrupt', 'archive could not be decompressed'); }
      if (next.done) return false;
      pending = pending.length ? Buffer.concat([pending, next.value]) : next.value;
    }
    return true;
  };
  /** Feeds `size` bytes to `sink` (or drops them when `sink` is null). */
  const consume = async (size: number, sink: ((chunk: Buffer) => void) | null): Promise<void> => {
    let remaining = size;
    while (remaining > 0) {
      if (pending.length === 0 && !(await fill(1))) throw new ArchiveError('corrupt', 'archive is truncated');
      const take = Math.min(pending.length, remaining);
      sink?.(pending.subarray(0, take));
      pending = pending.subarray(take);
      remaining -= take;
    }
  };
  const readSmall = async (size: number): Promise<Buffer> => {
    if (size > 1024 * 1024) throw new ArchiveError('corrupt', 'archive metadata record is too large');
    const parts: Buffer[] = [];
    await consume(size, (chunk) => parts.push(Buffer.from(chunk)));
    return Buffer.concat(parts);
  };

  let longName: string | null = null;
  let longLink: string | null = null;
  const links: PendingLink[] = [];
  try {
    for (;;) {
      if (!(await fill(512))) break;
      const header = pending.subarray(0, 512);
      pending = pending.subarray(512);
      if (header.every((b) => b === 0)) break;
      const size = octal(header, 124, 12);
      const type = String.fromCharCode(header[156] ?? 0);
      const padding = (512 - (size % 512)) % 512;

      if (type === 'x' || type === 'L' || type === 'K' || type === 'g') {
        const data = await readSmall(size);
        await consume(padding, null);
        if (type === 'x') {
          longName = paxRecord(data, 'path') ?? longName;
          longLink = paxRecord(data, 'linkpath') ?? longLink;
        } else if (type === 'L') longName = cString(data, 0, data.length);
        else if (type === 'K') longLink = cString(data, 0, data.length);
        continue;
      }
      const prefix = cString(header, 345, 155);
      const name = cString(header, 0, 100);
      const raw = longName ?? (prefix ? `${prefix}/${name}` : name);
      const rawLink = longLink ?? cString(header, 157, 100);
      longName = null;
      longLink = null;

      if (type === '1') throw new ArchiveError('link', 'archive contains a hard link — not allowed');
      const kind = type === '0' || type === '\0' || type === '7' ? 'file' : type === '5' ? 'dir' : type === '2' ? 'symlink' : null;
      if (kind === null) throw new ArchiveError('link', 'archive contains a special entry (device, fifo…) — not allowed');

      budget.entry();
      const target = targetOf(root, raw);
      if (target) spellings.claim(target);
      if (kind === 'symlink') {
        if (!target) throw new ArchiveError('unsafe-path', 'archive link entry without a name');
        links.push({ path: target, target: linkTargetOf(root, target, rawLink) });
        await consume(size + padding, null);
        continue;
      }
      if (kind === 'dir') {
        if (target) mkdirSync(target, { recursive: true });
        await consume(size + padding, null);
        continue;
      }
      if (!target) throw new ArchiveError('unsafe-path', 'archive file entry without a name');
      mkdirSync(dirname(target), { recursive: true });
      const fd = openSync(target, 'wx', 0o600);
      try {
        await consume(size, (chunk) => { budget.bytes(chunk.length); writeSync(fd, chunk); });
      } finally {
        closeSync(fd);
      }
      chmodSync(target, modeOf(octal(header, 100, 8)));
      await consume(padding, null);
    }
  } finally {
    source.destroy();
  }
  // Last, so that no file or folder of the archive is ever written through a link.
  for (const link of links) spellings.checkTarget(resolve(dirname(link.path), ...link.target.split('/')));
  if (linkMode === 'symlink') placeSymlinks(root, links, probe);
  else placeCopies(root, links, budget, probe);
}

/* ── zip ────────────────────────────────────────────────────────────────── */

type ZipEntry = { name: string; method: number; compressed: number; size: number; offset: number; unixMode: number; dir: boolean };

function readAt(fd: number, position: number, length: number): Buffer {
  const out = Buffer.alloc(length);
  let done = 0;
  while (done < length) {
    const n = readSync(fd, out, done, length - done, position + done);
    if (n === 0) throw new ArchiveError('corrupt', 'archive is truncated');
    done += n;
  }
  return out;
}

function zipEntries(fd: number, limits: ExtractLimits): ZipEntry[] {
  const total = fstatSync(fd).size;
  const tailLength = Math.min(total, 65_557);
  const tail = readAt(fd, total - tailLength, tailLength);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i -= 1) {
    if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new ArchiveError('corrupt', 'not a zip archive');
  const count = tail.readUInt16LE(eocd + 10);
  const cdSize = tail.readUInt32LE(eocd + 12);
  const cdOffset = tail.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    throw new ArchiveError('unsupported', 'zip64 archives are not supported');
  }
  if (count > limits.maxEntries) throw new ArchiveError('too-many-entries', 'archive has too many entries');
  const directory = readAt(fd, cdOffset, cdSize);
  const entries: ZipEntry[] = [];
  let at = 0;
  for (let i = 0; i < count; i += 1) {
    if (at + 46 > directory.length || directory.readUInt32LE(at) !== 0x02014b50) throw new ArchiveError('corrupt', 'bad zip directory');
    const madeByHost = directory.readUInt8(at + 5);
    const flags = directory.readUInt16LE(at + 8);
    const method = directory.readUInt16LE(at + 10);
    const compressed = directory.readUInt32LE(at + 20);
    const size = directory.readUInt32LE(at + 24);
    const nameLength = directory.readUInt16LE(at + 28);
    const extraLength = directory.readUInt16LE(at + 30);
    const commentLength = directory.readUInt16LE(at + 32);
    const external = directory.readUInt32LE(at + 38);
    const offset = directory.readUInt32LE(at + 42);
    const name = directory.subarray(at + 46, at + 46 + nameLength).toString('utf8');
    at += 46 + nameLength + extraLength + commentLength;
    if (flags & 1) throw new ArchiveError('unsupported', 'encrypted zip entries are not supported');
    if (compressed === 0xffffffff || size === 0xffffffff || offset === 0xffffffff) {
      throw new ArchiveError('unsupported', 'zip64 archives are not supported');
    }
    const unixMode = madeByHost === 3 ? external >>> 16 : 0;
    if ((unixMode & 0o170000) === 0o120000) throw new ArchiveError('link', 'archive contains a symbolic link — not allowed');
    entries.push({ name, method, compressed, size, offset, unixMode, dir: name.endsWith('/') || name.endsWith('\\') });
  }
  return entries;
}

export async function extractZip(file: string, dest: string, limits: ExtractLimits = DEFAULT_EXTRACT_LIMITS): Promise<void> {
  const root = resolve(dest);
  mkdirSync(root, { recursive: true });
  const budget = new Budget(limits);
  const fd = openSync(file, 'r');
  try {
    for (const entry of zipEntries(fd, limits)) {
      budget.entry();
      const target = targetOf(root, entry.name);
      if (entry.dir) {
        if (target) mkdirSync(target, { recursive: true });
        continue;
      }
      if (!target) throw new ArchiveError('unsafe-path', 'archive file entry without a name');
      if (entry.method !== 0 && entry.method !== 8) throw new ArchiveError('unsupported', 'unsupported zip compression method');
      const local = readAt(fd, entry.offset, 30);
      if (local.readUInt32LE(0) !== 0x04034b50) throw new ArchiveError('corrupt', 'bad zip entry header');
      const start = entry.offset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
      mkdirSync(dirname(target), { recursive: true });
      const out = openSync(target, 'wx', 0o600);
      try {
        let written = 0;
        const sink = (chunk: Buffer): void => {
          written += chunk.length;
          // Bounded by what the directory DECLARED, not by what the stream claims.
          if (written > entry.size) throw new ArchiveError('too-large', 'zip entry inflates beyond its declared size');
          budget.bytes(chunk.length);
          writeSync(out, chunk);
        };
        if (entry.compressed > 0) {
          const raw = createReadStream(file, { start, end: start + entry.compressed - 1 });
          const stream: Readable = entry.method === 8 ? raw.pipe(createInflateRaw()) : raw;
          try {
            for await (const chunk of stream) sink(chunk as Buffer);
          } catch (err) {
            if (err instanceof ArchiveError) throw err;
            throw new ArchiveError('corrupt', 'zip entry could not be decompressed');
          } finally {
            raw.destroy();
            stream.destroy();
          }
        }
        if (written !== entry.size) throw new ArchiveError('corrupt', 'zip entry is shorter than declared');
      } finally {
        closeSync(out);
      }
      chmodSync(target, modeOf(entry.unixMode));
    }
  } finally {
    closeSync(fd);
  }
}

/* ── raw program ────────────────────────────────────────────────────────── */

/** A download that is the program itself. */
export function installRaw(file: string, dest: string, name: string): string {
  const root = resolve(dest);
  mkdirSync(root, { recursive: true });
  const target = targetOf(root, basename(name.replaceAll('\\', '/')));
  if (!target) throw new ArchiveError('unsafe-path', 'program without a name');
  copyFileSync(file, target);
  chmodSync(target, 0o755);
  return target;
}
