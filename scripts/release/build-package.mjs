#!/usr/bin/env node
/**
 * Builds the Timon desktop package for the CURRENT OS from a clean checkout,
 * and leaves in one directory what a publication needs: the installers, their
 * SHA-256 sums and a `build-summary.json`.
 *
 *   node scripts/release/build-package.mjs --version <x.y.z[-rc.N|-nightly.YYYYMMDD]> --channel <beta|stable>
 *        [--expires <ISO date>] [--no-expiry] [--output <dir>] [--checkout <dir>]
 *        [--key-dir <dir>] [--keep-work] [--allow-local] [--dry-run]
 *
 * Meant for a CI runner (ubuntu-latest, macos-latest, windows-latest), one job
 * per OS: packages are never cross-built, since the native modules
 * (better-sqlite3, node-pty, sherpa-onnx) must be compiled on the system they
 * ship to.
 *
 * What it does, in order:
 *  1. checks the request: an rc must be strictly above the checkout's version
 *     (an installed base reads an equal or older version as no update, and the
 *     rollback path only fires on a difference); a final version must equal it
 *     (a final version is a version bump, merged before the build); a nightly
 *     build (nightly.yml, never published) follows the rc rule;
 *  2. writes the version into orchestrator/, app/ and desktop/package.json of
 *     the checkout, and `orchestrator/build-info.json` (channel, expiry). No
 *     commit, no tag: the checkout is a throwaway one;
 *  3. `npm ci --include=dev` in the three packages (a shell that inherited
 *     NODE_ENV=production would skip typescript and electron), the web app
 *     build, the desktop build, the native dependencies, then electron-builder
 *     for this OS. The daemon is compiled and signed by the beforePack hook
 *     (desktop/scripts/prepare-daemon-release.mjs);
 *  4. on macOS, the packaged .app's code signature is verified: a broken one is
 *     killed at launch on Apple Silicon;
 *  5. the installers are moved to `<output>/<version>/<os>/`, next to
 *     `SHA256SUMS` and `build-summary.json`.
 *
 * Signing. The daemon inside the package is always signed with the Ed25519
 * release key pair, which the packaged shell verifies at every start: give it
 * as files (TIMON_RELEASE_PRIVATE_KEY_FILE and TIMON_RELEASE_PUBLIC_KEY_FILE,
 * or --key-dir) or as PEM text (TIMON_RELEASE_PRIVATE_KEY and
 * TIMON_RELEASE_PUBLIC_KEY, written to a private temporary folder outside the
 * checkout and removed at the end). The key content is never printed.
 * Operating-system code signing is optional: without CSC_LINK (macOS and
 * Windows) or WIN_CSC_LINK (Windows), electron-builder's identity discovery is
 * turned off (CSC_IDENTITY_AUTO_DISCOVERY=false) and the macOS app keeps the
 * ad-hoc signature the afterPack hook gives it. When those variables are set,
 * they reach electron-builder untouched, with the rest of its own variables
 * (CSC_KEY_PASSWORD, APPLE_ID, APPLE_TEAM_ID…).
 *
 * It rewrites package.json files and runs `npm ci` in the checkout it builds:
 * outside CI (CI=true), it refuses to run unless --allow-local says the
 * checkout is a throwaway one, never the one an installed daemon runs from.
 *
 * Pure node, no dependency: `git` and `npm` are the programs spawned, under the
 * same name on every OS (npm through npm.cmd on Windows); `codesign` too, on
 * macOS only, through desktop/scripts/mac-signature.mjs.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { BUILD_INFO_FILE, PACKAGE_CHANNELS, createBuildInfo, writeBuildInfo } from '../../desktop/scripts/build-info.mjs';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const PACKAGES = ['orchestrator', 'app', 'desktop'];
export const DEFAULT_OUTPUT = 'dist-release';
export const SUMS_FILE = 'SHA256SUMS';
export const SUMMARY_FILE = 'build-summary.json';
export const SUMMARY_SCHEMA = 1;
/** The OS names of a release: build-all's manifest and the publication use them. */
export const OS_NAMES = { linux: 'linux', darwin: 'mac', win32: 'windows' };
/** Installer formats per OS, by extension; the format names are the update manifest's. */
export const INSTALLER_FORMATS = {
  linux: [['.appimage', 'appimage'], ['.deb', 'deb']],
  mac: [['.dmg', 'dmg'], ['.pkg', 'pkg']],
  windows: [['.exe', 'nsis']],
};
export const KEY_FILES = { privateKey: 'dev-release.key.pem', publicKey: 'dev-release.pub.pem' };
export const KEY_FILE_ENV = { privateKey: 'TIMON_RELEASE_PRIVATE_KEY_FILE', publicKey: 'TIMON_RELEASE_PUBLIC_KEY_FILE' };
export const KEY_PEM_ENV = { privateKey: 'TIMON_RELEASE_PRIVATE_KEY', publicKey: 'TIMON_RELEASE_PUBLIC_KEY' };
const STEP_TIMEOUT = 60 * 60_000;
// A nightly build is numbered by its UTC date (YYYYMMDD), so it never starts with 0.
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(rc)\.([1-9]\d*)|-(nightly)\.([1-9]\d{7}))?$/;
const USAGE = `Usage: node scripts/release/build-package.mjs --version <x.y.z[-rc.N|-nightly.YYYYMMDD]> --channel <${PACKAGE_CHANNELS.join('|')}> [--expires <ISO date>] [--no-expiry] [--output <dir>] [--checkout <dir>] [--key-dir <dir>] [--keep-work] [--allow-local] [--dry-run]`;

export function parseArgs(argv) {
  const opts = { version: null, channel: null, expires: null, noExpiry: false, output: null, checkout: null, keyDir: null, keepWork: false, allowLocal: false, dryRun: false };
  const valued = { '--version': 'version', '--channel': 'channel', '--expires': 'expires', '--output': 'output', '--checkout': 'checkout', '--key-dir': 'keyDir' };
  const flags = { '--no-expiry': 'noExpiry', '--keep-work': 'keepWork', '--allow-local': 'allowLocal', '--dry-run': 'dryRun' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (Object.hasOwn(flags, arg)) opts[flags[arg]] = true;
    else if (Object.hasOwn(valued, arg)) {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new Error(`${arg} needs a value\n${USAGE}`);
      opts[valued[arg]] = value;
    } else throw new Error(`unexpected argument ${arg}\n${USAGE}`);
  }
  if (!opts.version) throw new Error(`--version is required\n${USAGE}`);
  if (!VERSION.test(opts.version)) throw new Error(`"${opts.version}" is not a release version (x.y.z, x.y.z-rc.N with N >= 1, or x.y.z-nightly.YYYYMMDD)`);
  // Required rather than defaulted: a workflow states the channel it ships to.
  if (!opts.channel) throw new Error(`--channel is required\n${USAGE}`);
  if (!PACKAGE_CHANNELS.includes(opts.channel)) throw new Error(`--channel must be one of ${PACKAGE_CHANNELS.join(', ')} (got "${opts.channel}")`);
  return opts;
}

function versionParts(version) {
  const m = VERSION.exec(version);
  if (!m) throw new Error(`not a release version: ${version}`);
  const pre = m[4] ? { tag: m[4], n: Number(m[5]) } : m[6] ? { tag: m[6], n: Number(m[7]) } : null;
  return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre };
}

/** 'final', 'rc' or 'nightly': what a version is, before any comparison. */
export function versionKind(version) {
  return versionParts(version).pre?.tag ?? 'final';
}

/**
 * Sign of `a - b` for x.y.z, x.y.z-rc.N and x.y.z-nightly.D, in SemVer order: a
 * pre-release comes before its final version, and `nightly` before `rc`
 * (identifiers compare in ASCII order).
 */
export function compareRelease(a, b) {
  const left = versionParts(a);
  const right = versionParts(b);
  for (let i = 0; i < 3; i++) if (left.core[i] !== right.core[i]) return left.core[i] < right.core[i] ? -1 : 1;
  if (!left.pre && !right.pre) return 0;
  if (!left.pre) return 1;
  if (!right.pre) return -1;
  if (left.pre.tag !== right.pre.tag) return left.pre.tag < right.pre.tag ? -1 : 1;
  if (left.pre.n === right.pre.n) return 0;
  return left.pre.n < right.pre.n ? -1 : 1;
}

/**
 * 'rc', 'nightly' or 'final', or throws. A pre-release must sort strictly
 * above the version the checkout carries; a final version must be exactly that
 * version, which only a merged version bump puts there.
 */
export function releaseKind(version, current) {
  const kind = versionKind(version);
  if (kind !== 'final') {
    if (compareRelease(version, current) <= 0) throw new Error(`${version} is not above the checkout's version ${current}: an installed ${current} would not take it as an update`);
    return kind;
  }
  if (version !== current) throw new Error(`final version ${version} differs from the checkout's version ${current}: merge the version bump first, then build`);
  return 'final';
}

/** Rewrites the "version" field only, by regex: the diff stays one line per file. */
export function setVersion(source, version) {
  const re = /("version":\s*")[^"]+(")/;
  if (!re.test(source)) throw new Error('no "version" field');
  return source.replace(re, `$1${version}$2`);
}

export function versionOf(source) {
  const m = source.match(/"version":\s*"([^"]+)"/);
  if (!m) throw new Error('no "version" field');
  return m[1];
}

/** Lines of `git status --porcelain` other than the three package.json this script rewrites. */
export function foreignChanges(porcelain) {
  const allowed = new Set(PACKAGES.map((pkg) => `${pkg}/package.json`));
  return porcelain.split('\n').filter((line) => line.trim() && !allowed.has(line.slice(3).trim()));
}

export function osName(platform) {
  const name = OS_NAMES[platform];
  if (!name) throw new Error(`no desktop package for platform ${platform}`);
  return name;
}

/** electron-builder's flag for this OS. There is deliberately no way to ask for another one. */
export function distTarget(platform) {
  const flag = { linux: '--linux', darwin: '--mac', win32: '--win' }[platform];
  if (!flag) throw new Error(`no desktop package for platform ${platform}`);
  return flag;
}

/**
 * Where everything lands. `work` is electron-builder's own output (unpacked
 * apps, blockmaps, debug files); only the installers move on to `dir`.
 */
export function outputPaths({ checkout, output, version, os, cwd = process.cwd() }) {
  const base = output ? resolve(cwd, output) : join(checkout, DEFAULT_OUTPUT);
  const versionDir = join(base, version);
  return { base, versionDir, dir: join(versionDir, os), work: join(versionDir, `.work-${os}`) };
}

export function isInside(child, parent) {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * Where the Ed25519 release keys come from: --key-dir, then the file
 * variables, then the PEM variables. null when none is given: a dry run says
 * so, a real run stops. Never a default folder in a home: a CI runner has none.
 */
export function resolveKeys({ keyDir, env }) {
  if (keyDir) {
    const dir = resolve(keyDir);
    return { source: '--key-dir', privateKey: join(dir, KEY_FILES.privateKey), publicKey: join(dir, KEY_FILES.publicKey) };
  }
  const pair = (names) => [env[names.privateKey], env[names.publicKey]];
  const [privFile, pubFile] = pair(KEY_FILE_ENV);
  if (privFile || pubFile) {
    if (!privFile || !pubFile) throw new Error(`${KEY_FILE_ENV.privateKey} and ${KEY_FILE_ENV.publicKey} go together: set both or neither`);
    return { source: 'key file variables', privateKey: resolve(privFile), publicKey: resolve(pubFile) };
  }
  const [privPem, pubPem] = pair(KEY_PEM_ENV);
  if (privPem || pubPem) {
    if (!privPem || !pubPem) throw new Error(`${KEY_PEM_ENV.privateKey} and ${KEY_PEM_ENV.publicKey} go together: set both or neither`);
    return { source: 'PEM variables', pem: { privateKey: privPem, publicKey: pubPem } };
  }
  return null;
}

/** A key file under the checkout is one `git add -A` away from being published. */
export function checkKeyLocation(keys, dirs) {
  for (const file of [keys.privateKey, keys.publicKey]) {
    for (const dir of dirs) {
      if (isInside(file, dir)) throw new Error(`release key ${file} lies inside ${dir}; keep the pair outside the checkout`);
    }
  }
}

/** Writes PEM text to a private folder outside any checkout; returns the files and how to remove them. */
export function materializeKeys(pem, base = tmpdir()) {
  const dir = mkdtempSync(join(base, 'timon-release-keys-'));
  const privateKey = join(dir, KEY_FILES.privateKey);
  const publicKey = join(dir, KEY_FILES.publicKey);
  // A secret pasted into a CI variable often loses its final newline, which a
  // PEM parser tolerates; it keeps the newlines inside, which matter.
  writeFileSync(privateKey, pem.privateKey.endsWith('\n') ? pem.privateKey : pem.privateKey + '\n', { mode: 0o600 });
  writeFileSync(publicKey, pem.publicKey.endsWith('\n') ? pem.publicKey : pem.publicKey + '\n', { mode: 0o600 });
  return { privateKey, publicKey, dispose: () => rmSync(dir, { recursive: true, force: true }) };
}

/**
 * The environment electron-builder signs with. Without an identity, discovery
 * is off: a runner's keychain must not sign by chance, and the macOS app keeps
 * the ad-hoc signature of the afterPack hook. Values are never returned, only
 * the names that decided.
 */
export function signingEnv(env, platform) {
  const names = { darwin: ['CSC_LINK', 'CSC_NAME'], win32: ['WIN_CSC_LINK', 'CSC_LINK'] }[platform] ?? [];
  const found = names.filter((name) => env[name]);
  if (found.length) return { mode: 'identity', from: found, env: {} };
  return { mode: 'none', from: [], env: { CSC_IDENTITY_AUTO_DISCOVERY: 'false' } };
}

/**
 * The build steps, in order, each with the NODE_ENV it runs under whatever the
 * caller inherited: `development` everywhere except `next build`, which wants
 * `production` (and the standalone output a package ships). `dist` must not
 * see production. Same plan as the maintainers' build scripts.
 */
export function buildPlan({ checkout, platform, keys, work, signing }) {
  const dir = (pkg) => join(checkout, pkg);
  const dev = { NODE_ENV: 'development' };
  return [
    ...PACKAGES.map((pkg) => ({ label: `${pkg}: npm ci --include=dev`, cwd: dir(pkg), args: ['ci', '--include=dev'], env: dev })),
    // TIMON_NEXT_STANDALONE: the package ships the traced standalone output,
    // not app/node_modules (desktop/scripts/prepare-daemon-deps.mjs).
    { label: 'app: npm run build', cwd: dir('app'), args: ['run', 'build'], env: { NODE_ENV: 'production', TIMON_NEXT_STANDALONE: '1' } },
    { label: 'desktop: npm run build', cwd: dir('desktop'), args: ['run', 'build'], env: dev },
    { label: 'desktop: npm run prepare:deps', cwd: dir('desktop'), args: ['run', 'prepare:deps'], env: dev },
    // `--publish never`: on a CI runner electron-builder publishes to GitHub
    // by itself as soon as it finds a token (GH_TOKEN, or a tag build).
    // Publishing is a separate step that reads build-summary.json, so this
    // one only ever builds.
    {
      label: `desktop: npm run dist -- ${distTarget(platform)} --publish never`,
      cwd: dir('desktop'),
      args: ['run', 'dist', '--', distTarget(platform), '--publish', 'never', `--config.directories.output=${work}`],
      env: { ...dev, ...signing.env, [KEY_FILE_ENV.privateKey]: keys.privateKey, [KEY_FILE_ENV.publicKey]: keys.publicKey },
    },
  ];
}

/** The installers of `os` among the names electron-builder left, with their format. */
export function selectInstallers(names, os) {
  const formats = INSTALLER_FORMATS[os];
  if (!formats) throw new Error(`unknown OS ${os}`);
  return names
    .map((name) => ({ name, format: formats.find(([ext]) => name.toLowerCase().endsWith(ext))?.[1] }))
    .filter((entry) => entry.format)
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

export async function hashFile(file) {
  const stat = lstatSync(file);
  if (!stat.isFile()) throw new Error(`not a regular file: ${file}`);
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return { name: basename(file), size: stat.size, sha256: hash.digest('hex') };
}

/** `sha256sum` format (two spaces), sorted, LF: `sha256sum -c` and `shasum -a 256 -c` read it. */
export function checksumsText(files) {
  return [...files].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)).map((file) => `${file.sha256}  ${file.name}\n`).join('');
}

/** The record the publication reads: what was built, from which commit, for which system. */
export function buildSummary({ version, kind, buildInfo, os, arch, commit, files, signing, node = process.version }) {
  return {
    schema: SUMMARY_SCHEMA,
    version,
    kind,
    channel: buildInfo.channel,
    builtAt: buildInfo.builtAt,
    expiresAt: buildInfo.expiresAt,
    os,
    arch,
    commit,
    node,
    signing,
    checksums: SUMS_FILE,
    files: files.map(({ name, format, size, sha256 }) => ({ name, format, size, sha256 })),
  };
}

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._+-]*$/;

/** Throws unless `value` is a build summary this script could have written. */
export function validateBuildSummary(value) {
  const fail = (why) => { throw new Error(`${SUMMARY_FILE}: ${why}`); };
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('not a JSON object');
  if (value.schema !== SUMMARY_SCHEMA) fail(`unknown schema ${value.schema}`);
  if (typeof value.version !== 'string' || !VERSION.test(value.version)) fail('invalid version');
  if (value.kind !== versionKind(value.version)) fail('kind does not match the version');
  if (!PACKAGE_CHANNELS.includes(value.channel)) fail('invalid channel');
  if (!Object.values(OS_NAMES).includes(value.os)) fail('invalid os');
  if (typeof value.arch !== 'string' || !/^[a-z0-9]+$/.test(value.arch)) fail('invalid arch');
  if (typeof value.commit !== 'string' || !/^[a-f0-9]{40}$/.test(value.commit)) fail('commit must be a full sha');
  if (value.checksums !== SUMS_FILE) fail('invalid checksums file name');
  if (!Array.isArray(value.files) || !value.files.length) fail('no installer');
  const formats = INSTALLER_FORMATS[value.os].map(([, format]) => format);
  const seen = new Set();
  for (const file of value.files) {
    if (typeof file?.name !== 'string' || !SAFE_NAME.test(file.name) || seen.has(file.name)) fail(`invalid file name ${JSON.stringify(file?.name)}`);
    seen.add(file.name);
    if (!formats.includes(file.format)) fail(`${file.name}: format ${file.format} is not one of ${value.os}`);
    if (!Number.isSafeInteger(file.size) || file.size < 1) fail(`${file.name}: invalid size`);
    if (typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(file.sha256)) fail(`${file.name}: invalid sha256`);
  }
  return value;
}

/** Writes SHA256SUMS and build-summary.json into `dir`; returns their paths. */
export function writeOutputs(dir, summary) {
  validateBuildSummary(summary);
  const sums = join(dir, SUMS_FILE);
  const file = join(dir, SUMMARY_FILE);
  writeFileSync(sums, checksumsText(summary.files));
  writeFileSync(file, JSON.stringify(summary, null, 2) + '\n');
  return { sums, summary: file };
}

/** The .app bundles electron-builder leaves in `<output>/mac*`: the dmg and pkg are made from them. */
export function packagedMacApps(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^mac(-|$)/.test(entry.name))
    .flatMap((entry) => readdirSync(join(dir, entry.name), { withFileTypes: true })
      .filter((app) => app.isDirectory() && app.name.endsWith('.app'))
      .map((app) => join(dir, entry.name, app.name)))
    .sort();
}

// ---------------------------------------------------------------------------

function git(args, cwd) {
  const run = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 120_000 });
  if (run.error) throw new Error(`git ${args[0]}: ${run.error.message}`);
  if (run.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${run.stderr.trim()}`);
  return run.stdout;
}

/**
 * The environment of a build step: the caller's, without the release key
 * variables (PEM text or file names), plus the step's own. Every dependency's
 * install script runs under it, and a variable is what such a script reads
 * first; the one step that signs gets the key files from its plan.
 */
export function stepEnv(env, step) {
  const clean = { ...env };
  for (const name of [...Object.values(KEY_PEM_ENV), ...Object.values(KEY_FILE_ENV)]) delete clean[name];
  return { ...clean, ...step.env };
}

export function runBuildStep(step, platform = process.platform) {
  // Windows ships npm as npm.cmd, which Node only spawns through a shell since
  // CVE-2024-27980. Each argument is quoted to keep paths with spaces whole.
  const win = platform === 'win32';
  // cmd.exe expands percent variables even inside quotes: refuse an ambiguous
  // path rather than let an output directory become shell code.
  if (win && step.args.some((arg) => /["%!^&|<>\r\n]/.test(arg))) throw new Error(`${step.label}: unsafe Windows build argument`);
  const args = win ? step.args.map((arg) => `"${arg}"`) : step.args;
  const run = spawnSync(win ? 'npm.cmd' : 'npm', args, { cwd: step.cwd, env: stepEnv(process.env, step), stdio: 'inherit', shell: win, timeout: STEP_TIMEOUT, killSignal: 'SIGKILL' });
  if (run.error) throw new Error(`${step.label}: ${run.error.message}`);
  if (run.status !== 0) throw new Error(`${step.label} failed (exit ${run.status ?? run.signal})`);
}

/** What is known before anything is written, and what would stop a real run. */
export function inspect(opts, { env = process.env, platform = process.platform, arch = process.arch, cwd = process.cwd() } = {}) {
  const blockers = [];
  const checkout = resolve(cwd, opts.checkout ?? ROOT);
  const os = osName(platform);
  const paths = outputPaths({ checkout, output: opts.output, version: opts.version, os, cwd });
  const commit = git(['rev-parse', 'HEAD'], checkout).trim();
  const current = versionOf(git(['show', `${commit}:orchestrator/package.json`], checkout));
  let kind = null;
  try { kind = releaseKind(opts.version, current); } catch (error) { blockers.push(error.message); }
  // Resolved now: `--no-expiry` on a beta, or a malformed date, must stop the
  // run here and not after an hour of npm ci.
  const buildInfo = createBuildInfo({ channel: opts.channel, expires: opts.expires ?? undefined, noExpiry: opts.noExpiry });
  for (const pkg of PACKAGES) {
    const found = versionOf(git(['show', `${commit}:${pkg}/package.json`], checkout));
    if (found !== current) blockers.push(`${pkg}/package.json is ${found}, orchestrator/package.json is ${current}: the package versions disagree`);
  }
  const foreign = foreignChanges(git(['status', '--porcelain'], checkout));
  if (foreign.length) blockers.push(`the checkout is not clean:\n    ${foreign.join('\n    ')}`);
  if (env.CI !== 'true' && !opts.allowLocal) blockers.push('not on a CI runner (CI=true): pass --allow-local only for a throwaway checkout, never the one a daemon runs from; this run rewrites package.json files and runs npm ci there');
  if (isInside(checkout, paths.base)) blockers.push(`the output ${paths.base} contains the checkout`);
  if (existsSync(paths.dir) && readdirSync(paths.dir).length) blockers.push(`${paths.dir} is not empty: a build never overwrites installers; use another --output`);
  let keys = null;
  try {
    keys = resolveKeys({ keyDir: opts.keyDir, env });
    if (!keys) blockers.push(`no release signing keys: set ${KEY_FILE_ENV.privateKey} and ${KEY_FILE_ENV.publicKey}, or ${KEY_PEM_ENV.privateKey} and ${KEY_PEM_ENV.publicKey}, or pass --key-dir`);
    else if (!keys.pem) {
      checkKeyLocation(keys, [checkout]);
      for (const file of [keys.privateKey, keys.publicKey]) if (!existsSync(file)) blockers.push(`missing key file ${file}`);
    }
  } catch (error) { blockers.push(error.message); }
  const signing = signingEnv(env, platform);
  return { checkout, os, platform, arch, paths, commit, current, kind, buildInfo, keys, signing, blockers };
}

const show = (checkout, path) => (isInside(path, checkout) ? relative(checkout, path) || '.' : path);

/** The plan, as lines: what a dry run prints and what a real run announces. */
export function describe(state, opts) {
  const { checkout, os, platform, arch, paths, commit, current, kind, buildInfo, keys, signing } = state;
  const placeholder = { privateKey: '<private key>', publicKey: '<public key>' };
  const plan = buildPlan({ checkout, platform, keys: placeholder, work: paths.work, signing });
  const lines = [
    `${kind ?? 'refused'} ${opts.version} for ${os} (${platform}-${arch}); checkout ${checkout} at ${commit.slice(0, 12)} (version ${current})`,
    `output    ${paths.dir}`,
    `build     ${BUILD_INFO_FILE}: channel ${buildInfo.channel}, expires ${buildInfo.expiresAt ?? 'never'}${opts.expires || opts.noExpiry ? '' : ' (default: 90 days after the build)'}`,
    `keys      ${keys ? keys.source : 'none'}`,
    `signing   ${signing.mode === 'none' ? `no OS identity: CSC_IDENTITY_AUTO_DISCOVERY=false${platform === 'darwin' ? ', ad-hoc signature' : ''}` : `identity from ${signing.from.join(', ')}`}`,
    `1. version ${opts.version} in ${PACKAGES.map((pkg) => `${pkg}/package.json`).join(', ')}`,
    `2. orchestrator/${BUILD_INFO_FILE}`,
    ...plan.map((step, i) => `${i + 3}. ${step.label}   (cwd ${show(checkout, step.cwd)}, NODE_ENV=${step.env.NODE_ENV}${step.env.TIMON_NEXT_STANDALONE ? ', TIMON_NEXT_STANDALONE=1' : ''})`),
  ];
  let n = plan.length + 3;
  if (platform === 'darwin') lines.push(`${n++}. codesign --verify the packaged .app, then record how it is signed`);
  lines.push(`${n++}. move the ${INSTALLER_FORMATS[os].map(([, format]) => format).join(', ')} installers from ${show(checkout, paths.work)} to ${show(checkout, paths.dir)}`);
  lines.push(`${n++}. ${SUMS_FILE} and ${SUMMARY_FILE} in ${show(checkout, paths.dir)}`);
  if (!opts.keepWork) lines.push(`${n}. remove ${show(checkout, paths.work)}`);
  return lines;
}

export async function main(argv = process.argv.slice(2), context = {}) {
  const opts = parseArgs(argv);
  const state = inspect(opts, context);
  const { checkout, os, platform, arch, paths, commit, kind, buildInfo, signing, blockers } = state;
  for (const line of describe(state, opts)) console.log(opts.dryRun ? `[dry-run] ${line}` : line);
  if (opts.dryRun) {
    if (blockers.length) {
      console.log(`[dry-run] a real run would stop before building:\n  - ${blockers.join('\n  - ')}`);
      process.exitCode = 1;
    } else console.log('[dry-run] nothing blocks a real run');
    return null;
  }
  if (blockers.length) throw new Error(`refused:\n  - ${blockers.join('\n  - ')}`);

  let keys = state.keys;
  let disposeKeys = () => {};
  if (keys.pem) {
    const written = materializeKeys(keys.pem);
    disposeKeys = written.dispose;
    keys = { source: keys.source, privateKey: written.privateKey, publicKey: written.publicKey };
  }
  try {
    // A mismatched or wrong-type pair stops here, before an hour of npm ci.
    const { releaseKeys } = await import(pathToFileURL(join(checkout, 'desktop', 'scripts', 'prepare-daemon-release.mjs')).href);
    releaseKeys({ [KEY_FILE_ENV.privateKey]: keys.privateKey, [KEY_FILE_ENV.publicKey]: keys.publicKey });

    for (const pkg of PACKAGES) {
      const file = join(checkout, pkg, 'package.json');
      const source = readFileSync(file, 'utf8');
      if (versionOf(source) !== opts.version) writeFileSync(file, setVersion(source, opts.version));
    }
    console.log(`wrote ${writeBuildInfo(checkout, buildInfo)}`);
    // The work folder is this script's own scratch space: a stale one would
    // mix an earlier run's installers into this one.
    rmSync(paths.work, { recursive: true, force: true });
    mkdirSync(paths.work, { recursive: true });
    for (const step of buildPlan({ checkout, platform, keys, work: paths.work, signing })) {
      console.log(`\n==> ${step.label}`);
      runBuildStep(step, platform);
    }

    let macSignature = null;
    if (platform === 'darwin') {
      // Imported here: it runs codesign, which only exists on macOS.
      const { checkMacSignature, describeSignature } = await import(pathToFileURL(join(checkout, 'desktop', 'scripts', 'mac-signature.mjs')).href);
      const apps = packagedMacApps(paths.work);
      if (!apps.length) throw new Error(`no packaged .app under ${paths.work}: cannot check its code signature`);
      for (const app of apps) {
        const signature = checkMacSignature(app);
        macSignature = signature.kind;
        console.log(`macOS signature of ${basename(app)}: ${describeSignature(signature)}`);
      }
    }

    const installers = selectInstallers(readdirSync(paths.work), os);
    if (!installers.length) throw new Error(`electron-builder left no installer in ${paths.work}`);
    mkdirSync(paths.dir, { recursive: true });
    const files = [];
    for (const installer of installers) {
      const target = join(paths.dir, installer.name);
      renameSync(join(paths.work, installer.name), target);
      files.push({ ...await hashFile(target), format: installer.format });
    }
    const summary = buildSummary({
      version: opts.version, kind, buildInfo, os, arch, commit, files,
      signing: { mode: signing.mode, ...(macSignature ? { mac: macSignature } : {}) },
    });
    const written = writeOutputs(paths.dir, summary);
    if (!opts.keepWork) rmSync(paths.work, { recursive: true, force: true });

    const after = foreignChanges(git(['status', '--porcelain'], checkout));
    if (after.length) console.log(`\nWARNING: the build changed tracked files of the checkout:\n  ${after.join('\n  ')}`);
    console.log(`\nInstallers (${paths.dir}):`);
    for (const file of files) console.log(`  ${file.sha256}  ${file.name}  (${file.size} bytes)`);
    console.log(`wrote ${written.sums}\nwrote ${written.summary}`);
    return summary;
  } finally {
    disposeKeys();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
