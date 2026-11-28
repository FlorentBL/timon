import { dirname, join, relative } from 'node:path';
import { writePackagedCli } from '../../orchestrator/src/host/packaged-cli.mjs';
import { Arch } from 'builder-util';
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from 'node:fs';
// Ships with electron-builder, and these hooks only ever run while
// electron-builder runs: resolution is guaranteed at the only moment it counts,
// so this stays out of package.json rather than pinning a second copy.
import { extractFile, listPackage } from '@electron/asar';
import { flipFuses, FuseVersion, FuseV1Options } from '@electron/fuses';
import { prepareDaemonRelease, releaseDir, releaseKeys } from './prepare-daemon-release.mjs';
import { verifyRelease } from './release-integrity.mjs';
import { checkMacSignature, describeSignature } from './mac-signature.mjs';
import { BUILD_INFO_FILE, assertPackagedBuildInfo, readBuildInfo } from './build-info.mjs';
import { nodeRuntimeSpec } from './fetch-node.mjs';
import { assertPackagedShellLocales } from './shell-locales.mjs';
import { LINUX_PACKAGE_NATIVES, assertGlibcFloor, elfFilesUnder } from './native-linux.mjs';
import { execFileSync } from 'node:child_process';

// Also runs when electron-builder is invoked directly instead of npm run dist.
export async function beforePack(context) {
  if (context.electronPlatformName !== process.platform) throw new Error('Build Timon on the target OS: native dependencies cannot be cross-built');
  const nativeArch = process.arch === 'arm' ? 'armv7l' : process.arch;
  if (Arch[context.arch] !== nativeArch) throw new Error('Build Timon on the target CPU architecture');
  await prepareDaemonRelease();
}
export function runtimeFuses(platform) {
  return {
    version: FuseVersion.V1,
    // Off since the daemon, the CLI/MCP servers and the Next app run on the
    // Node the package ships (resources/node, 0.1.6): the app's executable is
    // no longer a generic JavaScript interpreter carrying the identity macOS
    // and Windows granted it (microphone, camera, firewall). Only the sources
    // still run Electron as Node (TODO #764).
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: platform === 'darwin' || platform === 'win32',
    // Flipping a fuse rewrites Electron Framework and voids the ad-hoc
    // signature it shipped with. On a Mac without a Developer ID identity
    // electron-builder skips signing, and Apple Silicon kills an app whose
    // signature does not match at launch (SIGKILL, Code Signature Invalid).
    // Re-signing ad-hoc here is harmless when a real identity signs afterwards.
    resetAdHocDarwinSignature: platform === 'darwin',
  };
}
/**
 * The shell reads `release-public-key.pem` from `app.getAppPath()` on its very
 * first line (`src/main.ts`), so the file must sit INSIDE `app.asar` — the
 * `OnlyLoadAppFromAsar` fuse is what makes that key trustworthy.
 *
 * It got there through a fileset entry, and electron-builder resolves a
 * fileset `from` as a base DIRECTORY: pointing it at a file drops the entry
 * without a word. The archive shipped without the key and every packaged
 * client died with `ENOENT … release-public-key.pem`, while the YAML read
 * perfectly and every test on it passed. Only the archive proves anything.
 */
export function assertPackagedPublicKey(resources, expectedPem) {
  const archive = join(resources, 'app.asar');
  let packaged;
  try {
    packaged = extractFile(archive, 'release-public-key.pem').toString('utf8');
  } catch (cause) {
    throw new Error(`No release-public-key.pem in ${archive}: the fileset entry of electron-builder.yml did not embed it, and the packaged shell reads it at startup (src/main.ts)`, { cause });
  }
  if (packaged.trim() !== expectedPem.trim()) throw new Error(`The release-public-key.pem embedded in ${archive} is not the key of this release`);
}
/**
 * The shell verifies the daemon in a worker (TODO #439, `src/release-check.ts`),
 * which loads both scripts from app.asar: a fileset that drops one fails every
 * packaged start with a missing module, so the pack fails first.
 */
export const RELEASE_CHECK_SCRIPTS = ['scripts/release-integrity-worker.mjs', 'scripts/release-integrity.mjs'];
export function assertPackagedReleaseCheck(resources) {
  const archive = join(resources, 'app.asar');
  for (const name of RELEASE_CHECK_SCRIPTS) {
    try {
      extractFile(archive, name);
    } catch (cause) {
      throw new Error(`No ${name} in ${archive}: the fileset of electron-builder.yml did not embed it, and the packaged shell loads it at startup (src/release-check.ts)`, { cause });
    }
  }
}
/**
 * The attributions of the speech models (TODO #550): the client ships none,
 * but the Apache-2.0 licence of Cohere Transcribe asks for its NOTICE with
 * the software that redistributes it, so the file travels as an extraResource.
 * Compared to the checked-in text: a stale or truncated copy is no NOTICE.
 */
export const THIRD_PARTY_NOTICES = 'THIRD-PARTY-MODELS.md';
export function assertPackagedThirdPartyNotices(resources, expected) {
  const file = join(resources, THIRD_PARTY_NOTICES);
  if (!existsSync(file)) throw new Error(`No ${THIRD_PARTY_NOTICES} in ${resources}: the extraResources entry of electron-builder.yml did not ship it`);
  if (!readFileSync(file).equals(expected)) throw new Error(`The ${THIRD_PARTY_NOTICES} shipped in ${resources} is not the one of this checkout`);
}
/** A speech model file: downloaded on demand into the home, never shipped (≈ 670 MB). */
const MODEL_FILE = /\.onnx$/i;
const RUNTIME_LIBRARY = /^(lib)?onnxruntime[.\d]*\.(so|dylib|dll)$/;
const C_API_LIBRARY = /^(lib)?sherpa-onnx-c-api\.(so|dylib|dll)$/;

function filesUnder(dir) {
  return readdirSync(dir, { withFileTypes: true, recursive: true }).filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name));
}

/**
 * The dictation engine of the package (TODO #443): exactly the sherpa-onnx
 * package of the target OS and CPU, unpacked from app.asar with the libraries
 * the addon loads, and no model. `expected` is `sherpaPackageName()` of the
 * target (null where none is published: then none may travel).
 *
 * The YAML says `asarUnpack: node_modules/sherpa-onnx-*`, but only the archive
 * proves where the files landed: npm installs the build machine's package
 * only, and a package installed by hand for another OS would ship too.
 */
export function assertPackagedSpeechEngine(resources, expected) {
  const unpacked = join(resources, 'app.asar.unpacked', 'node_modules');
  const found = existsSync(unpacked) ? readdirSync(unpacked).filter((name) => name.startsWith('sherpa-onnx')).sort() : [];
  const archive = join(resources, 'app.asar');
  const archived = listPackage(archive, { isPack: false });
  if (archived.some((entry) => MODEL_FILE.test(entry))) throw new Error(`${archive} carries a speech model: models are downloaded on demand, never shipped`);
  if (!expected) {
    if (found.length) throw new Error(`No dictation engine is published for this target, yet the package carries ${found.join(', ')}`);
    return;
  }
  if (found.length !== 1 || found[0] !== expected) {
    throw new Error(`The package must carry ${expected} unpacked from app.asar, and only it; found ${found.length ? found.join(', ') : 'none'}. Install the desktop dependencies on the target machine (npm ci) before packaging`);
  }
  const dir = join(unpacked, expected);
  const files = filesUnder(dir);
  const names = files.map((file) => file.slice(dir.length + 1));
  if (!names.includes('sherpa-onnx.node')) throw new Error(`${dir} has no sherpa-onnx.node`);
  if (!names.some((name) => RUNTIME_LIBRARY.test(name))) throw new Error(`${dir} has no onnxruntime library: the addon cannot load`);
  if (!names.some((name) => C_API_LIBRARY.test(name))) throw new Error(`${dir} has no sherpa-onnx C API library: the addon cannot load`);
  const model = files.find((file) => MODEL_FILE.test(file));
  if (model) throw new Error(`${model} is a speech model: models are downloaded on demand, never shipped`);
}
/**
 * The daemon, its app and the CLI run on `resources/node/node[.exe]`: a pack
 * without it, or with another version, starts nothing. Run when the pack
 * targets the build machine (builds are native), checked by executing it.
 */
export function assertPackagedNode(resources, platform, spec = nodeRuntimeSpec()) {
  const node = join(resources, 'node', platform === 'win32' ? 'node.exe' : 'node');
  if (!existsSync(node)) throw new Error(`${node} is missing: the packaged daemon would not start (prepare:deps fetches it)`);
  if (platform !== 'win32' && (statSync(node).mode & 0o111) === 0) throw new Error(`${node} is not executable`);
  if (platform !== process.platform) return;
  const version = execFileSync(node, ['-p', 'process.versions.node'], { encoding: 'utf8' }).trim();
  if (version !== spec.version) throw new Error(`${node} is Node ${version}, expected ${spec.version}`);
}

/**
 * A Linux package carries the mission launcher (`orchestrator/native/
 * timon-fence`, signed with the daemon): without it every mission would run
 * unfenced. Executed when the pack targets the build machine.
 */
export function assertPackagedFence(resources, platform) {
  if (platform !== 'linux') return;
  const fence = join(resources, 'orchestrator', 'native', 'timon-fence');
  if (!existsSync(fence)) throw new Error(`${fence} is missing: Linux missions would run unfenced (prepare-daemon-release builds it)`);
  if ((statSync(fence).mode & 0o111) === 0) throw new Error(`${fence} is not executable`);
  if (platform !== process.platform) return;
  const version = execFileSync(fence, ['--version'], { encoding: 'utf8' }).trim();
  if (!version.startsWith('timon-fence ')) throw new Error(`${fence} is not the mission launcher (answered ${JSON.stringify(version)})`);
}

/**
 * A Linux package carries the natives it cannot run without, and nothing in
 * it needs a glibc above the floor the requirements promise (TIM-0162: the
 * 0.1.9 terminal needed glibc 2.42 and loaded on no system older than the
 * build machine). Every ELF under the unpacked app is read, the speech engine
 * and Electron's own libraries included: whatever ships must load there.
 */
export function assertPackagedLinuxNatives(app, resources, platform) {
  if (platform !== 'linux') return;
  for (const native of LINUX_PACKAGE_NATIVES) {
    if (!existsSync(join(resources, native))) {
      throw new Error(`${join(resources, native)} is missing: prepare:deps rebuilds it in the native build image`);
    }
  }
  const checked = assertGlibcFloor(elfFilesUnder(app));
  console.log(`[release] ${checked} Linux binaries checked against the glibc floor`);
}

/**
 * The trees `prepare:deps` staged in `build-resources/`, and where each lands
 * under `resources/`: the app's standalone output and the daemon's rebuilt
 * dependencies. Two entries carry the app because electron-builder 26 drops
 * the root `node_modules` of a copy source (see electron-builder.yml).
 */
export const STAGED_TREES = Object.freeze([
  Object.freeze({ staged: 'app', packaged: 'app' }),
  Object.freeze({ staged: join('orchestrator', 'node_modules'), packaged: join('orchestrator', 'node_modules') }),
]);

/** Names electron-builder's directory walk never copies (builder-util `walk`). */
const NEVER_COPIED = new Set(['.DS_Store', '.gitkeep']);

/** Every file and link of `source` (relative paths) that `copy` lacks. Links are not followed. */
export function missingFromCopy(source, copy) {
  return readdirSync(source, { withFileTypes: true, recursive: true })
    .filter((entry) => !entry.isDirectory() && !NEVER_COPIED.has(entry.name))
    .map((entry) => relative(source, join(entry.parentPath, entry.name)))
    .filter((file) => !lstatSync(join(copy, file), { throwIfNoEntry: false }));
}

/**
 * Every file of the staged trees reached the package. Their files are not in
 * the signed daemon manifest, so nothing else notices a filter that drops
 * some: 0.1.12-rc.1 packed `resources/app` without one dependency, on every
 * OS, and only the Linux check of `better_sqlite3.node` saw it.
 */
export function assertPackagedStagedTrees(resources, buildResources = dirname(releaseDir)) {
  for (const { staged, packaged } of STAGED_TREES) {
    const source = join(buildResources, staged);
    if (!existsSync(source)) throw new Error(`${source} is missing: run prepare:deps before packaging`);
    const missing = missingFromCopy(source, join(resources, packaged));
    if (missing.length) {
      throw new Error(`${missing.length} file(s) of ${source} did not reach ${join(resources, packaged)}, `
        + `an electron-builder file filter dropped them (extraResources of electron-builder.yml): ${missing.slice(0, 5).join(', ')}`);
    }
  }
}

export async function afterPack(context) {
  const name = context.packager.appInfo.productFilename;
  const platform = context.electronPlatformName;
  const app = platform === 'darwin' ? join(context.appOutDir, `${name}.app`) : context.appOutDir;
  const resources = platform === 'darwin' ? join(app, 'Contents/Resources') : join(app, 'resources');
  writePackagedCli(app, platform);
  const installed = join(resources, 'orchestrator');
  const keys = releaseKeys();
  verifyRelease(installed, keys.publicKey);
  if (!readFileSync(join(installed, 'release-manifest.json')).equals(readFileSync(join(releaseDir, 'release-manifest.json')))) {
    throw new Error('Packaged daemon differs from the prepared release');
  }
  assertPackagedBuildInfo(installed, readBuildInfo(join(releaseDir, BUILD_INFO_FILE)));
  // Before flipping the fuses: never mutate the binary of a run about to fail.
  assertPackagedPublicKey(resources, keys.publicKey);
  assertPackagedReleaseCheck(resources);
  assertPackagedNode(resources, platform);
  assertPackagedFence(resources, platform);
  assertPackagedStagedTrees(resources);
  assertPackagedLinuxNatives(app, resources, platform);
  assertPackagedThirdPartyNotices(resources, readFileSync(new URL(`../${THIRD_PARTY_NOTICES}`, import.meta.url)));
  assertPackagedShellLocales(resources);
  // Built by `npm run dist` before electron-builder runs: the shell's own table.
  const { sherpaPackageName } = await import('../dist/speech-paths.js');
  assertPackagedSpeechEngine(resources, sherpaPackageName(platform, Arch[context.arch]));
  // Run before OS signing. Linux has no embedded ASAR validation; the signed
  // daemon inventory works there too, with the documented local-patch limit.
  const binary = platform === 'darwin' ? app : join(app, platform === 'win32' ? `${name}.exe` : context.packager.executableName);
  await flipFuses(binary, runtimeFuses(platform));
  // electron-builder signs over this when a Developer ID identity exists, and
  // skips its afterSign hook when none does: the unsigned path is checked here.
  if (platform === 'darwin') console.log(`[release] macOS signature after fuses: ${describeSignature(checkMacSignature(app))}`);
}
