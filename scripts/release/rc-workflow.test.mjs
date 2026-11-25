/**
 * Static checks on .github/workflows/rc.yml: what it may do is fixed by its
 * text, and it cannot be run before it reaches GitHub. No YAML parser at the
 * repository root: the checks read the file line by line, which its plain
 * block style allows.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readWorkflow } from './workflow-text.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const text = readFileSync(join(ROOT, '.github', 'workflows', 'rc.yml'), 'utf8');
const lines = text.split('\n');
/** Lines without their comment: a comment may explain what the workflow does not do. */
const code = lines.map((line) => line.replace(/(^|\s)#.*$/, '')).join('\n');

/** The jobs, by name, each with its own lines (two-space indented keys under `jobs:`). */
function jobs() {
  const start = lines.indexOf('jobs:');
  assert.ok(start > 0, 'no jobs: block');
  const found = new Map();
  let current = null;
  for (const line of lines.slice(start + 1)) {
    const m = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (m) { current = m[1]; found.set(current, []); continue; }
    if (current && (line.startsWith('    ') || !line.trim() || /^\s*#/.test(line))) found.get(current).push(line);
    else if (current && /^\S/.test(line)) current = null;
  }
  return found;
}

/** The text of each `run:` block, single line or literal block. */
function runBlocks() {
  const blocks = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)(?:- )?run:\s*(.*)$/.exec(lines[i]);
    if (!m) continue;
    if (m[2] !== '|' && m[2] !== '>') { blocks.push(m[2]); continue; }
    const indent = m[1].length;
    const body = [];
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j].trim() && lines[j].search(/\S/) <= indent) break;
      body.push(lines[j]);
    }
    blocks.push(body.join('\n'));
  }
  return blocks;
}

test('rc.yml runs only when asked, never on a push, a pull request or a tag', () => {
  const on = /^on:\n((?: {2}.*\n|\s*\n)+)/m.exec(text);
  assert.ok(on, 'no on: block');
  const triggers = on[1].split('\n').map((line) => /^ {2}([a-z_]+):/.exec(line)?.[1]).filter(Boolean);
  assert.deepEqual(triggers, ['workflow_dispatch']);
});

test('rc.yml never asks for contents: write, and writes only what the attestation needs', () => {
  assert.doesNotMatch(code, /contents:\s*write/);
  assert.doesNotMatch(code, /write-all/);
  const writes = [...code.matchAll(/^\s*([a-z-]+):\s*write\s*$/gm)].map((m) => m[1]);
  assert.deepEqual([...new Set(writes)].sort(), ['attestations', 'id-token']);
  assert.match(text, /^permissions:\n {2}contents: read\n/m, 'the workflow default is contents: read');
  for (const [name, body] of jobs()) {
    assert.ok(body.some((line) => /^ {4}permissions:/.test(line)), `job ${name} declares no permissions`);
    if (name !== 'attest') assert.ok(!body.some((line) => /:\s*write\s*$/.test(line.replace(/#.*$/, ''))), `job ${name} writes`);
  }
});

test('the attestation token never shares a job with npm or the built code', () => {
  const found = jobs();
  const build = found.get('build').join('\n');
  assert.doesNotMatch(build, /id-token|attestations:/, 'the build job holds an attestation permission');
  assert.doesNotMatch(build, /attest-build-provenance/, 'the build job attests');
  const attest = found.get('attest');
  assert.ok(attest, 'no attest job');
  const body = attest.map((line) => line.replace(/(^|\s)#.*$/, '')).join('\n');
  assert.match(body, /id-token:\s*write/);
  assert.match(body, /attestations:\s*write/);
  assert.match(body, /actions\/attest-build-provenance@/);
  assert.doesNotMatch(body, /actions\/checkout@/, 'the attest job checks out code');
  assert.doesNotMatch(body, /actions\/setup-node@/, 'the attest job installs Node');
  assert.doesNotMatch(body, /\bnpm\b|\bnpx\b|\bnode\b/, 'the attest job runs Node code');
  assert.match(body, /needs:\s*\[validate, build\]/);
  assert.match(body, /fail-fast:\s*false/);
  // The installers are checked against the sums the build wrote before anything is attested.
  assert.match(body, /sha256sum --strict -c SHA256SUMS/);
  assert.ok(body.indexOf('sha256sum') < body.indexOf('attest-build-provenance'), 'the sums are checked after the attestation');
  assert.match(body, /create-storage-record:\s*false/);
});

test('rc.yml references no secret and hands no token to the build', () => {
  assert.doesNotMatch(code, /secrets\./);
  assert.doesNotMatch(code, /\bsecrets\b/);
  assert.doesNotMatch(code, /GITHUB_TOKEN|GH_TOKEN|github\.token/);
  assert.doesNotMatch(code, /environment:/, 'a deployment environment would expose its secrets');
  assert.doesNotMatch(code, /CSC_LINK|CSC_KEY_PASSWORD|APPLE_ID|APPLE_APP_SPECIFIC_PASSWORD/);
  assert.doesNotMatch(code, /--publish\s+(always|onTag|onTagOrDraft)/);
});

test('every action is pinned on a full commit sha, its version in a comment', () => {
  const uses = lines.filter((line) => /^\s*(?:- )?uses:/.test(line));
  assert.ok(uses.length >= 5, 'the workflow uses actions');
  const versions = new Map();
  for (const line of uses) {
    const m = /^\s*(?:- )?uses:\s*([A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+)@([0-9a-f]{40})\s+#\s*(v\d+(?:\.\d+){0,2})\s*$/.exec(line);
    assert.ok(m, `not pinned on a sha with its version: ${line.trim()}`);
    const [, action, sha] = m;
    // One action, one pin: two shas for one action is a half-done update.
    if (versions.has(action)) assert.equal(versions.get(action), sha, `${action} is pinned twice differently`);
    versions.set(action, sha);
  }
});

test('every checkout leaves no credential behind', () => {
  const checkouts = lines.map((line, i) => (/uses:\s*actions\/checkout@/.test(line) ? i : -1)).filter((i) => i >= 0);
  assert.ok(checkouts.length >= 3);
  for (const i of checkouts) {
    const block = [];
    for (let j = i + 1; j < lines.length && !/^\s*- /.test(lines[j]); j++) block.push(lines[j]);
    assert.ok(block.some((line) => /persist-credentials:\s*false/.test(line)), `checkout at line ${i + 1} keeps its credentials`);
  }
});

test('every job has a time limit', () => {
  const found = jobs();
  assert.deepEqual([...found.keys()], ['validate', 'build', 'attest', 'summary']);
  for (const [name, body] of found) {
    const limit = body.map((line) => /^ {4}timeout-minutes:\s*(\d+)\s*$/.exec(line)?.[1]).find(Boolean);
    assert.ok(limit, `job ${name} has no timeout-minutes`);
    assert.ok(Number(limit) > 0 && Number(limit) <= 180, `job ${name}: timeout ${limit}`);
  }
});

test('no expression is pasted into a shell script: inputs reach run blocks through env', () => {
  for (const block of runBlocks()) assert.doesNotMatch(block, /\$\{\{/, `expression inside run:\n${block}`);
});

test('the build matrix covers the three systems and keeps going when one fails', () => {
  const build = jobs().get('build').join('\n');
  assert.match(build, /fail-fast:\s*false/);
  for (const [os, runner] of [['linux', 'ubuntu-24\\.04'], ['mac', '\\[self-hosted, macOS, ARM64, timon-release\\]'], ['windows', 'windows-latest']]) {
    assert.match(build, new RegExp(`\\{ os: ${os}, runner: ${runner} \\}`));
  }
  assert.match(build, /scripts\/release\/build-package\.mjs/);
  assert.match(build, /actions\/upload-artifact@/);
});

test('the throwaway keys stay outside the checkout and the output', () => {
  assert.match(code, /throwaway-keys\.mjs "\$RUNNER_TEMP"/);
  assert.doesNotMatch(code, /--key-dir/);
  assert.match(code, /--output \.\.\/rc-output/);
});

// rc.yml keeps its own build job: the check of build-packages.yml, used by
// release.yml and nightly.yml, does not reach it.
test('the Linux build tools are checked before the build, as in build-packages.yml', () => {
  const rc = readWorkflow('rc.yml');
  const step = rc.stepNamed('build', 'Check the Linux build tools');
  assert.match(step, /if: matrix\.os == 'linux'/);
  assert.match(step, /run: for tool in objdump gcc x86_64-linux-musl-gcc docker; do command -v "\$tool" >\/dev\/null \|\| \{ echo "::error::\$tool is missing on this runner"; exit 1; \}; done$/m);
  assert.equal(step, readWorkflow('build-packages.yml').stepNamed('build', 'Check the Linux build tools'));
  const order = rc.steps('build').map((s) => s.join('\n'));
  const at = (name) => order.findIndex((s) => s.includes(`name: ${name}`));
  assert.ok(at('Install a baseline C library') >= 0);
  assert.ok(at('Install a baseline C library') < at('Check the Linux build tools'));
  assert.ok(at('Check the Linux build tools') < at('Build the package'));
});
