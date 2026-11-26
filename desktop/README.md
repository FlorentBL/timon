# Timon desktop client

Electron shell around the local daemon: a window, a tray, and — when no service
supervises the daemon — the daemon itself as a child process.

The shell holds no product logic. It reads `~/.timon/timon.config.json` to know
where the daemon listens, probes `GET /api/health`, and shows the web app the
daemon (or Compose) already serves.

## Develop

```sh
npm install
npm run install:electron   # the Electron binary: npm install no longer fetches it
npm test            # pure modules: config reader, health probe, supervisor
npx tsc --noEmit
npm run build && npm start
```

The smoke tests that start a real Electron are opt-in
(`TIMON_ELECTRON_SMOKE=1 npm test -- src/<name>-smoke.test.ts`) and stop with
the install command above when the binary is missing. They open windows: add
`TIMON_ELECTRON_SMOKE_HEADLESS=1` to keep them off your screen (Linux: Electron
then runs on Chromium's headless Ozone backend, without `DISPLAY` or
`WAYLAND_DISPLAY`; a shell without a display gets that mode on its own).

`TIMON_HOME` is honoured, so a development shell can point at a throwaway home:

```sh
TIMON_HOME=$(mktemp -d) npm start
```

### « New Window » from the dock, from the sources (Linux)

An installed package declares a `.desktop` action: right-click Timon in the
dock (GNOME, KDE) → **New Window**. To get the same from the sources, write a
launcher for this checkout once:

```sh
npm run build
node scripts/install-dev-desktop-entry.mjs           # ~/.local/share/applications/timon-dev.desktop
node scripts/install-dev-desktop-entry.mjs --print   # show it, write nothing
node scripts/install-dev-desktop-entry.mjs --remove  # take it away
```

Then quit any Timon started from a terminal, launch **Timon (dev)** from the
app grid and pin it. Run from the sources on Linux, the shell names its
windows `timon-dev` (`src/linux-desktop.ts`), the `StartupWMClass` of that
launcher: its windows group under it, never under an installed Timon's icon.
The action runs `electron dist/main.js --new-window`: the running shell opens
one more window. A shell started before a rebuild cannot serve the rebuilt
pages: it asks to be restarted instead (`src/shell-build.ts`).

Windows gets the same entry in the taskbar's jump list (`src/jump-list.ts`),
packaged builds only: from the sources `electron.exe` alone is not Timon.
macOS has it in the Dock menu.

## Package (§5.5)

```sh
cd ../orchestrator && npm run build     # daemon
cd ../app && npm run build              # web app (next build)
cd ../desktop
npm run prepare:deps                    # daemon deps rebuilt for the Electron ABI
npm run dist                            # AppImage + deb / dmg / nsis
```

`npm run dist` runs `prepare:deps` itself; the standalone call is there to fail
early, since it is the only step that compiles a native module.

A **release candidate** (a test build carrying `x.y.z-rc.N`) is never built
from this checkout: the maintainers' release script, run from the repo root on
each OS, builds it in a throwaway detached worktree of `main`, without bumping
anything. See [`docs/RELEASE-RC.md`](../docs/RELEASE-RC.md).

### Why `prepare:deps` exists

The packaged daemon runs on the Node the package ships in `resources/node`
(`scripts/node-runtime.json`: Node 24, module ABI 137) — and so does the Next
app it spawns — while `orchestrator/node_modules` and `app/node_modules` are
built for the host's Node (Node 22 on a maintainer's machine: ABI 127). Shipping those trees gives an installer whose daemon cannot
load `better-sqlite3`: it crash-loops and the shell only says "the daemon keeps
crashing". Three artefacts are concerned, and each fails in its own place:

| Tree | Module | What breaks without it |
|---|---|---|
| `orchestrator` | `better-sqlite3` | The daemon dies at boot, on its database. |
| `orchestrator` | `node-pty` | Terminals and agent sessions. |
| `app` | `better-sqlite3` | The app's remote API, at first use. |

`electron-builder install-app-deps` does not help: it rebuilds the dependencies
of `desktop/`, which has none. And rebuilding `orchestrator/node_modules` in
place would break the daemon running from this repo under plain Node.

So `scripts/prepare-daemon-deps.mjs` copies each tree to a staging directory
**outside the repository**, rebuilds `better-sqlite3` there against the
installed Electron version, loads the result under Electron to prove the ABI,
and only then moves it to `build-resources/<tree>/` — which is what
`extraResources` ships. It fails if the live tree moved: absolute symlinks are
skipped when copying (`node_modules/node_modules` points back at the repo and
let a rebuild escape into it, observed 04/09/2026).

### Linux: the natives are built for glibc 2.28

A native module compiled on the build machine needs that machine's glibc: the
0.1.9 terminal, built on Ubuntu 24.04, did not load on Debian 13 or older
(TIM-0162), and better-sqlite3's downloaded prebuild needs glibc 2.29. On
Linux, `prepare:deps` therefore rebuilds both modules **from source** in a
`manylinux_2_28` image (AlmaLinux 8, glibc 2.28, the floor of the shipped
Node), pinned by digest in `scripts/native-linux.mjs`, and loads them there.
**Docker is a prerequisite of a Linux package**: the build stops at once
without a reachable Docker daemon. `TIMON_NATIVE_BUILD_IMAGE` replaces the
image (a local mirror, a newer pin under test).

Then every ELF that ships is read for the glibc versions it requires, without
binutils (what `objdump -T` prints as `GLIBC_2.x`): in `prepare:deps`, and
again in `afterPack` over the whole unpacked app, Electron and the dictation
engine included. One binary above 2.28, or a package without
`node-pty/build/Release/pty.node`, stops the build. The floor is the one
`public-docs/docs/installation/requirements.md` promises; `packaging.test.ts`
holds both together.

Installers land in `release/`. macOS builds carry no Developer ID signature in
v1: the first launch needs a right-click → Open. They still need a **valid
ad-hoc** signature, or Apple Silicon kills the app at launch (`SIGKILL (Code
Signature Invalid)`). Flipping the Electron fuses in `afterPack` voids the one
Electron ships with, so `runtimeFuses` re-signs ad-hoc on macOS
(`resetAdHocDarwinSignature`), and `afterPack` then verifies the bundle with
`codesign` (`scripts/mac-signature.mjs`): a broken signature fails the build.
A Developer ID identity in the keychain, when there is one, signs over it.

## Modes

| `daemon.supervisor` | What the shell does |
|---|---|
| `systemd-user`, `launchd`, `windows` | Expects a service. If nothing answers, it points at `timon service install`. |
| `none` | Portable mode: runs the daemon itself, with a banner saying agents stop when the app quits. |

Installing that service is mandatory on the three OSes (step 5.7):

| OS | What `timon service install` writes | Who triggers it |
|---|---|---|
| Linux | a systemd **user** unit, plus `loginctl enable-linger` | the first-run screen, or the CLI |
| macOS | a launchd agent in `~/Library/LaunchAgents` | idem |
| Windows | a scheduled task at logon, restarted on failure, behind one UAC prompt | the NSIS installer (`build/installer.nsh`), then the first-run screen if that failed |

The first-run screen (`/setup`) **blocks** until the service answers, runs the
install itself, and falls back on the exact command to paste when it may not
run one on your behalf (anything needing `sudo`). Portable mode stays the
answer for a machine where no supervisor can be installed — a Linux without
systemd — and the screen says so rather than pretending the install worked.

## The built-in browser on a server: `--browser-host` (Linux)

On a Linux machine where only the daemon runs, nothing provides the built-in
browser: the daemon reaches it through `<home>/browser-native/provider.json`,
which only the desktop app wrote. `timon-desktop --browser-host` (from the
sources: `electron dist/main.js --browser-host`) starts the engine, the capture
of its tabs and that provider, and nothing else: no window, tray, update or
consent screen, data restore or service install. It writes `provider.json` and
removes it when it stops (SIGTERM, SIGINT). Code: `src/browser-host.ts` (the
rules), `src/browser-host-shell.ts` (the run).

- **No screen.** With neither `DISPLAY` nor `WAYLAND_DISPLAY`, it starts itself
  again with `--ozone-platform=headless --ozone-override-screen-size=1920,1080`,
  in the same process (`process.execve`, same PID for a service manager).
  `app.commandLine.appendSwitch` cannot do it: Electron picks its Ozone
  platform before the main script runs. On that platform a hidden window has no
  display surface and `capturePage` rejects its tabs, so the engine shows its
  host windows there (`headless` option of `NativeBrowserEngine`); the streams
  work hidden.
- **One provider per home.** The host takes the app's single-instance lock (in
  `desktop-profile/`), since both would open the same browser profiles. The app
  with a screen comes first: its refused lock request makes the host close its
  provider and exit 75; the app, seeing `browser-native/browser-host.json`,
  retries the lock until it holds it (`app-claim.json` keeps a host restarted at
  once from taking it back). A host started while the app runs waits, trying
  every 5 s, and serves once the app quits.
- **Refused here.** The Chrome sign-in opens a real Chrome window: refused with
  the code `browser_signin_needs_screen`. On macOS and Windows the flag is
  refused (exit 78): the browser runs in the app there.
- **Fonts.** A server image often has none, and pages then render with no text
  at all on screenshots and in the panel (agents still read the DOM). The host
  measures a word at start and says what to install (Debian/Ubuntu:
  `fonts-liberation fonts-noto-core fonts-noto-cjk fonts-noto-color-emoji`).

| Exit code | Meaning |
|---|---|
| 0 | stopped on request |
| 1 | could not start (the log says why) |
| 75 | Timon desktop opened on this home and took the browser over: start again later |
| 78 | not on this system: starting again changes nothing |

## First launch of an installed package

With no `~/.timon/timon.config.json`, an installed package does NOT use the
daemon's defaults — they describe a developer machine and each one fails
silently on a fresh install (no service to supervise the daemon, no Compose to
serve the UI, and :3000 often taken by another program). It starts on:

| | Value | Why |
|---|---|---|
| `daemon.supervisor` | `none` | Portable mode: the shell runs the daemon itself. |
| `app.enabled` | `true` | Nothing else serves the UI in a package. |
| `daemon.listen` | `127.0.0.1:3010` | Free of the developer defaults (:3000, :3001). |
| `app.listen` | `127.0.0.1:3110` | Free of the developer defaults (:3100, :3101). |

A `timon.config.json` — even an empty one — hands the decision back to the
daemon's own resolution, and the shell then injects nothing.

## What the shell tells the embedded daemon

The daemon is spawned with the Electron binary under `ELECTRON_RUN_AS_NODE`, and
receives its bootstrap settings through the environment — the layer that wins
over `timon.config.json` (`orchestrator/src/config/load.ts`, `ENV_OVERRIDES`):

| Variable | Why it cannot live in the config file |
|---|---|
| `TIMON_HOME` | The shell may be pointed at a throwaway home. |
| `TIMON_INSTALL_DIR` | `<installDir>/../app` is where the daemon serves the UI from, and an AppImage mounts its resources on a different `/tmp/.mount_XXXX` at every launch. |
| `PORT`, `TIMON_APP_ENABLED`, `TIMON_APP_PORT` | Only on a first launch (see above): what the shell decided alone, so the daemon does not pick the developer defaults instead. |

## Uninstall

In an installed desktop app, open **Settings → Desktop application → Uninstall
Timon**. This local Electron capability is absent from browsers and PWAs.

- **Keep my data** is selected initially. The service runtime copies are removed;
  the data in `TIMON_HOME` (normally `~/.timon`) remains for reinstallation.
- **Delete everything** requires typing `SUPPRIMER` and accepting a native
  confirmation naming the directory. It permanently removes that directory's
  contents, including credentials and browser profiles. External projects and
  CLI configuration directories are preserved; directory symlinks are not followed.

Agents, browsers and connected PWAs stop during uninstall. The app verifies the
supervisor's ownership and shutdown before enabling cleanup. A separate helper
waits for Electron to exit, removes the selected data and displays the outcome.
Failures stop cleanup and report the remaining directory. No data removal is
exposed over HTTP, and `timon service uninstall` continues to preserve data.

The final dialog explains how to remove the application itself: move `Timon.app`
to Trash on macOS, delete the AppImage or use the package manager on Linux, or
remove Timon from Windows Apps settings. Removing only the app through the OS
continues to preserve Timon data. Use the in-app action first for complete removal.
