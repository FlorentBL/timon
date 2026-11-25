/**
 * Static checks on .github/workflows/nightly.yml: it builds the head of main
 * every night with the release's build steps, and must never publish, hold a
 * release key, enter a release environment, commit its version, or stand in
 * the way of a release on the shared Mac.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readWorkflow } from './workflow-text.mjs';

const wf = readWorkflow('nightly.yml');
const JOBS = ['prepare', 'build', 'report'];

test('nightly.yml runs at night and by hand, never on a push, a pull request or a tag', () => {
  const { names, block } = wf.triggers();
  assert.deepEqual(names, ['schedule', 'workflow_dispatch']);
  const cron = /^ {4}- cron: '([^']+)'$/m.exec(block)?.[1];
  assert.equal(cron, '0 2 * * *', 'around 02:00 UTC');
  assert.doesNotMatch(block, /inputs:/);
  for (const forbidden of ['push', 'pull_request', 'pull_request_target', 'workflow_run', 'issue_comment', 'repository_dispatch']) {
    assert.ok(!names.includes(forbidden), forbidden);
  }
});

test('only main of this repository is built, and every job hangs on the first one', () => {
  assert.deepEqual([...wf.jobs().keys()], JOBS);
  const first = wf.keyOf('prepare', 'if');
  assert.match(first, /github\.repository == 'ai-timon\/timon'/);
  assert.match(first, /github\.ref == 'refs\/heads\/main'/);
  assert.equal(wf.keyOf('build', 'needs'), 'prepare');
  assert.equal(wf.keyOf('report', 'needs'), '[prepare, build]');
  // The build checks out the commit prepare read, not whatever main is an hour later.
  assert.match(wf.blockOf('build', 'with').join('\n'), /sha: \$\{\{ needs\.prepare\.outputs\.sha \}\}/);
});

test('the build is the release one, with purpose nightly: every system, 3 days of artifacts', () => {
  assert.equal(wf.keyOf('build', 'uses'), './.github/workflows/build-packages.yml');
  const given = Object.fromEntries(wf.blockOf('build', 'with').map((line) => /^ {6}([a-z-]+):\s*(.*?)\s*$/.exec(line)).filter(Boolean).map((m) => [m[1], m[2]]));
  assert.deepEqual(given, {
    purpose: 'nightly',
    version: '${{ needs.prepare.outputs.version }}',
    sha: '${{ needs.prepare.outputs.sha }}',
    node: '${{ needs.prepare.outputs.node }}',
    expires: '${{ needs.prepare.outputs.expires }}',
    'fail-fast': 'false',
    'retention-days': '3',
  });
  assert.equal(wf.blockOf('build', 'secrets'), null, 'no secret passed to the build');
});

test('the version is x.y.(z+1)-nightly.<UTC date>, set on the runner and never committed', () => {
  const pick = wf.stepNamed('prepare', 'Pick the version');
  assert.match(pick, /version="\$\{BASH_REMATCH\[1\]\}\.\$\{BASH_REMATCH\[2\]\}\.\$\(\(BASH_REMATCH\[3\] \+ 1\)\)-nightly\.\$\(date -u \+%Y%m%d\)"/);
  assert.match(pick, /expires=\$\(date -u -d '\+14 days' \+%Y-%m-%d\)/);
  // A dry run refuses a bad request in a minute, before three runners spend an hour.
  assert.match(wf.stepNamed('prepare', 'Dry run of the package build'), /--version "\$VERSION" --channel beta --expires "\$EXPIRES" --output \.\.\/release-output --dry-run$/m);
  assert.doesNotMatch(wf.code, /git (commit|push|tag)\b|gh release|gh pr\b/);
});

test('nothing here publishes, signs for the public or enters a release environment', () => {
  assert.doesNotMatch(wf.code, /secrets\./);
  assert.doesNotMatch(wf.code, /environment:/);
  assert.doesNotMatch(wf.code, /release-build|\brelease\b:/);
  assert.doesNotMatch(wf.code, /publish\.mjs|--draft|attest-build-provenance|id-token|contents:\s*write/);
  assert.doesNotMatch(wf.code, /purpose: release/);
  assert.doesNotMatch(wf.code, /--publish\s+(always|onTag|onTagOrDraft)/);
});

test('permissions: read by default; the report job writes issues and nothing else', () => {
  assert.match(wf.text, /^permissions:\n {2}contents: read\n/m);
  assert.doesNotMatch(wf.code, /write-all|read-all/);
  const granted = (job) => wf.blockOf(job, 'permissions').map((line) => line.trim());
  assert.deepEqual(granted('prepare'), ['contents: read']);
  assert.deepEqual(granted('build'), ['contents: read']);
  assert.deepEqual(granted('report'), ['actions: read', 'issues: write']);
});

test('the report job runs no code of the repository and puts no secret in the issue', () => {
  const report = wf.job('report').join('\n');
  assert.doesNotMatch(report, /actions\/checkout@|actions\/setup-node@|\bnpm\b|\bnpx\b|\bnode\b/);
  // Not on a cancelled run: a nightly cancelled by a release on the Mac files nothing.
  assert.equal(wf.keyOf('report', 'if'), "${{ !cancelled() && github.repository == 'ai-timon/timon' && github.ref == 'refs/heads/main' }}");
  const step = wf.stepNamed('report', 'Open, update or close the nightly failure issue');
  const env = step.split('\n').map((line) => /^ {10}([A-Z_]+): (.+)$/.exec(line)).filter(Boolean).map((m) => [m[1], m[2].trim()]);
  assert.deepEqual(env.map(([name]) => name), ['GH_TOKEN', 'REPO', 'RUN_ID', 'RUN_URL', 'PREPARE', 'BUILD', 'VERSION', 'SHA']);
  assert.equal(Object.fromEntries(env).GH_TOKEN, '${{ github.token }}');
  for (const [name, value] of env.filter(([n]) => n !== 'GH_TOKEN')) assert.doesNotMatch(value, /secrets\.|token/i, name);
  // The token reaches gh only; the issue body is made of the run, the commit, the version and job names.
  const run = wf.runBlocks().find((block) => block.includes('gh issue list'));
  assert.ok(run);
  assert.doesNotMatch(run, /GH_TOKEN/);
  const body = /body=\$\(printf '([^']+)'/.exec(run)?.[1];
  assert.ok(body, 'no issue body');
  assert.doesNotMatch(body, /TOKEN|KEY|secret/i);
  assert.match(run, /"\$RUN_URL" "\$SHA" "\$\{VERSION:-not picked\}" "\$\{failed:-see the run\}"/);
  // One issue at a time: a failure comments on the open one, a pass closes it.
  assert.match(run, /title="Nightly build failed"/);
  assert.match(run, /select\(\.title == "Nightly build failed"\)/);
  assert.match(run, /gh issue comment -R "\$REPO" "\$number" --body "\$body"/);
  assert.match(run, /gh issue create -R "\$REPO" --title "\$title" --body "\$body"/);
  assert.match(run, /gh issue close -R "\$REPO" "\$number"/);
  assert.match(run, /if \[ "\$PREPARE" = failure \] \|\| \[ "\$BUILD" = failure \]; then/);
  assert.match(run, /elif \[ "\$PREPARE" = success \] && \[ "\$BUILD" = success \]; then/);
});

test('a release always goes first on the shared Mac', () => {
  // A nightly started by hand replaces the one in progress, never a release.
  assert.match(wf.text, /^concurrency:\n {2}group: nightly\n {2}cancel-in-progress: true\n/m);
  assert.doesNotMatch(wf.code, /group: release\b|timon-mac-runner/);
  // The Mac's own group lives in build-packages.yml, where a release leg cancels a nightly leg.
  const packages = readWorkflow('build-packages.yml');
  assert.match(packages.blockOf('build', 'concurrency').join('\n'), /cancel-in-progress: \$\{\{ inputs\.purpose == 'release' \}\}/);
});

test('every action is pinned, every checkout drops its credential, every job has a time limit', () => {
  const pins = wf.pins();
  assert.ok(pins.size >= 2);
  const release = readWorkflow('release.yml').pins();
  for (const [action, sha] of pins) if (release.has(action)) assert.equal(sha, release.get(action), `${action}: nightly.yml and release.yml disagree`);
  assert.deepEqual(wf.checkoutsKeepingCredentials(), []);
  for (const block of wf.runBlocks()) assert.doesNotMatch(block, /\$\{\{/, `expression inside run:\n${block}`);
  for (const job of JOBS) {
    if (wf.keyOf(job, 'uses')) continue;
    const limit = Number(wf.keyOf(job, 'timeout-minutes'));
    assert.ok(limit > 0 && limit <= 30, `job ${job}: timeout ${limit}`);
  }
});
