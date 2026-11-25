/**
 * The Linux native modules of the package, and the glibc they need (TIM-0162).
 *
 * A native module compiled on the build machine records the newest glibc
 * symbol versions it linked against. Built on a recent distribution, the
 * 0.1.9 `pty.node` needed glibc 2.42 and the terminal failed on Debian 13;
 * `better-sqlite3`'s downloaded prebuild needs 2.29. The requirements promise
 * 2.28, the floor of the Node the package ships. Loading the module under
 * that Node on the build machine proves its ABI, never its glibc: only the
 * build machine's own, newer libc is there to answer.
 *
 * So on Linux the rebuild runs in a manylinux_2_28 container (AlmaLinux 8,
 * glibc 2.28, a current compiler), built from source rather than from a
 * prebuild, and loaded there once more; then every `.node` that ships is
 * read for the glibc versions it requires, and a single one above the floor
 * stops the build.
 *
 * Pure Node: the ELF reader needs no binutils, and every function that does
 * not spawn is a plain function of its inputs, tested on every OS.
 */
import { closeSync, fstatSync, lstatSync, openSync, readdirSync, readSync, rmSync } from 'node:fs';
import { join } from 'node:path';

/** The newest glibc a shipped binary may require. `public-docs/docs/installation/requirements.md` states it. */
export const GLIBC_FLOOR = '2.28';

/**
 * The image the Linux natives are rebuilt in, pinned by digest: a moving tag
 * could change the compiler, or the glibc, between two builds of one version.
 * The tag is kept beside it for the reader. `TIMON_NATIVE_BUILD_IMAGE`
 * replaces it (a local mirror, a newer pin under test).
 */
export const NATIVE_BUILD_IMAGES = Object.freeze({
  // quay.io/pypa/manylinux_2_28_x86_64:2026.11.21-1
  x64: 'quay.io/pypa/manylinux_2_28_x86_64@sha256:55a36963bc0504cdf004011001c1072306402f0b8b83be5a5eba7068f93eec53',
});

/** node-gyp's Python inside that image: its `/usr/bin/python3` is the distribution's, older than node-gyp wants. */
export const IMAGE_PYTHON = '/opt/python/cp312-cp312/bin/python3';

export function nativeBuildImage(env = process.env, arch = process.arch) {
  const override = env.TIMON_NATIVE_BUILD_IMAGE?.trim();
  if (override) return override;
  const image = NATIVE_BUILD_IMAGES[arch];
  if (!image) throw new Error(`no native build image for linux-${arch}: set TIMON_NATIVE_BUILD_IMAGE to a manylinux_2_28 image of that architecture`);
  return image;
}

/**
 * The `docker run` that executes `args` in the image as the calling user, with
 * each of `mounts` at its own path (paths in a command stay valid on both
 * sides), the first one read-write and the others read-only. The image's own
 * PATH is kept, the shipped Node's folder put first, through `sh -c`: `-e PATH`
 * would erase the compiler toolset the image puts on it.
 */
export function containerCommand({ image, uid, gid, workdir, writable, readonly = [], env = {}, nodeDir, args }) {
  const flags = ['run', '--rm', '--user', `${uid}:${gid}`, '-w', workdir, '-v', `${writable}:${writable}`];
  for (const dir of readonly) flags.push('-v', `${dir}:${dir}:ro`);
  for (const [key, value] of Object.entries({ ...env, TIMON_NODE_DIR: nodeDir })) flags.push('-e', `${key}=${value}`);
  return ['docker', [...flags, image, 'sh', '-c', 'PATH="$TIMON_NODE_DIR:$PATH"; export PATH; exec "$@"', 'sh', ...args]];
}

/**
 * The environment of a rebuild in the image. From source, both modules:
 * `prebuild-install` would fetch better-sqlite3's prebuild (glibc 2.29), and
 * node-pty has none for Linux anyway. HOME and the caches sit in the writable
 * mount, as the user the container runs as has no home in the image.
 */
export function containerBuildEnv(home) {
  return {
    HOME: home,
    npm_config_cache: join(home, '.npm'),
    npm_config_devdir: join(home, '.node-gyp'),
    npm_config_build_from_source: 'true',
    npm_config_python: IMAGE_PYTHON,
    PYTHON: IMAGE_PYTHON,
  };
}

// --- ELF ------------------------------------------------------------------

const SHT_GNU_VERNEED = 0x6ffffffe;

/**
 * The version names a 64-bit little-endian ELF file requires from its
 * libraries (`.gnu.version_r`, what `objdump -T` prints as `GLIBC_2.34`):
 * `[]` for an ELF that needs none (a static binary), `null` for anything that
 * is not such an ELF (a Mach-O or PE prebuild of another platform).
 */
export function elfVersionNeeds(buffer) {
  if (buffer.length < 64 || buffer.readUInt32BE(0) !== 0x7f454c46) return null;
  if (buffer[4] !== 2 || buffer[5] !== 1) return null;
  const shoff = Number(buffer.readBigUInt64LE(0x28));
  const shentsize = buffer.readUInt16LE(0x3a);
  const shnum = buffer.readUInt16LE(0x3c);
  if (!shoff || shentsize < 64 || shoff + shnum * shentsize > buffer.length) return null;
  const section = (index) => {
    const at = shoff + index * shentsize;
    return {
      type: buffer.readUInt32LE(at + 4),
      offset: Number(buffer.readBigUInt64LE(at + 0x18)),
      size: Number(buffer.readBigUInt64LE(at + 0x20)),
      link: buffer.readUInt32LE(at + 0x28),
      info: buffer.readUInt32LE(at + 0x2c),
    };
  };
  const names = [];
  for (let index = 0; index < shnum; index += 1) {
    const verneed = section(index);
    if (verneed.type !== SHT_GNU_VERNEED) continue;
    if (verneed.link >= shnum) return null;
    const strings = section(verneed.link);
    const string = (offset) => {
      const start = strings.offset + offset;
      const end = buffer.indexOf(0, start);
      return buffer.toString('latin1', start, end < 0 ? buffer.length : end);
    };
    // `sh_info` counts the entries; `vn_next`/`vna_next` chain them.
    let at = verneed.offset;
    for (let entry = 0; entry < verneed.info && at + 16 <= buffer.length; entry += 1) {
      const count = buffer.readUInt16LE(at + 2);
      let aux = at + buffer.readUInt32LE(at + 8);
      for (let n = 0; n < count && aux + 16 <= buffer.length; n += 1) {
        names.push(string(buffer.readUInt32LE(aux + 8)));
        const next = buffer.readUInt32LE(aux + 12);
        if (!next) break;
        aux += next;
      }
      const next = buffer.readUInt32LE(at + 12);
      if (!next) break;
      at += next;
    }
  }
  return names;
}

/** `-1`, `0` or `1`, numerically: `2.9` is older than `2.28`. */
export function compareGlibc(a, b) {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff) return Math.sign(diff);
  }
  return 0;
}

/** The newest `GLIBC_x.y` among version names, or null. `GLIBC_PRIVATE` is no version. */
export function newestGlibc(names) {
  let newest = null;
  for (const name of names ?? []) {
    const match = /^GLIBC_(\d+(?:\.\d+)+)$/.exec(name);
    if (match && (!newest || compareGlibc(match[1], newest) > 0)) newest = match[1];
  }
  return newest;
}

function readFile(path) {
  const fd = openSync(path, 'r');
  try {
    const { size } = fstatSync(fd);
    const buffer = Buffer.alloc(size);
    let read = 0;
    while (read < size) {
      const n = readSync(fd, buffer, read, size - read, read);
      if (!n) break;
      read += n;
    }
    return buffer.subarray(0, read);
  } finally {
    closeSync(fd);
  }
}

/** The newest glibc an ELF file requires; null for a file that is not one, or requires none. */
export function requiredGlibc(path) {
  return newestGlibc(elfVersionNeeds(readFile(path)));
}

/** True when the file starts with the ELF magic: only four bytes are read. */
function isElf(path) {
  const fd = openSync(path, 'r');
  try {
    const head = Buffer.alloc(4);
    return readSync(fd, head, 0, 4, 0) === 4 && head.readUInt32BE(0) === 0x7f454c46;
  } finally {
    closeSync(fd);
  }
}

/**
 * Every ELF file under `root`, links not followed: the native modules, the
 * shipped Node, Electron and its libraries, the speech engine. Any of them
 * that needs a newer glibc breaks the package on the machines it promises.
 */
export function elfFilesUnder(root) {
  const found = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && isElf(path)) found.push(path);
    }
  };
  if (lstatSync(root, { throwIfNoEntry: false })?.isDirectory()) walk(root);
  return found;
}

/**
 * What a from-source rebuild leaves in `build/Release` that ships, per module.
 * node-gyp also writes its objects, a Makefile and, for better-sqlite3, a
 * `test_extension.node` that is a SQLite extension, not a Node addon: loading
 * it fails ("did not self-register") and nothing in Timon needs it.
 */
export const LINUX_NATIVE_ARTEFACTS = Object.freeze({
  'better-sqlite3': Object.freeze(['better_sqlite3.node']),
  'node-pty': Object.freeze(['pty.node']),
});

/**
 * Reduces a rebuilt module's `build/` to the artefacts that ship, and returns
 * them. Throws when one is missing: a rebuild that "succeeded" without its
 * addon is the silent failure this whole file exists to stop.
 */
export function pruneLinuxBuild(moduleDir, moduleName) {
  const keep = LINUX_NATIVE_ARTEFACTS[moduleName];
  if (!keep) throw new Error(`${moduleName}: no Linux native artefact declared in LINUX_NATIVE_ARTEFACTS`);
  const build = join(moduleDir, 'build');
  const release = join(build, 'Release');
  const missing = keep.filter((name) => !lstatSync(join(release, name), { throwIfNoEntry: false })?.isFile());
  if (missing.length) throw new Error(`${moduleName}: the rebuild left no ${missing.join(', ')} under ${release}`);
  for (const entry of readdirSync(build)) {
    if (entry !== 'Release') rmSync(join(build, entry), { recursive: true, force: true });
  }
  for (const entry of readdirSync(release)) {
    if (!keep.includes(entry)) rmSync(join(release, entry), { recursive: true, force: true });
  }
  return keep.map((name) => join(release, name));
}

/**
 * The natives a Linux package cannot do without, under `resources/`: the
 * daemon's database driver, the terminal (TIM-0162: the 0.1.9 one loaded on no
 * system older than its build machine), the app's own database driver.
 */
export const LINUX_PACKAGE_NATIVES = Object.freeze([
  join('orchestrator', 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node'),
  join('orchestrator', 'node_modules', 'node-pty', 'build', 'Release', 'pty.node'),
  join('app', 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node'),
]);

/** The files among `paths` that require a glibc newer than `floor`, with that version. */
export function glibcOffenders(paths, floor = GLIBC_FLOOR, required = requiredGlibc) {
  return paths
    .map((file) => ({ file, version: required(file) }))
    .filter(({ version }) => version !== null && compareGlibc(version, floor) > 0);
}

/** Refuses a set of shipped binaries when one needs a glibc above the floor. */
export function assertGlibcFloor(paths, floor = GLIBC_FLOOR, required = requiredGlibc) {
  const offenders = glibcOffenders(paths, floor, required);
  if (offenders.length) {
    throw new Error(`these binaries need a glibc newer than ${floor}, the floor the Linux package promises — `
      + `rebuild them in ${NATIVE_BUILD_IMAGES.x64.split('@')[0]}:\n`
      + offenders.map(({ file, version }) => `  ${file}: GLIBC_${version}`).join('\n'));
  }
  return paths.length;
}
