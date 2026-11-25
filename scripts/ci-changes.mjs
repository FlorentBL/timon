#!/usr/bin/env node
/**
 * Decides which suites .github/workflows/ci.yml runs for a pull request.
 *
 * Why: a two-line fix of `runs-on` in release.yml (24/11/2026) waited on the
 * whole daemon and app suites, half an hour, and held a release back. The
 * jobs `ubuntu-latest · daemon 1/2`, `· daemon 2/2` and `· app` are required by
 * the protection of main, so a `paths` filter on the workflow is no way out:
 * a required check that never starts stays pending and blocks the merge. The
 * jobs always start; their heavy steps read this decision.
 *
 *   suites=full     every suite runs (the default, and the answer to any doubt)
 *   suites=guards   only the tests that read the changed paths run
 *
 * `guards` needs every changed file to be on the list below. One file off the
 * list, an empty diff, a git error, a push or a manual run: `full`.
 *
 *   node scripts/ci-changes.mjs --event <github.event_name> --base <rev> --head <rev>
 *
 * Writes `suites=…` and `guards=…` to $GITHUB_OUTPUT (stdout without it).
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Paths no daemon or app code reads at run time. `public-docs/scripts/` is
 * left out: the daemon runs export-markdown.mjs for its local docs, and its
 * tests import the generators.
 */
export function isSkippable(path) {
  if (path.startsWith('.github/workflows/')) return true;
  if (path.startsWith('changes/')) return true;
  if (path.startsWith('public-docs/')) return !path.startsWith('public-docs/scripts/');
  return !path.includes('/') && path.endsWith('.md');
}

/**
 * The tests that read the skippable paths, relative to orchestrator/ where
 * `npm test` runs them: they stay on when the suites are skipped. They take
 * seconds, the suites half an hour.
 */
export const GUARD_TESTS = [
  // This decision itself, and the static checks of every workflow.
  '../scripts/ci-changes.test.mjs',
  '../scripts/release/build-packages-workflow.test.mjs',
  '../scripts/release/nightly-workflow.test.mjs',
  '../scripts/release/rc-workflow.test.mjs',
  '../scripts/release/release-workflow.test.mjs',
  // changes/ and CHANGELOG.md.
  '../scripts/changelog-fragments.test.mjs',
  'src/release-notes.test.ts',
  // public-docs/: generated pages, the publication policy, the pages skills name.
  '../public-docs/scripts/generated-docs.test.mjs',
  '../public-docs/scripts/doc-policy.test.mjs',
  'src/skills-bundled.test.ts',
  // English across the public tree: Markdown and YAML included.
  'src/english-tree.test.ts',
];

/** `guards` when every changed file is skippable, `full` otherwise. */
export function decide(files) {
  if (files.length === 0) return { suites: 'full', reason: 'no changed file found' };
  const kept = files.filter((file) => !isSkippable(file));
  if (kept.length > 0) return { suites: 'full', reason: `${kept.length} changed file(s) outside the skippable paths, first ${kept[0]}` };
  return { suites: 'guards', reason: `${files.length} changed file(s), all workflows, documentation or changelog fragments` };
}

/**
 * The files changed between two revisions. `--no-renames`: a rename lists
 * both its old and its new path, so moving code into public-docs/ is still
 * seen as a change of the code. `-z`: names arrive unquoted.
 */
export function changedFiles(base, head, cwd = ROOT) {
  const out = execFileSync('git', ['diff', '--name-only', '--no-renames', '-z', base, head], { cwd, encoding: 'utf8' });
  return out.split('\0').filter(Boolean);
}

export function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const m = /^--(event|base|head)$/.exec(argv[i]);
    if (!m) throw new Error(`unknown argument: ${argv[i]}`);
    if (i + 1 >= argv.length) throw new Error(`${argv[i]} needs a value`);
    args[m[1]] = argv[++i];
  }
  return args;
}

/** The decision for a run; never throws, any doubt runs everything. */
export function decideRun(argv, cwd = ROOT) {
  try {
    const { event, base, head } = parseArgs(argv);
    if (event !== 'pull_request') return { suites: 'full', reason: `event ${event ?? '(none)'} always runs every suite` };
    if (!base || !head) return { suites: 'full', reason: '--base and --head are required' };
    return decide(changedFiles(base, head, cwd));
  } catch (err) {
    return { suites: 'full', reason: `could not read the changes: ${err instanceof Error ? err.message : String(err)}` };
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const { suites, reason } = decideRun(process.argv.slice(2));
  console.error(`suites=${suites}: ${reason}`);
  const output = `suites=${suites}\nguards=${GUARD_TESTS.join(' ')}\n`;
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, output);
  else process.stdout.write(output);
}
