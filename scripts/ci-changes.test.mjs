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
import { GUARD_TESTS, changedEntries, changedFiles, decide, decideRun, isClassifier, isSkippable, parseArgs } from './ci-changes.mjs';
import { readWorkflow } from './release/workflow-text.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(ROOT, 'scripts', 'ci-changes.mjs');

test('only documentation pages and images, changelog fragments and root Markdown are skippable', () => {
  for (const path of [
    'public-docs/docs/usage/agents.md', 'public-docs/docs/intro.mdx', 'public-docs/docs/a/b/c/shot.png',
    'public-docs/docs/img/logo.svg', 'public-docs/docs/x.jpg', 'public-docs/docs/x.webp',
    'changes/fix-something.md', 'changes/README.md',
    'README.md', 'CHANGELOG.md', 'AGENTS.md', 'CONTRIBUTING.md',
  ]) assert.equal(isSkippable(path), true, path);
  for (const path of [
    // Workflows, actions, hooks, the protected paths list: all of .github/.
    '.github/workflows/release.yml', '.github/workflows/ci.yml', '.github/protected-paths', '.github/CODEOWNERS',
    '.github/actions/setup/action.yml', '.github/workflows', '.githooks/pre-commit',
    // The docs site runs its config, plugins, scripts and dependencies at build time.
    'public-docs/docusaurus.config.ts', 'public-docs/plugins/markdown-export.mjs', 'public-docs/package.json',
    'public-docs/package-lock.json', 'public-docs/scripts/export-markdown.mjs', 'public-docs/sidebars.ts',
    'public-docs/src/css/custom.css', 'public-docs/static/img/logo.png', 'public-docs/README.md',
    'public-docs/docs/_category_.json', 'public-docs/docs/components/Widget.tsx', 'public-docs/docs/x.jpeg',
    'public-docs/docs/x.MD', 'public-docs/docs/', 'public-docs/docs/../plugins/a.md',
    // Scripts, helpers, manifests, locks, test configs.
    'scripts/ci-changes.mjs', 'scripts/release/workflow-text.mjs', 'scripts/bump-version.mjs', 'package.json',
    'package-lock.json', 'orchestrator/package.json', 'app/package-lock.json', 'app/vitest.config.ts',
    'orchestrator/scripts/run-tests.mjs',
    // Markdown below the root is read by the product (skills, prompts, agent docs).
    'orchestrator/skills/timon-task/SKILL.md', 'docs/PROGRESS.md', 'app/README.md', 'changes/sub/x.md',
    // Look-alikes.
    'public-docs', 'changes', 'changes.md.ts', 'changes/x.mdx', 'README.mdx', 'LICENSE', 'orchestrator/src/index.ts',
  ]) assert.equal(isSkippable(path), false, path);
});

test('the suites are skipped only when every change is inert content', () => {
  assert.equal(decide(['public-docs/docs/a.md']).suites, 'guards');
  assert.equal(decide(['public-docs/docs/a.md', 'changes/x.md', 'README.md', 'public-docs/docs/i/a.png']).suites, 'guards');
  const mixed = decide(['public-docs/docs/a.md', 'orchestrator/src/index.ts', 'changes/x.md']);
  assert.equal(mixed.suites, 'full');
  assert.match(mixed.reason, /orchestrator\/src\/index\.ts/);
  assert.equal(decide(['public-docs/scripts/gen-cli.mjs']).suites, 'full');
  assert.equal(decide(['public-docs/plugins/markdown-export.mjs']).suites, 'full');
  assert.equal(decide([]).suites, 'full', 'an empty diff proves nothing');
});

test('the classifier never judges itself: a change to it or to .github/ runs everything', () => {
  for (const path of ['scripts/ci-changes.mjs', '.github/workflows/ci.yml', '.github/protected-paths', '.github/actions/a/action.yml']) {
    const run = decide(['README.md', path]);
    assert.equal(run.suites, 'full', path);
    assert.match(run.reason, /classifier or a workflow/, path);
    assert.equal(isClassifier(path), true, path);
  }
  assert.equal(isClassifier('scripts/ci-changes.test.mjs'), false);
});

test('only plain files on both sides: a link, a submodule or an executable runs everything', () => {
  const page = 'public-docs/docs/a.md';
  assert.equal(decide([{ path: page, oldMode: '000000', newMode: '100644' }]).suites, 'guards', 'added');
  assert.equal(decide([{ path: page, oldMode: '100644', newMode: '000000' }]).suites, 'guards', 'deleted');
  for (const [oldMode, newMode] of [['000000', '120000'], ['100644', '120000'], ['120000', '100644'], ['000000', '160000'], ['160000', '000000'], ['100644', '100755']]) {
    const run = decide([{ path: page, oldMode, newMode }]);
    assert.equal(run.suites, 'full', `${oldMode} -> ${newMode}`);
    assert.match(run.reason, /not a plain file/);
  }
  assert.equal(decide([{ path: 'orchestrator/src/index.ts', oldMode: '100644', newMode: '000000' }]).suites, 'full', 'a deletion off the list');
});

test('the classifier runs alone from a temporary folder: Node built-ins only', () => {
  const source = readFileSync(SCRIPT, 'utf8');
  const imports = [...source.matchAll(/^import .* from '([^']+)';$/gm)].map((m) => m[1]);
  assert.ok(imports.length > 0);
  for (const name of imports) assert.match(name, /^node:/, name);
  assert.doesNotMatch(source, /\bimport\(/, 'no dynamic import');
});

test('arguments are strict: an unknown or valueless one is refused', () => {
  assert.deepEqual(parseArgs(['--event', 'pull_request', '--base', 'a', '--head', 'b']), { event: 'pull_request', base: 'a', head: 'b' });
  assert.throws(() => parseArgs(['--skip']), /unknown argument/);
  assert.throws(() => parseArgs(['--base']), /needs a value/);
});

/** A throwaway repository: a base commit with code, then the given changes in a second one. */
function repoWith(change, { stage = true } = {}) {
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
  if (stage) git('add', '-A');
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

/** Stages `path` as `mode` straight in the index: a link, a submodule or an odd name, on any system. */
function stageEntry(git, mode, path, content = 'x\n') {
  const sha = mode === '160000'
    ? '0123456789abcdef0123456789abcdef01234567'
    : execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: git.cwd, input: content, encoding: 'utf8' }).trim();
  git('update-index', '--add', '--cacheinfo', `${mode},${sha},${path}`);
}

test('the diff reads deletions, links, submodules and names with a line feed', () => {
  const run = (dir) => decideRun(['--event', 'pull_request', '--base', 'HEAD^1', '--head', 'HEAD'], dir);
  const repo = (change) => repoWith((dir, git) => { git.cwd = dir; change(dir, git); }, { stage: false });
  const dirs = [];
  try {
    const deletedPage = repo((_dir, git) => git('rm', '-q', 'public-docs/docs/a.md'));
    const deletedCode = repo((_dir, git) => git('rm', '-q', 'orchestrator/src/guide.ts'));
    const link = repo((_dir, git) => stageEntry(git, '120000', 'public-docs/docs/link.md', '../../orchestrator/src/guide.ts'));
    const submodule = repo((_dir, git) => stageEntry(git, '160000', 'public-docs/docs/sub.md'));
    const lineFeed = repo((_dir, git) => stageEntry(git, '100644', 'public-docs/docs/a\nb.md'));
    const forged = repo((_dir, git) => stageEntry(git, '100644', 'public-docs/docs/a.md\norchestrator/src/x.ts'));
    const plugin = repo((dir, git) => {
      mkdirSync(join(dir, 'public-docs', 'plugins'), { recursive: true });
      writeFileSync(join(dir, 'public-docs', 'plugins', 'markdown-export.mjs'), 'export default {};\n');
      git('add', '-A');
    });
    dirs.push(deletedPage, deletedCode, link, submodule, lineFeed, forged, plugin);

    assert.deepEqual(changedEntries('HEAD^1', 'HEAD', deletedPage), [{ path: 'public-docs/docs/a.md', oldMode: '100644', newMode: '000000' }]);
    assert.equal(run(deletedPage).suites, 'guards');
    assert.deepEqual(changedFiles('HEAD^1', 'HEAD', deletedCode), ['orchestrator/src/guide.ts']);
    assert.equal(run(deletedCode).suites, 'full', 'a deletion off the list');

    assert.deepEqual(changedEntries('HEAD^1', 'HEAD', link), [{ path: 'public-docs/docs/link.md', oldMode: '000000', newMode: '120000' }]);
    assert.match(run(link).reason, /not a plain file/);
    assert.equal(run(link).suites, 'full');
    assert.deepEqual(changedEntries('HEAD^1', 'HEAD', submodule), [{ path: 'public-docs/docs/sub.md', oldMode: '000000', newMode: '160000' }]);
    assert.equal(run(submodule).suites, 'full');

    assert.deepEqual(changedFiles('HEAD^1', 'HEAD', lineFeed), ['public-docs/docs/a\nb.md']);
    assert.equal(run(lineFeed).suites, 'guards');
    assert.deepEqual(changedFiles('HEAD^1', 'HEAD', forged), ['public-docs/docs/a.md\norchestrator/src/x.ts']);
    assert.equal(run(forged).suites, 'full', 'one name, not two lines');

    assert.equal(run(plugin).suites, 'full');
  } finally {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  }
});

test('the command reads the repository it runs in, not the one it lives in', () => {
  const dir = repoWith((d) => writeFileSync(join(d, 'NOTES.md'), 'x\n'));
  const elsewhere = mkdtempSync(join(tmpdir(), 'ci-changes-copy-'));
  try {
    const copy = join(elsewhere, 'ci-changes.mjs');
    writeFileSync(copy, readFileSync(SCRIPT));
    const run = spawnSync(process.execPath, [copy, '--event', 'pull_request', '--base', 'HEAD^1', '--head', 'HEAD'], { cwd: dir, env: { ...process.env, GITHUB_OUTPUT: '' }, encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /^suites=guards$/m);
  } finally {
    for (const d of [dir, elsewhere]) rmSync(d, { recursive: true, force: true });
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

test('every guard test exists and reads inert content, not the workflows', () => {
  const orchestrator = join(ROOT, 'orchestrator');
  for (const file of GUARD_TESTS) {
    assert.ok(existsSync(join(orchestrator, file)), `${file} does not exist`);
    assert.doesNotMatch(file, /\s/, `${file}: the list is split on spaces`);
    assert.doesNotMatch(file, /workflow|ci-changes/, `${file}: a change to .github/ or the classifier runs every suite`);
  }
});

const ci = readWorkflow('ci.yml');

test('ci.yml: the changes job runs the base\'s classifier on the merge commit, without credentials', () => {
  assert.deepEqual([...ci.jobs().keys()], ['changes', 'test', 'docs']);
  assert.equal(ci.keyOf('changes', 'needs'), undefined);
  assert.equal(ci.keyOf('changes', 'if'), undefined, 'it runs on every event, the script decides');
  assert.deepEqual(ci.blockOf('changes', 'permissions'), null, 'the workflow\'s contents: read applies');
  const checkout = ci.steps('changes')[0].join('\n');
  assert.match(checkout, /uses: actions\/checkout@/);
  assert.match(checkout, /fetch-depth: 2/);
  assert.match(checkout, /persist-credentials: false/);
  const decideStep = ci.stepNamed('changes', 'Decide which suites run');
  assert.match(decideStep, /id: decide/);
  assert.match(decideStep, /EVENT: \$\{\{ github\.event_name \}\}/);
  const lines = decideStep.split('\n');
  const run = lines.slice(lines.findIndex((line) => /^ {8}run: \|$/.test(line)) + 1).map((line) => line.trim()).filter(Boolean);
  assert.deepEqual(run, [
    'if ! git cat-file -e HEAD^1:scripts/ci-changes.mjs 2>/dev/null; then',
    'echo "::notice title=Every suite runs::The base has no scripts/ci-changes.mjs yet: nothing decides, so no suite is skipped."',
    'echo "suites=full" >> "$GITHUB_OUTPUT"',
    'exit 0',
    'fi',
    'git show HEAD^1:scripts/ci-changes.mjs > "$RUNNER_TEMP/ci-changes.mjs"',
    'node "$RUNNER_TEMP/ci-changes.mjs" --event "$EVENT" --base HEAD^1 --head HEAD',
  ], 'the copy of the base, never scripts/ci-changes.mjs of the checkout');
  assert.doesNotMatch(ci.job('changes').join('\n'), /node scripts\/ci-changes/);
  assert.deepEqual(ci.blockOf('changes', 'outputs'), [
    '      suites: ${{ steps.decide.outputs.suites }}',
    '      guards: ${{ steps.decide.outputs.guards }}',
  ]);
});

/** The shell of the `Decide which suites run` step, as the runner gets it. */
function decideScript() {
  const lines = ci.stepNamed('changes', 'Decide which suites run').split('\n');
  return lines.slice(lines.findIndex((line) => /^ {8}run: \|$/.test(line)) + 1).map((line) => line.replace(/^ {10}/, '')).join('\n');
}

/** Runs the step in `dir` as GitHub's `bash -e` does: its exit status, its log, what it wrote to $GITHUB_OUTPUT. */
function runDecideStep(dir) {
  const temp = mkdtempSync(join(tmpdir(), 'ci-changes-runner-'));
  try {
    const output = join(temp, 'output');
    writeFileSync(output, '');
    const run = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', decideScript()], {
      cwd: dir, encoding: 'utf8', env: { ...process.env, EVENT: 'pull_request', RUNNER_TEMP: temp, GITHUB_OUTPUT: output },
    });
    return { status: run.status, log: `${run.stdout}${run.stderr}`, output: readFileSync(output, 'utf8') };
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

test('ci.yml: the pull request that adds the classifier runs every suite, says so, and does not fail', { skip: process.platform === 'win32' }, () => {
  const dir = repoWith((d) => {
    mkdirSync(join(d, 'scripts'), { recursive: true });
    writeFileSync(join(d, 'scripts', 'ci-changes.mjs'), 'throw new Error("the copy of the pull request must not run");\n');
  });
  try {
    const run = runDecideStep(dir);
    assert.equal(run.status, 0, run.log);
    assert.equal(run.output, 'suites=full\n');
    assert.match(run.log, /::notice title=Every suite runs::The base has no scripts\/ci-changes\.mjs yet/);
    assert.doesNotMatch(run.log, /must not run/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ci.yml: with the classifier in the base, the step runs the base\'s copy, not the pull request\'s', { skip: process.platform === 'win32' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'ci-changes-'));
  const git = (...args) => execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd: dir, encoding: 'utf8' });
  try {
    git('init', '-q');
    mkdirSync(join(dir, 'scripts'), { recursive: true });
    writeFileSync(join(dir, 'scripts', 'ci-changes.mjs'), readFileSync(SCRIPT));
    git('add', '-A');
    git('commit', '-q', '-m', 'base');
    // A pull request that only edits a page, and rewrites the classifier to say `guards` whatever it sees.
    mkdirSync(join(dir, 'public-docs', 'docs'), { recursive: true });
    writeFileSync(join(dir, 'public-docs', 'docs', 'a.md'), '# A\n');
    writeFileSync(join(dir, 'scripts', 'ci-changes.mjs'), 'console.log("suites=guards");\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'change');
    const run = runDecideStep(dir);
    assert.equal(run.status, 0, run.log);
    assert.match(run.output, /^suites=full$/m, 'the base\'s classifier sees its own change and runs everything');
    assert.doesNotMatch(run.log, /Every suite runs::/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ci.yml: the required checks keep their names, are never skipped, and guards needs a successful changes job', () => {
  assert.equal(ci.keyOf('test', 'name'), "${{ matrix.os }} · ${{ matrix.part.suite }}${{ matrix.part.shard && format(' {0}', matrix.part.shard) || '' }}");
  assert.match(ci.job('test').join('\n'), /- \{ suite: daemon, shard: 1\/2 \}\n\s+- \{ suite: daemon, shard: 2\/2 \}\n\s+- \{ suite: app, shard: '' \}/);
  assert.equal(ci.keyOf('test', 'needs'), 'changes');
  // A skipped job counts as passed: not on a failed `changes`, not on a cancelled run.
  assert.equal(ci.keyOf('test', 'if'), '${{ always() }}');
  assert.match(ci.blockOf('test', 'env').join('\n'), /^ {6}SUITES: \$\{\{ needs\.changes\.result == 'success' && needs\.changes\.outputs\.suites == 'guards' && 'guards' \|\| 'full' \}\}$/m);
  assert.doesNotMatch(ci.job('test').join('\n'), /needs\.changes\.outputs\.suites(?! == 'guards' && 'guards' \|\| 'full')/, 'SUITES is the only reader of the raw output');
});

test('ci.yml: every heavy step stands down on guards, and every required job runs the guards instead', () => {
  const ifOf = (step) => /^\s+if: (.*)$/m.exec(step.join('\n'))?.[1];
  const nameOf = (step) => /name: (.*)$/m.exec(step.join('\n'))?.[1] ?? /uses: (\S+)/.exec(step.join('\n'))?.[1];
  const always = ['actions/checkout@v4', 'Temporary Timon home', 'actions/setup-node@v4', 'Install the daemon'];
  const guardsOnly = ['Suites skipped', 'Test what the changed paths can break'];
  const steps = ci.steps('test');
  for (const step of steps.slice(0, -1)) {
    const name = nameOf(step);
    const cond = ifOf(step);
    if (always.includes(name)) assert.equal(cond, undefined, name);
    else if (guardsOnly.includes(name)) assert.equal(cond, "env.SUITES == 'guards'", name);
    else assert.match(cond ?? '', /^env\.SUITES != 'guards'( && |$)/, `${name} must stand down on guards`);
  }
  const guards = ci.stepNamed('test', 'Test what the changed paths can break');
  assert.match(guards, /id: guards$/m);
  assert.match(guards, /working-directory: orchestrator/);
  assert.match(guards, /GUARDS: \$\{\{ needs\.changes\.outputs\.guards \}\}/);
  assert.match(guards, /run: npm test -- \$GUARDS$/m);
  assert.match(ci.stepNamed('test', 'Test the daemon'), /id: daemon$/m);
  assert.match(ci.stepNamed('test', 'Test the web app'), /id: app$/m);
});

test('ci.yml: the last step fails the check unless the suites or the guards passed', () => {
  const last = ci.steps('test').at(-1).join('\n');
  assert.match(last, /name: Verdict$/m);
  assert.match(last, /if: \$\{\{ always\(\) \}\}$/m);
  for (const [key, id] of [['DAEMON', 'daemon'], ['APP', 'app'], ['GUARDS', 'guards']]) {
    assert.match(last, new RegExp(`${key}: \\$\\{\\{ steps\\.${id}\\.outcome \\}\\}$`, 'm'));
  }
  assert.match(last, /guards\/\*\) outcome="\$GUARDS" ;;/);
  assert.match(last, /full\/daemon\) outcome="\$DAEMON" ;;/);
  assert.match(last, /full\/app\) outcome="\$APP" ;;/);
  assert.match(last, /\*\) outcome="" ;;/);
  assert.match(last, /if \[ "\$outcome" != success \]; then/);
  assert.match(last, /exit 1/);
});
