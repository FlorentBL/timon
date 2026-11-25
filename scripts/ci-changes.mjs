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
 * `guards` needs every changed file to be inert content on the closed list
 * below, a plain file on both sides of the change. One file off the list, a
 * deletion off the list, a symbolic link, a submodule, a change to this script
 * or to .github/, an empty diff, a git error, a push or a manual run: `full`.
 *
 *   node scripts/ci-changes.mjs --event <github.event_name> --base <rev> --head <rev>
 *
 * It reads the repository of the current directory, not the one it lives in:
 * ci.yml runs the copy the base holds (`git show <base>:scripts/ci-changes.mjs`)
 * from a temporary folder, so a pull request never decides with its own copy.
 * Writes `suites=…` and `guards=…` to $GITHUB_OUTPUT (stdout without it).
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The classifier and the workflows: a pull request that changes them cannot be
 * judged by them. ci.yml runs this script as the base has it, never as the
 * pull request would have it, and a pull request touching these paths runs
 * every suite whatever it brings besides.
 */
export function isClassifier(path) {
  return path === 'scripts/ci-changes.mjs' || path.startsWith('.github/');
}

const DOC_PAGE = /^public-docs\/docs\/(?:[^/]+\/)*[^/]+\.(?:md|mdx|png|jpg|svg|webp)$/;
const FRAGMENT = /^changes\/[^/]+\.md$/;
const ROOT_MARKDOWN = /^[^/]+\.md$/;

/**
 * Inert content: pages and images of the public documentation, changelog
 * fragments, Markdown at the root. A closed list: everything else, the docs
 * site's config, plugins and scripts, manifests, locks, workflows, scripts and
 * helpers, is code something runs, and runs every suite.
 */
export function isSkippable(path) {
  if (path.split('/').some((part) => part === '' || part === '.' || part === '..')) return false;
  return DOC_PAGE.test(path) || FRAGMENT.test(path) || ROOT_MARKDOWN.test(path);
}

/**
 * The tests that read the skippable paths, relative to orchestrator/ where
 * `npm test` runs them: they stay on when the suites are skipped. They take
 * seconds, the suites half an hour.
 */
export const GUARD_TESTS = [
  // changes/ and CHANGELOG.md.
  '../scripts/changelog-fragments.test.mjs',
  'src/release-notes.test.ts',
  // public-docs/docs/: generated pages, the publication policy, the pages skills name.
  '../public-docs/scripts/generated-docs.test.mjs',
  '../public-docs/scripts/doc-policy.test.mjs',
  'src/skills-bundled.test.ts',
  // English across the public tree: Markdown included.
  'src/english-tree.test.ts',
];

/** Git's mode of an absent side (an added or deleted file) and of a plain file. */
const ABSENT = '000000';
const REGULAR = '100644';

/**
 * `guards` when every change is a plain file on the list, `full` otherwise.
 * A change is `{ path, oldMode, newMode }`; a bare path stands for a plain
 * file modified in place. A symbolic link (120000) or a submodule (160000)
 * points elsewhere, an executable file runs: none is inert content, on either
 * side of the change.
 */
export function decide(changes) {
  const list = changes.map((c) => (typeof c === 'string' ? { path: c, oldMode: REGULAR, newMode: REGULAR } : c));
  if (list.length === 0) return { suites: 'full', reason: 'no changed file found' };
  const classifier = list.find((c) => isClassifier(c.path));
  if (classifier) return { suites: 'full', reason: `the pull request changes the classifier or a workflow: ${classifier.path}` };
  const special = list.find((c) => ![ABSENT, REGULAR].includes(c.oldMode) || ![ABSENT, REGULAR].includes(c.newMode));
  if (special) return { suites: 'full', reason: `${special.path} is not a plain file (mode ${special.oldMode} -> ${special.newMode})` };
  const kept = list.filter((c) => !isSkippable(c.path));
  if (kept.length > 0) return { suites: 'full', reason: `${kept.length} changed file(s) outside the inert content, first ${kept[0].path}` };
  return { suites: 'guards', reason: `${list.length} changed file(s), all documentation pages, changelog fragments or root Markdown` };
}

/**
 * The changes between two revisions, with both modes. `--raw -z`: one
 * `:oldmode newmode oldsha newsha status` record, then its path, each ended by
 * NUL, so a name holds any byte but NUL. `--no-renames`: a rename lists its old
 * path as a deletion and its new one as an addition, so moving code into
 * public-docs/ is still a change of the code. `--ignore-submodules=none`: a
 * submodule always shows, whatever the configuration says.
 */
export function changedEntries(base, head, cwd = ROOT) {
  const out = execFileSync('git', ['diff', '--raw', '-z', '--no-renames', '--no-abbrev', '--ignore-submodules=none', base, head], { cwd, encoding: 'utf8' });
  const fields = out.split('\0');
  if (fields.at(-1) === '') fields.pop();
  if (fields.length % 2 !== 0) throw new Error('unexpected git diff --raw output');
  const entries = [];
  for (let i = 0; i < fields.length; i += 2) {
    const m = /^:([0-7]{6}) ([0-7]{6}) [0-9a-f]+ [0-9a-f]+ [A-Z][0-9]*$/.exec(fields[i]);
    if (!m || !fields[i + 1]) throw new Error(`unexpected git diff --raw record: ${JSON.stringify(fields[i])}`);
    entries.push({ path: fields[i + 1], oldMode: m[1], newMode: m[2] });
  }
  return entries;
}

/** The paths changed between two revisions. */
export function changedFiles(base, head, cwd = ROOT) {
  return changedEntries(base, head, cwd).map((entry) => entry.path);
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
    return decide(changedEntries(base, head, cwd));
  } catch (err) {
    return { suites: 'full', reason: `could not read the changes: ${err instanceof Error ? err.message : String(err)}` };
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const { suites, reason } = decideRun(process.argv.slice(2), process.cwd());
  console.error(`suites=${suites}: ${reason}`);
  const output = `suites=${suites}\nguards=${GUARD_TESTS.join(' ')}\n`;
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, output);
  else process.stdout.write(output);
}
