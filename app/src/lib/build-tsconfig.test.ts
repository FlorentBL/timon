import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

/**
 * `next build` type-checks the app, and the Docker image builds it from a
 * context holding `app/` alone. The tests import `orchestrator/` and
 * `plugins/`, which that context lacks: checked there, they failed the image
 * build while a full checkout stayed green. So the build checks
 * `tsconfig.build.json`, the app without its tests, and `npm run typecheck`
 * keeps checking everything through `tsconfig.json`.
 */

const APP = resolve(__dirname, '..', '..');
const BUILD_TSCONFIG = 'tsconfig.build.json';

function parse(file: string): ts.ParsedCommandLine {
  const read = ts.readConfigFile(join(APP, file), ts.sys.readFile);
  assert.equal(read.error, undefined, `${file} does not parse`);
  return ts.parseJsonConfigFileContent(read.config, ts.sys, APP);
}

function isTest(file: string): boolean {
  return /\.test\.tsx?$/.test(file);
}

test('next build type-checks tsconfig.build.json', async () => {
  const mod: unknown = await import(pathToFileURL(join(APP, 'next.config.mjs')).href);
  const config = (mod as { default: { typescript?: { tsconfigPath?: string; ignoreBuildErrors?: boolean } } }).default;
  assert.equal(config.typescript?.tsconfigPath, BUILD_TSCONFIG);
  assert.notEqual(config.typescript?.ignoreBuildErrors, true, 'the build must keep its type check');
});

test('the Docker image copies tsconfig.build.json next to tsconfig.json', () => {
  const dockerfile = readFileSync(join(APP, 'Dockerfile'), 'utf8');
  const copy = dockerfile.split('\n').find((line) => /^COPY\s.*\btsconfig\.json\b/.test(line));
  assert.ok(copy, 'no COPY line for tsconfig.json in app/Dockerfile');
  assert.match(copy, /\btsconfig\.build\.json\b/);
});

test('tsconfig.build.json is the app without its tests, tsconfig.json keeps them', () => {
  const full = parse('tsconfig.json').fileNames;
  const build = parse(BUILD_TSCONFIG).fileNames;
  assert.ok(full.some(isTest), 'npm run typecheck no longer reaches the tests');
  assert.deepEqual(build.filter(isTest), []);
  assert.deepEqual(build, full.filter((file) => !isTest(file)));
});

test('nothing the build checks imports outside app/', () => {
  // The specifier is judged, not what it resolves to: in the Docker context
  // an import that leaves app/ resolves to nothing at all.
  const outside: string[] = [];
  for (const file of parse(BUILD_TSCONFIG).fileNames) {
    for (const { fileName: specifier } of ts.preProcessFile(readFileSync(file, 'utf8'), true, true).importedFiles) {
      if (specifier.startsWith('.') && relative(APP, resolve(dirname(file), specifier)).startsWith('..')) {
        outside.push(`${relative(APP, file)} -> ${specifier}`);
      }
    }
  }
  assert.deepEqual(outside, []);
});
