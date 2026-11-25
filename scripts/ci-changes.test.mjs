/**
 * scripts/ci-changes.mjs decides when ci.yml may skip the daemon and app
 * suites, and ci.yml wires that decision so the required checks still finish.
 * A wrong `guards` merges untested code: every doubt must come out `full`.
 *
 * Collected by orchestrator's `../scripts/*.test.mjs`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GUARD_TESTS, changedFiles, decide, decideRun, isSkippable, parseArgs } from './ci-changes.mjs';
import { readWorkflow } from './release/workflow-text.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(ROOT, 'scripts', 'ci-changes.mjs');

test('only workflows, public pages, changelog fragments and root Markdown are skippable', () => {
  for (const path of [
    '.github/workflows/release.yml', '.github/workflows/ci.yml',
    'public-docs/docs/usage/agents.md', 'public-docs/docusaurus.config.ts', 'public-docs/package.json',
    'changes/fix-something.md', 'changes/README.md',
    'README.md', 'CHANGELOG.md', 'AGENTS.md', 'CONTRIBUTING.md',
  ]) assert.equal(isSkippable(path), true, path);
  for (const path of [
    // Code the daemon runs or its tests import.
    'public-docs/scripts/export-markdown.mjs', 'public-docs/scripts/gen-changelog.mjs',
    // Not a workflow: the protected paths list, code owners, actions.
    '.github/protected-paths', '.github/CODEOWNERS', '.github/actions/setup/action.yml', '.github/workflows',
    // Markdown below the root is read by the product (skills, prompts, agent docs).
    'orchestrator/skills/timon-task/SKILL.md', 'docs/PROGRESS.md', 'app/README.md',
    // Look-alikes.
    'public-docs', 'changes', 'changes.md.ts', 'README.mdx', 'LICENSE', 'package.json',
    'scripts/ci-changes.mjs', 'orchestrator/src/index.ts',
  ]) assert.equal(isSkippable(path), false, path);
});

test('the suites are skipped only when every changed file is skippable', () => {
  assert.equal(decide(['.github/workflows/release.yml']).suites, 'guards');
  assert.equal(decide(['public-docs/docs/a.md', 'changes/x.md', 'README.md', '.github/workflows/ci.yml']).suites, 'guards');
  const mixed = decide(['public-docs/docs/a.md', 'orchestrator/src/index.ts', 'changes/x.md']);
  assert.equal(mixed.suites, 'full');
  assert.match(mixed.reason, /orchestrator\/src\/index\.ts/);
  assert.equal(decide(['public-docs/scripts/gen-cli.mjs']).suites, 'full');
  assert.equal(decide([]).suites, 'full', 'an empty diff proves nothing');
});

test('arguments are strict: an unknown or valueless one is refused', () => {
  assert.deepEqual(parseArgs(['--event', 'pull_request', '--base', 'a', '--head', 'b']), { event: 'pull_request', base: 'a', head: 'b' });
  assert.throws(() => parseArgs(['--skip']), /unknown argument/);
  assert.throws(() => parseArgs(['--base']), /needs a value/);
});

/** A throwaway repository: a base commit with code, then the given changes in a second one. */
function repoWith(change) {
  const dir = mkdtempSync(join(tmpdir(), 'ci-changes-'));
  const git = (...args) => execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd: dir, encoding: 'utf8' });
  git('init', '-q');
  mkdirSync(join(dir, 'orchestrator', 'src'), { recursive: true });
  mkdirSync(join(dir, 'public-docs', 'docs'), { recursive: true });
  writeFileSync(join(dir, 'orchestrator', 'src', 'guide.ts'), 'export const guide = "a long enough body for git to see a rename";\n');
  writeFileSync(join(dir, 'public-docs', 'docs', 'a.md'), '# A\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  change(dir, git);
  git('add', '-A');
  git('commit', '-q', '-m', 'change');
  return dir;
}

test('the diff reads the pull request\'s files, renames on both sides', () => {
  const docs = repoWith((dir) => writeFileSync(join(dir, 'public-docs', 'docs', 'a.md'), '# A, edited\n'));
  const moved = repoWith((_dir, git) => git('mv', 'orchestrator/src/guide.ts', 'public-docs/docs/guide.ts'));
  const odd = repoWith((dir) => writeFileSync(join(dir, 'public-docs', 'docs', 'ñ "quoted".md'), 'x\n'));
  try {
    assert.deepEqual(changedFiles('HEAD^1', 'HEAD', docs), ['public-docs/docs/a.md']);
    assert.equal(decideRun(['--event', 'pull_request', '--base', 'HEAD^1', '--head', 'HEAD'], docs).suites, 'guards');
    // A move of code into public-docs/ removes code: it is a change of code.
    assert.deepEqual(changedFiles('HEAD^1', 'HEAD', moved).sort(), ['orchestrator/src/guide.ts', 'public-docs/docs/guide.ts']);
    assert.equal(decideRun(['--event', 'pull_request', '--base', 'HEAD^1', '--head', 'HEAD'], moved).suites, 'full');
    assert.deepEqual(changedFiles('HEAD^1', 'HEAD', odd), ['public-docs/docs/ñ "quoted".md']);
  } finally {
    for (const dir of [docs, moved, odd]) rmSync(dir, { recursive: true, force: true });
  }
});

test('any doubt runs every suite: a push, a manual run, a missing revision, bad arguments', () => {
  const dir = repoWith((d) => writeFileSync(join(d, 'changes.md'), 'x\n'));
  try {
    const pr = ['--base', 'HEAD^1', '--head', 'HEAD'];
    assert.equal(decideRun(['--event', 'pull_request', ...pr], dir).suites, 'guards');
    for (const event of ['push', 'workflow_dispatch', 'schedule']) assert.equal(decideRun(['--event', event, ...pr], dir).suites, 'full', event);
    assert.equal(decideRun(pr, dir).suites, 'full', 'no event');
    assert.equal(decideRun(['--event', 'pull_request', '--base', 'HEAD^1'], dir).suites, 'full', 'no head');
    const missing = decideRun(['--event', 'pull_request', '--base', 'HEAD~5', '--head', 'HEAD'], dir);
    assert.equal(missing.suites, 'full');
    assert.match(missing.reason, /could not read the changes/);
    assert.equal(decideRun(['--event', 'pull_request', '--force'], dir).suites, 'full');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the command writes both outputs to GITHUB_OUTPUT', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ci-changes-out-'));
  try {
    const output = join(dir, 'output');
    writeFileSync(output, 'earlier=1\n');
    const run = spawnSync(process.execPath, [SCRIPT, '--event', 'push'], { env: { ...process.env, GITHUB_OUTPUT: output }, encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stderr, /^suites=full: event push/m);
    const lines = readFileSync(output, 'utf8').split('\n');
    assert.equal(lines[0], 'earlier=1', 'appended, not overwritten');
    assert.ok(lines.includes('suites=full'));
    assert.ok(lines.includes(`guards=${GUARD_TESTS.join(' ')}`));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('every guard test exists, and every workflow test is a guard', () => {
  const orchestrator = join(ROOT, 'orchestrator');
  for (const file of GUARD_TESTS) {
    assert.ok(existsSync(join(orchestrator, file)), `${file} does not exist`);
    assert.doesNotMatch(file, /\s/, `${file}: the list is split on spaces`);
  }
  const workflowTests = readdirSync(join(ROOT, 'scripts', 'release')).filter((f) => f.endsWith('-workflow.test.mjs'));
  assert.ok(workflowTests.length >= 4);
  for (const file of workflowTests) assert.ok(GUARD_TESTS.includes(`../scripts/release/${file}`), `${file} is not a guard test`);
  const workflows = readdirSync(join(ROOT, '.github', 'workflows')).filter((f) => f.endsWith('.yml'));
  assert.ok(workflows.includes('ci.yml'));
});

const ci = readWorkflow('ci.yml');
const GUARD_RUNNER = "matrix.part.suite == 'daemon' && matrix.part.shard == '1/2'";

test('ci.yml: the changes job reads the merge commit against its base, without credentials', () => {
  assert.deepEqual([...ci.jobs().keys()], ['changes', 'test', 'docs']);
  assert.equal(ci.keyOf('changes', 'needs'), undefined);
  assert.equal(ci.keyOf('changes', 'if'), undefined, 'it runs on every event, the script decides');
  const checkout = ci.steps('changes')[0].join('\n');
  assert.match(checkout, /uses: actions\/checkout@/);
  assert.match(checkout, /fetch-depth: 2/);
  assert.match(checkout, /persist-credentials: false/);
  const decideStep = ci.stepNamed('changes', 'Decide which suites run');
  assert.match(decideStep, /id: decide/);
  assert.match(decideStep, /EVENT: \$\{\{ github\.event_name \}\}/);
  assert.match(decideStep, /run: node scripts\/ci-changes\.mjs --event "\$EVENT" --base HEAD\^1 --head HEAD$/m);
  assert.deepEqual(ci.blockOf('changes', 'outputs'), [
    '      suites: ${{ steps.decide.outputs.suites }}',
    '      guards: ${{ steps.decide.outputs.guards }}',
  ]);
});

test('ci.yml: the required checks keep their names and always run', () => {
  assert.equal(ci.keyOf('test', 'name'), "${{ matrix.os }} · ${{ matrix.part.suite }}${{ matrix.part.shard && format(' {0}', matrix.part.shard) || '' }}");
  assert.match(ci.job('test').join('\n'), /- \{ suite: daemon, shard: 1\/2 \}\n\s+- \{ suite: daemon, shard: 2\/2 \}\n\s+- \{ suite: app, shard: '' \}/);
  assert.equal(ci.keyOf('test', 'needs'), 'changes');
  // A failed `changes` must not skip the job: a skipped matrix never reports its checks.
  assert.equal(ci.keyOf('test', 'if'), '${{ !cancelled() }}');
  assert.match(ci.blockOf('test', 'env').join('\n'), /^ {6}SUITES: \$\{\{ needs\.changes\.outputs\.suites \}\}$/m);
});

test('ci.yml: every heavy step stands down on guards, and only the first daemon half runs the guards', () => {
  const ifOf = (step) => /^\s+if: (.*)$/m.exec(step.join('\n'))?.[1];
  const nameOf = (step) => /name: (.*)$/m.exec(step.join('\n'))?.[1] ?? /uses: (\S+)/.exec(step.join('\n'))?.[1];
  const always = ['actions/checkout@v4', 'Temporary Timon home'];
  const guardsToo = ['actions/setup-node@v4', 'Install the daemon'];
  const guardsOnly = ['Suites skipped', 'Test what the changed paths can break'];
  for (const step of ci.steps('test')) {
    const name = nameOf(step);
    const cond = ifOf(step);
    if (always.includes(name)) assert.equal(cond, undefined, name);
    else if (guardsToo.includes(name)) assert.equal(cond, `env.SUITES != 'guards' || (${GUARD_RUNNER})`, name);
    else if (guardsOnly.includes(name)) assert.match(cond, /^env\.SUITES == 'guards'/, name);
    else assert.match(cond ?? '', /^env\.SUITES != 'guards'( && |$)/, `${name} must stand down on guards`);
  }
  const guards = ci.stepNamed('test', 'Test what the changed paths can break');
  assert.match(guards, new RegExp(`if: env\\.SUITES == 'guards' && ${GUARD_RUNNER.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}$`, 'm'));
  assert.match(guards, /working-directory: orchestrator/);
  assert.match(guards, /GUARDS: \$\{\{ needs\.changes\.outputs\.guards \}\}/);
  assert.match(guards, /run: npm test -- \$GUARDS$/m);
});
