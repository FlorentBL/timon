/**
 * The browser half of the built-in `github-issues` plugin ships as a built
 * file, `lib/client.js`, next to its sources in `src/`. A change to `src/`
 * without `npm run build:client` would ship the old screen while every test of
 * the sources passes. This rebuilds `src/` the way that script does and asks
 * for the very same bytes.
 *
 * esbuild comes with tsx, which runs this suite: the same copy
 * `build:client` calls through `npx`.
 */
import '../test-home.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const ORCHESTRATOR = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PLUGIN = join(ORCHESTRATOR, '..', 'plugins', 'github-issues');

test('lib/client.js is the build of src/: run `npm run build:client` in plugins/github-issues after a change', async () => {
  const script = JSON.parse(readFileSync(join(PLUGIN, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
  // The options below are the script's: a change there must change them here.
  assert.equal(
    script.scripts['build:client'],
    'cd ../../orchestrator && npx esbuild ../plugins/github-issues/src/client.tsx --bundle --format=esm --external:react --external:@timon/ui --outfile=../plugins/github-issues/lib/client.js',
  );
  const out = await build({
    absWorkingDir: ORCHESTRATOR,
    entryPoints: ['../plugins/github-issues/src/client.tsx'],
    bundle: true,
    format: 'esm',
    external: ['react', '@timon/ui'],
    outfile: '../plugins/github-issues/lib/client.js',
    write: false,
    logLevel: 'silent',
  });
  const built = out.outputFiles[0]?.text ?? '';
  const shipped = readFileSync(join(PLUGIN, 'lib', 'client.js'), 'utf8');
  assert.ok(built.length > 0);
  assert.ok(built === shipped, 'lib/client.js differs from a build of src/: run `npm run build:client` in plugins/github-issues');
});
