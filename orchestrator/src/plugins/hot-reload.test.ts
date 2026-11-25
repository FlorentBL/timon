/**
 * Re-enabling a plugin whose host half once failed to import (TIM-0116).
 *
 * Node's ESM cache keeps a module whose linking failed, under the URL it was
 * imported from. The revision of that URL used to be the tree signature, which
 * a disable then enable does not change: the retry got the same error back
 * until the daemon restarted.
 */
import '../test-home.js';
import '../../tests/helpers/paid-license.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { Context } from '@deepseek-ai/cordis';

const { createHttpPlugin } = await import('../kernel/http-service.js');
const { PluginLoader } = await import('./loader.js');
const { daemonHost } = await import('./context.js');
const { HOOK_SOURCE, entryUrl } = await import('./hot-reload.js');
import type { ModuleSetting } from '../config/schema.js';

const OK = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'ok');

/** Same length as FIXED, so the tree stamp (size + mtime) is the only thing a restored mtime has to hide. */
const BROKEN = "export const greex = () => 'hello';\n";
const FIXED = "export const greet = () => 'hello';\n";

function brokenPlugin(): { root: string; core: string } {
  const root = mkdtempSync(join(tmpdir(), 'timon-hot-reload-'));
  const dir = join(root, 'node_modules', '@fixtures', 'plugin-relink');
  mkdirSync(join(dir, 'lib'), { recursive: true });
  const manifest = JSON.parse(readFileSync(join(OK, 'package.json'), 'utf8')) as { timon: Record<string, unknown> };
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: '@fixtures/plugin-relink',
    version: '1.0.0',
    private: true,
    type: 'module',
    main: 'lib/index.js',
    timon: { id: 'fixture-relink', apiVersion: 1, kind: ['behavior'], label: 'Relink', description: 'Hot reload', permissions: manifest.timon.permissions },
  }));
  writeFileSync(join(dir, 'lib', 'index.js'), [
    "import { greet } from './core.js'",
    "export const name = 'fixture-relink'",
    'export function apply(ctx) { ctx.router().get(\'/ping\', (_req, res) => res.json({ greeting: greet() })) }',
    '',
  ].join('\n'));
  const core = join(dir, 'lib', 'core.js');
  writeFileSync(core, BROKEN);
  writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { '@fixtures/plugin-relink': 'file:fixture' } }));
  return { root, core };
}

async function daemon() {
  const app = express();
  const ctx = new Context();
  await ctx.plugin(createHttpPlugin(app));
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const port = (server.address() as { port: number }).port;
  return { ctx, url: (p: string) => `http://127.0.0.1:${port}${p}`, close: async () => { server.close(); await ctx.fiber.dispose(); } };
}

test('TIM-0116: disable then enable retries a failed import with the sub-module as it is now', async () => {
  const d = await daemon();
  const { root, core } = brokenPlugin();
  let plugins: Record<string, ModuleSetting> = {};
  const loader = new PluginLoader(d.ctx, { dir: root, host: daemonHost(d.ctx), plugins: () => plugins, allowUnsigned: () => true });

  const [failed] = await loader.update();
  assert.equal(failed?.reason, 'skipped:import');
  assert.match(failed?.error ?? '', /greet/);
  assert.match(failed?.error ?? '', /disable then enable/);

  // The fix lands without the tree stamp noticing (same size, same mtime):
  // the case of an edit that finishes inside the stamp's own resolution.
  const before = statSync(core);
  writeFileSync(core, FIXED);
  utimesSync(core, before.atime, before.mtime);

  plugins = { 'fixture-relink': false };
  assert.equal((await loader.update())[0]?.state, 'disabled');
  plugins = {};
  const [again] = await loader.update();
  assert.equal(again?.state, 'active', again?.error ?? '');
  assert.deepEqual(await (await fetch(d.url('/api/plugins/fixture-relink/ping'))).json(), { greeting: 'hello' });

  await loader.dispose();
  await d.close();
  rmSync(root, { recursive: true, force: true });
});

test('TIM-0116: the resolve hook keeps a sub-module in the revision whatever the drive letter case', async () => {
  const hook = await import(`data:text/javascript,${encodeURIComponent(HOOK_SOURCE)}`) as {
    resolve: (specifier: string, context: { parentURL: string }, next: (s: string, c: unknown) => Promise<{ url: string }>) => Promise<{ url: string }>;
  };
  const root = 'file:///C:/Users/me/.timon/plugins/node_modules/acme/';
  const parent = `${root}lib/index.js?rev=r1&root=${encodeURIComponent(root)}`;
  const resolved = (url: string) => hook.resolve('./core.js', { parentURL: parent }, async () => ({ url }));

  const upper = await resolved(`${root}lib/core.js`);
  const lower = await resolved(`file:///c:/Users/me/.timon/plugins/node_modules/acme/lib/core.js`);
  assert.match(upper.url, /\?rev=r1&/);
  assert.match(lower.url, /\?rev=r1&/, 'a lower-case drive letter must not leave the revision');

  const foreign = await resolved('file:///C:/Users/me/.timon/plugins/node_modules/other/lib/core.js');
  assert.doesNotMatch(foreign.url, /\?rev=/, 'a sibling directory is not part of the plugin');
  const dependency = await resolved(`${root}node_modules/dep/index.js`);
  assert.doesNotMatch(dependency.url, /\?rev=/, 'node_modules stays shared');
});

/**
 * A plugin installed from a local folder is linked by npm, not copied:
 * `<home>/plugins/node_modules/<pkg>` points at the folder (a junction on
 * Windows). Its entry was imported under the linked path while the root the
 * hook compares against was the real one: under a resolver that keeps links
 * (`NODE_PRESERVE_SYMLINKS=1`), a sub-module never got the revision and kept
 * the old version next to a new entry until a restart. Node's default
 * resolver hides it; the hook test below fakes the other one.
 */
function linkedPlugin(): { root: string; config: string; unlink: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'timon-hot-reload-linked-'));
  const release = join(root, 'releases', 'plugin-linked');
  mkdirSync(join(release, 'dist'), { recursive: true });
  const manifest = JSON.parse(readFileSync(join(OK, 'package.json'), 'utf8')) as { timon: Record<string, unknown> };
  writeFileSync(join(release, 'package.json'), JSON.stringify({
    name: '@fixtures/plugin-linked',
    version: '1.0.0',
    private: true,
    type: 'module',
    main: 'dist/index.js',
    timon: { id: 'fixture-linked', apiVersion: 1, kind: ['behavior'], label: 'Linked', description: 'Hot reload', permissions: manifest.timon.permissions },
  }));
  writeFileSync(join(release, 'dist', 'index.js'), [
    "import { version } from './config.js'",
    "export const name = 'fixture-linked'",
    'export function apply(ctx) { ctx.router().get(\'/version\', (_req, res) => res.json({ version })) }',
    '',
  ].join('\n'));
  const config = join(release, 'dist', 'config.js');
  writeFileSync(config, "export const version = 'one';\n");
  const scope = join(root, 'node_modules', '@fixtures');
  mkdirSync(scope, { recursive: true });
  const link = join(scope, 'plugin-linked');
  // What npm creates for a `file:` dependency: a junction on Windows (no
  // privilege needed), a directory symlink elsewhere.
  symlinkSync(release, link, process.platform === 'win32' ? 'junction' : 'dir');
  writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { '@fixtures/plugin-linked': 'file:releases/plugin-linked' } }));
  // The link itself goes first: a recursive removal that meets it would
  // follow it and empty the folder it points at.
  return { root, config, unlink: () => unlinkSync(link) };
}

test('#134: a plugin linked into node_modules reloads its sub-modules with its entry', async () => {
  const d = await daemon();
  const { root, config, unlink } = linkedPlugin();
  const loader = new PluginLoader(d.ctx, { dir: root, host: daemonHost(d.ctx), plugins: () => ({}), allowUnsigned: () => true });
  try {
    const [first] = await loader.update();
    assert.equal(first?.state, 'active', first?.error ?? '');
    assert.deepEqual(await (await fetch(d.url('/api/plugins/fixture-linked/version'))).json(), { version: 'one' });

    // A different size: the tree stamp, read through the link, sees the change.
    writeFileSync(config, "export const version = 'second';\n");
    const [second] = await loader.update();
    assert.equal(second?.state, 'active', second?.error ?? '');
    assert.deepEqual(
      await (await fetch(d.url('/api/plugins/fixture-linked/version'))).json(),
      { version: 'second' },
      'the sub-module imported by the new entry must be the new one',
    );
  } finally {
    await loader.dispose();
    await d.close();
    unlink();
    rmSync(root, { recursive: true, force: true });
  }
});

test('#134: a resolver that keeps links still gives the revision to a linked plugin\'s sub-modules', async () => {
  const hook = await import(`data:text/javascript,${encodeURIComponent(HOOK_SOURCE)}`) as {
    resolve: (specifier: string, context: { parentURL?: string }, next: (s: string, c: { parentURL?: string }) => Promise<{ url: string }>) => Promise<{ url: string }>;
  };
  // `--preserve-symlinks`: a URL is resolved as written, the link never
  // replaced by its target (what the reporter's daemon did).
  const keepLinks = async (specifier: string, context: { parentURL?: string }) => {
    const url = new URL(specifier, context.parentURL);
    url.search = '';
    return { url: url.href };
  };
  const { root, unlink } = linkedPlugin();
  try {
    const dir = join(root, 'node_modules', '@fixtures', 'plugin-linked');
    const entry = await hook.resolve(entryUrl(join(dir, 'dist', 'index.js'), 'r2', dir), {}, async (s) => ({ url: s }));
    const sub = await hook.resolve('./config.js', { parentURL: entry.url }, keepLinks);
    assert.match(sub.url, /\/dist\/config\.js\?rev=r2&/, 'the sub-module must carry the entry\'s revision');
    const dependency = await hook.resolve('../node_modules/dep/index.js', { parentURL: entry.url }, keepLinks);
    assert.doesNotMatch(dependency.url, /\?rev=/, 'the plugin\'s own dependencies stay shared');
  } finally {
    unlink();
    rmSync(root, { recursive: true, force: true });
  }
});
