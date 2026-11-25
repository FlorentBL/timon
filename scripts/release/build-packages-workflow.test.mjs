/**
 * Static checks on .github/workflows/build-packages.yml, the build steps
 * shared by release.yml and nightly.yml: what each purpose may reach, and how
 * the shared Mac is split between them.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readWorkflow } from './workflow-text.mjs';

const wf = readWorkflow('build-packages.yml');

test('build-packages.yml is only ever called by another workflow', () => {
  assert.deepEqual(wf.triggers().names, ['workflow_call']);
  assert.match(wf.text, /^permissions:\n {2}contents: read\n/m);
  assert.deepEqual([...wf.jobs().keys()], ['build']);
  assert.deepEqual(wf.blockOf('build', 'permissions').map((line) => line.trim()), ['contents: read']);
  assert.doesNotMatch(wf.code, /write-all|read-all|:\s*write\s*$/m);
});

test('the purpose alone decides the environment, the channel, the expiry and the signing', () => {
  assert.match(wf.text, /^ {6}purpose:\n {8}description: release or nightly\n {8}required: true\n {8}type: string\n/m);
  const check = wf.stepNamed('build', 'Check the request');
  assert.match(check, /release\)\n\s+\[\[ "\$VERSION" =~ \^\$core\$ \]\]/);
  assert.match(check, /\[ "\$EXPIRES" = never \] \|\| \{ echo "::error::a release never expires"; exit 1; \}/);
  assert.match(check, /nightly\)\n\s+\[\[ "\$VERSION" =~ \^\$core-nightly\\\.\[1-9\]\[0-9\]\{7\}\$ \]\]/);
  assert.match(check, /\*\) echo "::error::purpose must be release or nightly"; exit 1 ;;/);
  // First step: nothing is checked out nor installed for a malformed request.
  assert.match(wf.steps('build')[0].join('\n'), /name: Check the request/);
  const build = wf.stepNamed('build', 'Build the package');
  assert.match(build, /--channel stable --no-expiry --output \.\.\/release-output\n {10}else\n {12}node scripts\/release\/build-package\.mjs --version "\$VERSION" --channel beta --expires "\$EXPIRES" --output \.\.\/release-output\n/);
  assert.doesNotMatch(wf.code, /--key-dir|--publish/);
});

test('a nightly signs with a pair made on the runner, and removes it whatever happens', () => {
  assert.match(wf.stepNamed('build', 'Throwaway signing keys'), /run: node src\/scripts\/release\/throwaway-keys\.mjs "\$RUNNER_TEMP"/);
  assert.match(wf.stepNamed('build', 'Remove the throwaway keys'), /if: always\(\) && inputs\.purpose == 'nightly'/);
  const order = wf.steps('build').map((step) => step.join('\n'));
  const at = (needle) => order.findIndex((step) => step.includes(needle));
  assert.ok(at('name: Throwaway signing keys') < at('name: Build the package'));
  assert.ok(at('name: Remove the throwaway keys') > at('name: Build the package'));
  assert.ok(at('name: Remove the throwaway keys') < at('uses: actions/upload-artifact@'), 'the keys are gone before the upload');
});

test('the shared Mac: a release leg cancels a nightly leg, a nightly leg waits for a release leg', () => {
  const concurrency = wf.blockOf('build', 'concurrency').map((line) => line.trim());
  assert.deepEqual(concurrency, [
    "group: ${{ matrix.os == 'mac' && 'timon-mac-runner' || format('build-packages-{0}-{1}-{2}', github.run_id, github.run_attempt, matrix.os) }}",
    "cancel-in-progress: ${{ inputs.purpose == 'release' }}",
  ]);
  // Not a group of a caller: GitHub cancels the caller when they share one.
  for (const caller of ['release.yml', 'nightly.yml']) {
    assert.doesNotMatch(readWorkflow(caller).code, /group:\s*timon-mac-runner|group: \$\{\{ github\.workflow \}\}/, caller);
  }
});

test('the Linux build tools are checked before the build, in one line', () => {
  const step = wf.stepNamed('build', 'Check the Linux build tools');
  assert.match(step, /if: matrix\.os == 'linux'/);
  assert.match(step, /run: for tool in objdump gcc x86_64-linux-musl-gcc docker; do command -v "\$tool" >\/dev\/null \|\| \{ echo "::error::\$tool is missing on this runner"; exit 1; \}; done$/m);
  const order = wf.steps('build').map((s) => s.join('\n'));
  const at = (name) => order.findIndex((s) => s.includes(`name: ${name}`));
  assert.ok(at('Install a baseline C library') < at('Check the Linux build tools'));
  assert.ok(at('Check the Linux build tools') < at('Build the package'));
});

test('a self-hosted runner starts from a clean output, nightlies included', () => {
  const step = wf.stepNamed('build', 'Clear what an earlier run left');
  assert.match(step, /if: runner\.environment == 'self-hosted'/);
  assert.match(step, /run: rm -rf "release-output\/\$VERSION\/\$OS" "release-output\/\$VERSION\/\.work-\$OS" release-output\/\*-nightly\.\*$/m);
});

test('every action is pinned, every checkout drops its credential, every value reaches a script through env', () => {
  assert.ok(wf.pins().size >= 3);
  assert.deepEqual(wf.checkoutsKeepingCredentials(), []);
  for (const block of wf.runBlocks()) assert.doesNotMatch(block, /\$\{\{/, `expression inside run:\n${block}`);
  assert.equal(wf.keyOf('build', 'timeout-minutes'), '150');
});
