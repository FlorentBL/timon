/**
 * The app stays on webpack under Next 16: `next.config.mjs` carries a
 * `webpack()` hook (the vault-graph UMD rule, `BundleModulesPlugin`) that
 * Turbopack ignores. `next build` and the custom server pick their bundler
 * separately, so both are pinned here: a custom server created without
 * `webpack: true` sets `TURBOPACK`, and Next then compiles dev with Turbopack
 * and loads the Turbopack runtime in production, whatever the build used.
 *
 * These tests read the behaviour of the Next that `node_modules` resolves. A
 * worktree whose `node_modules` still holds Next 15 (no `webpack` option, no
 * Turbopack default) would fail them for the wrong reason, so the first test
 * names the version it found.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import next from 'next';

function majorMinor(version: string): string {
  return version.replace(/^[~^]/, '').split('.').slice(0, 2).join('.');
}

test('node_modules resolves the Next that package.json pins', () => {
  const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as { dependencies: Record<string, string> };
  const pinned = pkg.dependencies.next ?? '';
  const installed = (JSON.parse(readFileSync(join(process.cwd(), 'node_modules', 'next', 'package.json'), 'utf8')) as { version: string }).version;
  assert.equal(
    majorMinor(installed),
    majorMinor(pinned),
    `node_modules holds next ${installed} but package.json pins ${pinned}: install the app's dependencies before reading the tests below`,
  );
});

function turbopackAfter(options: { webpack?: boolean }): string | undefined {
  const before = process.env.TURBOPACK;
  delete process.env.TURBOPACK;
  try {
    next({ dev: false, dir: process.cwd(), ...options });
    return process.env.TURBOPACK;
  } finally {
    if (before === undefined) delete process.env.TURBOPACK;
    else process.env.TURBOPACK = before;
  }
}

test('a custom server without a bundler flag gets Turbopack', () => {
  assert.ok(turbopackAfter({}), 'Next no longer selects Turbopack by default: this pin can go');
});

test('a custom server created with webpack: true stays on webpack', () => {
  assert.equal(turbopackAfter({ webpack: true }), undefined);
});

test('server.ts and the build script both ask for webpack', () => {
  const server = readFileSync(join(process.cwd(), 'src', 'server.ts'), 'utf8');
  assert.match(server, /next\(\{[^}]*webpack: true/);
  const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as { scripts: Record<string, string> };
  assert.match(pkg.scripts.build ?? '', /^next build --webpack\b/);
});
