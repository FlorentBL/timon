# Releasing Timon

How the maintainers build, publish and verify a version of Timon. Every
package is built by GitHub Actions in this repository, on a GitHub-hosted
runner for each system, from a commit of `main`. Nobody builds a published
package on their own machine.

Three workflows do the work:

| Workflow | Starts | Publishes | Signed with |
|---|---|---|---|
| [`rc.yml`](.github/workflows/rc.yml), *Release candidate* | by hand, from the Actions tab | nothing | a throwaway key made on the runner |
| [`release.yml`](.github/workflows/release.yml), *Release* | when a version bump lands on `main` | the GitHub release and the signed release lists | the release key, after a maintainer's approval |
| [`nightly.yml`](.github/workflows/nightly.yml), *Nightly build* | every night at 02:00 UTC, or by hand | nothing | a throwaway key made on the runner |

The release and the nightly build share their build steps:
[`build-packages.yml`](.github/workflows/build-packages.yml), a reusable
workflow, builds the three systems for both. The release candidate and the
release attest the build provenance of every installer they produce: see
[Verify a package](#verify-a-package).

## Release a version

### 1. The version pull request

From an up-to-date `main`:

```bash
node scripts/changelog-fragments.mjs --check
node scripts/bump-version.mjs patch        # or minor, major, or an explicit x.y.z
(cd public-docs && node scripts/gen-changelog.mjs)
```

`bump-version.mjs` sets the same version in the three `package.json` files and
writes the fragments of `changes/` into the new section of `CHANGELOG.md`; the
last line regenerates the changelog page of the documentation, which the
checks compare with `CHANGELOG.md`. Commit as `chore(release): x.y.z`, open the
pull request and merge it once the required checks are green.

The version must be final (`x.y.z`). A release candidate never goes through
this path: it is built by `rc.yml` and never bumps `main`.

### 2. The workflow starts by itself

The merge changes `orchestrator/package.json` on `main`, which starts
*Release*. Its jobs:

| Job | Environment | What it does |
|---|---|---|
| `check` | none | Reads the version. Goes on only if it changed with this push, is final, and has no `v<version>` tag yet; otherwise it ends there, and so does the run. Pins the commit, then dry-runs the package build to refuse a bad request in a minute. |
| `build / build · linux`, `mac`, `windows` | `release-build` | Runs `build-packages.yml`, the build the nightly runs too. Builds one system each with [`scripts/release/build-package.mjs`](scripts/release/build-package.mjs): channel `stable`, no expiry, the daemon signed with the release key. Checks first that the key is the one installed clients pin. One failed system stops the release: a channel names one version for every system. |
| `attest · <os>` | none | Checks the installers against the `SHA256SUMS` their build wrote, then attests their provenance. Runs no npm and none of the built code. |
| `draft release` | none | Gathers the three builds and creates the **draft** release `v<version>` with its installers and its notes (the changelog section). Holds no signing key. |
| `publish the release` | `release` | Waits for a maintainer's approval. Then signs the two release lists in memory, checks them against the keys the clients pin, publishes the release (which creates the tag `v<version>` on the built commit), and opens the pull request that brings the lists to `main`, with auto-merge on. |

### 3. Review, then approve

While `publish the release` waits:

- open the draft on the [Releases](https://github.com/ai-timon/timon/releases)
  page: three systems, the installers the one-line installers need (`.deb` and
  `.AppImage`, `.pkg`, the Windows setup program), the notes you expect;
- if the version needs a test on real machines, download the installers from
  the draft, or from the run's artifacts, and install them;
- then, in the run, **Review deployments** › `release` › **Approve and
  deploy**. To stop the release, reject it: nothing is public yet, and the
  draft can be deleted.

The approval can wait up to 30 days, the time the build artifacts are kept.

### 4. The release lists reach `main`

The last step opens the pull request `chore(release): publish the x.y.z
release lists`, which changes `releases.json` and `releases-install.json` only,
and turns its auto-merge on. Once its required checks pass it merges, and the
website serves the two lists from `main`; installed apps then offer the
update. Check that the website serves what was signed:

```bash
for f in releases releases-install; do
  curl -fsS "https://timon-ai.com/.well-known/timon-$f.json" | cmp - "$f.json" && echo "$f ok"
done
```

Run it at the root of an up-to-date `main`. The website may take a few minutes
to catch up.

### When something fails

- **A build failed.** Nothing is public. Re-run the failed jobs of the run, or
  start *Release* by hand (Actions › Release › Run workflow, on `main`): a
  manual run releases the version `main` carries, as long as it has no tag. It
  builds the head of `main` at that moment.
- **The run stopped after the draft.** Start it by hand: the draft is
  completed, not duplicated.
- **`publish the release` failed after the release went public.** Re-run that
  job (it asks for the approval again): it finds the published release as it
  is, signs the lists again and replaces the branch of their pull request
  rather than opening a second one. A manual run would not help: the tag
  exists, so `check` stops there.
- **The release-lists pull request did not merge.** Look at its checks; the
  release itself is already public.
- A published asset never changes. A wrong package is fixed by a new version.

## Build a release candidate

A release candidate (`x.y.z-rc.N`) is a complete package of all three systems,
for testing before a release. It is never published and never bumps `main`.

Actions › **Release candidate** › **Run workflow**:

| Input | Meaning |
|---|---|
| `version` | `x.y.z-rc.N`, above the version the ref carries |
| `ref` | branch, tag or full sha to build; empty builds the commit the workflow runs from, the only one the attestation names |
| `channel` | `beta` (default) or `stable`, written into the build |
| `expires` | an ISO 8601 date; empty means 90 days; `never` is refused on `beta` |

Its jobs: `validate the request` (version, commit, Node version, a dry run),
`build · <os>` for each system, `attest · <os>`, and `recap`, which writes the
installers with their size and SHA-256 into the run summary. The systems are
independent: a failed one leaves the others built and attested, and the recap
says which one is missing. The installers stay the run's artifacts for 30 days.

A release candidate reads no secret: each build signs its daemon with a key
pair made on the runner. Such a package starts and runs normally and takes a
published update, but it is not a trusted build: it must never be published.
Release the version with *Release* instead.

## The nightly build

Every night at 02:00 UTC, *Nightly build* builds the head of `main` on the
three systems with the very steps of a release, so a packaging break (a runner
image that changes, a tool that disappears, a native module tied to the
runner) shows up the morning after it lands rather than on the day of a
release. The state of the project's Mac is the one thing it does not check:
only a release builds there.

Its jobs: `pick the nightly version` (names the build
`x.y.(z+1)-nightly.YYYYMMDD` after the version `main` carries, UTC date, and
dry-runs the package build), `build / build · <os>` (`build-packages.yml`:
channel `beta`, a 14-day expiry, every system built even when one fails), and
`report the result`. The version is written into the runner's checkout only:
never committed, never tagged. The installers stay the run's artifacts for
3 days; nothing is attested, drafted or published.

A failed night opens an issue titled *Nightly build failed*, or comments on the
one already open, with the run, the commit, the version and the failed jobs; a
night that passes again closes it. A nightly build reads no secret: it runs in
the `nightly-build` environment, which holds none, and signs each daemon with a
key pair made on the runner, like a release candidate. Like one, it is not a
trusted build. Its version is not one the updater of an installed Timon reads:
install one to look at a package, not to keep it.

Its macOS build runs on `macos-15`, an Apple Silicon runner hosted by GitHub
and new at every run, never on the project's Mac that builds releases: that
Mac keeps its account and its disk between runs, and the dependencies of an
unreleased `main` must not run where the release key is used. A nightly
therefore never waits for a release, nor takes its place in a queue, and does
not need the `release-mac` runner group. A nightly that lands on a self-hosted
runner anyway stops before it checks anything out. Start one by hand from the
Actions tab (*Nightly build* › *Run workflow*, on `main`) to check a fix before
the next night.

## Publish an announcement

An announcement reaches the installed apps without a release: a signed list,
`timon-notices.json`, that the website serves from `main` and the apps show as
cards at the bottom left. It is signed with the release key, under a signature
of its own, so it can never pass for a release list.

Write the notices in a file outside the repository:

```json
{
  "notices": [
    {
      "id": "live-demo-2026-12",
      "tone": "info",
      "title": "Live demo on Thursday",
      "body": "Agents and plugins, one hour.",
      "icon": "youtube",
      "link": "https://timon-ai.com/live",
      "endsAt": "2026-12-04T19:00:00Z"
    }
  ]
}
```

`id`, `tone` (`info`, `warning`, `success`), `title` (one line, 120 characters)
and `body` (plain text, 400 characters) are required. Optional: `icon` (a logo
the apps draw themselves: `github`, `discord`, `timon`, `x`, `youtube`; without
it, the tone's icon), `link` (`https:` only), `startsAt` and `endsAt`, `channels` (`["beta"]`, `["stable"]`),
`minVersion` and `maxVersion` (inclusive). Twenty notices at most; a list with
none takes every earlier one down. Then, at the root of an up-to-date `main`:

```bash
node scripts/release/sign-notices.mjs --source ~/notices.json --dry-run     # check it
TIMON_RELEASE_ED25519_KEY="$(cat <release key>)" \
  node scripts/release/sign-notices.mjs --source ~/notices.json [--valid-days 30]
```

`--key-file <pem>` reads the key from a file instead; it must lie outside any
checkout. The script refuses a key the clients do not pin, and a list that is
not newer than the `timon-notices.json` it replaces (verified first). Open a
pull request that changes `timon-notices.json` only. Once merged, check what
the website serves:

```bash
curl -fsS https://timon-ai.com/.well-known/timon-notices.json | cmp - timon-notices.json && echo ok
```

The list expires (30 days by default): after that, the apps show none of it.
Closing a card is remembered by its `id`: to show a notice again, give it a new
one.

## Environments and secrets

| Environment | Reviewers | Deploys from | Secrets |
|---|---|---|---|
| `release-build` | none | `main` only | `TIMON_RELEASE_PRIVATE_KEY`, `TIMON_RELEASE_PUBLIC_KEY`: the Ed25519 release pair, PEM |
| `nightly-build` | none | `main` only, set once GitHub has created it at the first nightly build | none |
| `release` | the maintainers | `main` only | `TIMON_RELEASE_ED25519_KEY`, `TIMON_RELEASE_P256_KEY`: the private keys that sign the two release lists; `RELEASE_PR_TOKEN`: a fine-grained token limited to this repository, with Contents and Pull requests in read and write |

No workflow runs on a tag: allowing a tag pattern on these environments would
only open the keys to whoever can push a tag. The pull request of the release
lists is opened with `RELEASE_PR_TOKEN` because a pull request opened with the
workflow token starts no workflow, so its required checks would never run. The
repository must allow auto-merge.

The release passes its two build secrets to `build-packages.yml` by name, and
the called job, which declares `release-build`, reads them from that
environment. Only a release builds on the project's Mac. Its org runner group
`release-mac` must list
`ai-timon/timon/.github/workflows/build-packages.yml@refs/heads/main`: a job
defined in a reusable workflow is matched by the file that defines it, not by
its caller, so a group that lists only `release.yml` leaves the release's
macOS build waiting for a runner. The nightly build needs no entry there: its
macOS build runs on a runner hosted by GitHub.

What reaches what: a step gets only the secrets it uses; the builds get no
GitHub token; the attestation token never shares a job with npm or the built
code; the jobs that hold the list-signing keys install nothing. A fork or a
pull request reaches none of it.

## Required checks on `main`

The protection of `main` requires these checks: `ubuntu-latest · daemon 1/2`,
`ubuntu-latest · daemon 2/2`, `ubuntu-latest · app` (from `ci.yml`) and
**`protected paths`**. The last one must stay required. `ci.yml` runs as the
pull request has it, and its `changes` job may let the daemon and app suites
stand down when a pull request only changes documentation pages, changelog
fragments or Markdown at the root (`scripts/ci-changes.mjs`). That job runs
the classifier as the base holds it, and a pull request touching the
classifier or `.github/` always runs every suite; but a pull request could
still rewrite `ci.yml` to skip them. `protected paths` runs from `main`
(`pull_request_target`) and fails any pull request from outside the project
that changes `.github/**` or `scripts/ci-changes.mjs` until a maintainer
approves it: without it required, nothing stops such a pull request from
reaching `main` with its suites skipped.

## Verify a package

Every installer built by these workflows carries a
[build provenance attestation](https://docs.github.com/actions/security-for-github-actions/using-artifact-attestations):
a signed statement of the repository, workflow and commit it was built from.
With the [GitHub CLI](https://cli.github.com/), signed in:

```bash
gh attestation verify "<installer>" -R ai-timon/timon
```

To require a published release rather than a release candidate, name the
workflow:

```bash
gh attestation verify "<installer>" -R ai-timon/timon \
  --signer-workflow ai-timon/timon/.github/workflows/release.yml
```

The check is made on the file's digest, so the file name does not matter:
GitHub replaces the spaces of an asset name with dots. The attestations of a
run are listed in its summary and on the repository's **Attestations** page.

Independently of GitHub, every installer's size and SHA-256 are in the signed
release list (`releases.json` at the root of `main`), which the app and the
one-line installers check before installing anything.
