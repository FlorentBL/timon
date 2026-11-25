/**
 * `timon plugin add <file>.tgz` over an installed plugin of the same npm name
 * (issue #133). npm's archive name drops the `@` and `/` of a scope, so the
 * package can only be named from inside the archive: an update must resolve
 * to it, and the very release already installed is refused before npm runs.
 *
 * npm is injected: `install` unpacks the archive (or copies the folder) into
 * `node_modules/` and records it in the plugins root's `package.json`.
 */
import '../test-home.js';
import '../../tests/helpers/paid-license.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import type { NpmRunner } from './install.js';

const { addPlugin, PluginAlreadyInstalledError } = await import('./install.js');
const { buildTarGz, extractTarGz } = await import('./tar-reader.js');

const WORK = mkdtempSync(join(tmpdir(), 'timon-install-archive-'));
let serial = 0;

type Json = Record<string, unknown>;

function readJson(file: string): Json {
  return JSON.parse(readFileSync(file, 'utf8')) as Json;
}

/** npm's double: an archive is unpacked, a folder copied, both recorded as `file:`. */
function fakeNpm(): { run: NpmRunner; calls: string[][] } {
  const calls: string[][] = [];
  const run: NpmRunner = async (args, cwd) => {
    calls.push(args);
    const root = args[args.indexOf('--prefix') + 1] ?? cwd;
    const spec = args[args.length - 1] as string;
    let from = spec;
    if (spec.endsWith('.tgz')) {
      from = mkdtempSync(join(WORK, 'npm-x-'));
      extractTarGz(readFileSync(spec), from);
    }
    const name = readJson(join(from, 'package.json')).name as string;
    const dest = join(root, 'node_modules', name);
    mkdirSync(dirname(dest), { recursive: true });
    rmSync(dest, { recursive: true, force: true });
    cpSync(from, dest, { recursive: true });
    const pkgFile = join(root, 'package.json');
    const pkg = existsSync(pkgFile) ? readJson(pkgFile) : {};
    pkg.dependencies = { ...(pkg.dependencies as Json | undefined), [name]: `file:${relative(root, spec)}` };
    writeFileSync(pkgFile, JSON.stringify(pkg, null, 2));
  };
  return { run, calls };
}

type Fixture = { root: string; config: string; npm: NpmRunner; calls: string[][] };

function fixture(): Fixture {
  const home = mkdtempSync(join(WORK, 'home-'));
  const config = join(home, 'timon.config.json');
  writeFileSync(config, '{}\n');
  const { run, calls } = fakeNpm();
  return { root: join(home, 'plugins'), config, npm: run, calls };
}

/** A plugin folder of `name` at `version`. */
function pluginFolder(name: string, id: string, version: string): string {
  const dir = join(WORK, `src-${++serial}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name, version, type: 'module', main: 'index.js',
    timon: { id, apiVersion: 1, kind: ['behavior'], permissions: [] },
  }, null, 2));
  writeFileSync(join(dir, 'index.js'), 'export function apply() {}\n');
  return dir;
}

/** The `.tgz` `npm pack` makes of the folder, named as npm names it (scope flattened). */
function packed(name: string, id: string, version: string): string {
  const dir = pluginFolder(name, id, version);
  const files = ['package.json', 'index.js'].map((f) => ({ path: `package/${f}`, data: readFileSync(join(dir, f)) }));
  const file = join(WORK, `${name.replace(/^@/, '').replace('/', '-')}-${version}.tgz`);
  writeFileSync(file, buildTarGz(files));
  return file;
}

function installedVersion(f: Fixture, name: string): string {
  return readJson(join(f.root, 'node_modules', name, 'package.json')).version as string;
}

test('a fresh install from a .tgz resolves the package it holds', async () => {
  const f = fixture();
  const n = ++serial;
  const res = await addPlugin(packed(`@acme/fresh-${n}`, `acme-fresh-${n}`, '1.0.0'), f.root, { npm: f.npm, config: f.config });
  assert.equal(res.pkg, `@acme/fresh-${n}`);
  assert.equal(res.id, `acme-fresh-${n}`);
  assert.equal(res.version, '1.0.0');
  assert.equal(f.calls.length, 1);
});

for (const scoped of [true, false]) {
  test(`a newer .tgz of an installed ${scoped ? 'scoped' : 'unscoped'} plugin is an update, not "no new package"`, async () => {
    const f = fixture();
    const n = ++serial;
    const name = scoped ? `@acme/update-${n}` : `update-${n}`;
    await addPlugin(packed(name, `acme-update-${n}`, '0.1.0'), f.root, { npm: f.npm, config: f.config });
    const res = await addPlugin(packed(name, `acme-update-${n}`, '0.1.1'), f.root, { npm: f.npm, config: f.config });
    assert.equal(res.pkg, name);
    assert.equal(res.id, `acme-update-${n}`);
    assert.equal(res.version, '0.1.1');
    assert.equal(res.refused, null);
    assert.equal(installedVersion(f, name), '0.1.1');
  });
}

test('the same release from a .tgz is refused before npm runs, and nothing changes', async () => {
  const f = fixture();
  const n = ++serial;
  const name = `@acme/again-${n}`;
  const archive = packed(name, `acme-again-${n}`, '2.0.0');
  await addPlugin(archive, f.root, { npm: f.npm, config: f.config });
  const pkgBefore = readFileSync(join(f.root, 'package.json'), 'utf8');
  const configBefore = readFileSync(f.config, 'utf8');
  const calls = f.calls.length;
  await assert.rejects(addPlugin(archive, f.root, { npm: f.npm, config: f.config }), (err: unknown) => {
    assert.ok(err instanceof PluginAlreadyInstalledError);
    assert.match(err.message, new RegExp(`${name}@2\\.0\\.0 is already installed`));
    assert.doesNotMatch(err.message, /no new package detected/);
    return true;
  });
  assert.equal(f.calls.length, calls, 'npm is never called');
  assert.equal(readFileSync(join(f.root, 'package.json'), 'utf8'), pkgBefore);
  assert.equal(readFileSync(f.config, 'utf8'), configBefore);
  assert.equal(installedVersion(f, name), '2.0.0');
});

test('the same release from a folder still goes through npm, as before', async () => {
  const f = fixture();
  const n = ++serial;
  const dir = pluginFolder(`@acme/folder-${n}`, `acme-folder-${n}`, '1.0.0');
  await addPlugin(dir, f.root, { npm: f.npm, config: f.config });
  const res = await addPlugin(dir, f.root, { npm: f.npm, config: f.config });
  assert.equal(res.pkg, `@acme/folder-${n}`);
  assert.equal(f.calls.length, 2);
});
