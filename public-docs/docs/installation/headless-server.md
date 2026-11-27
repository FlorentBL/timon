---
title: Run Timon on a headless server
sidebar_position: 8.5
---

A server that never sleeps (a VPS, a home server, a NAS) is the best home for agents that work while you are away: scheduled Kanban tasks, overnight series and long missions keep running whatever your own computer does. This page puts the pieces together: install Timon as a background service, reach it safely, keep it up to date, and drive it from the Timon you already use on your computer.

:::warning Choose an x86-64 server
Timon runs on Linux on x86-64 processors only. ARM servers (aarch64, arm64) are not supported: a Raspberry Pi, an Ampere-based VPS or an AWS Graviton instance cannot run Timon, and the install command stops on them with `no Timon package for linux-arm64`. When you rent a VPS, pick an x86-64 (amd64) plan; on the server, `uname -m` prints `x86_64`.
:::

:::tip The short version
1. Install Timon on the server, as the account that will own it: `curl -fsSL https://timon-ai.com/install.sh | sh`. On a Debian or Ubuntu server it installs the package, the background service and the [built-in browser](#6-the-built-in-browser-on-a-server), with nothing to set up by hand.
2. Create your account on the server, before opening any access: `timon init`.
3. Publish it on your private Tailscale network with `tailscale serve`, over **HTTPS**.
4. On your computer, turn on the **Machines** plugin and pair the server with a one-time code (`timon device pair` on the server prints one): the interface you already use switches to it in the same window. See [Machines](../usage/machines.md).
5. To update, install the new package, then on the server: `timon update apply` (moves the service onto it), `timon update status`, and `timon update approve <daemon-version>`.
:::

## 1. Install and run as a service

On a Debian or Ubuntu server, in an SSH session as the account that will own Timon's data (not `root`):

```bash
curl -fsSL https://timon-ai.com/install.sh | sh
```

It installs the deb package (with the `timon` command), then the background service, and checks that the built-in browser answers (see [section 6](#6-the-built-in-browser-on-a-server)). On a server with no font installed, it adds the fonts that browser needs in the same `apt-get install`. Run as `root`, it installs the package only and asks you to install the service from the owner's account. `timon` on its own then shows where the installation stands and the next command to type.

By hand, install the supplied deb package: it also installs the `timon` command. From an authorised source checkout, follow [Linux](linux.md#from-an-authorised-source-checkout). In both cases, the daemon runs as a service of the operating system's supervisor, not inside a window:

```bash
timon service install --dry-run   # shows what will be installed
timon service install
timon service session-mode always # keeps it running after you log out
timon service status
timon doctor
```

On Linux the service is a systemd **user** service. `timon service session-mode always` turns on user lingering: the service then starts at boot, before anyone signs in, and survives the end of your SSH session. Without it, the service stops when your last SSH session ends. Install it as the account that will own Timon's data, never as `root`. See [Running in the background](background.md) for the details, and for `timon service stop` / `timon service start`.

A server must not sleep: nothing runs while it does, and Timon does not wake it. On a machine without a desktop, `sudo systemctl mask sleep.target suspend.target` disables suspend.

**Behind a company proxy**, give the service the standard variables: `systemctl --user edit <unit>` (`systemctl --user list-unit-files 'timon-*'` lists the name), then add `Environment=HTTPS_PROXY=http://proxy.example:3128` and `Environment=HTTP_PROXY=http://proxy.example:3128` under `[Service]`, and restart the service. Timon then sends its own requests and its missions' requests through that proxy, and keeps connections to the machine itself (`127.0.0.1`, `localhost`) direct; you do not need to set `NODE_USE_ENV_PROXY` yourself, Timon turns it on when it sees a proxy.

The AI providers' command-line tools (`claude`, `codex`…) and their sign-in live on the server too: sign them in there, from an SSH session under the same account, once. A machine you drive from elsewhere keeps the providers it was configured with; nothing about them travels between machines.

## 2. Create your account first

The web interface and the daemon only listen on the server itself (the loopback) until you decide otherwise. Create your administrator account **before** opening any other access. On the server:

```bash
timon init
```

It asks for your first name, your email and a password (typed hidden, twice), creates the account, and shows which AI tools (`claude`, `codex`…) are ready, installed but not signed in, or missing. If the background service is not installed yet, it offers to install it first. For a script, pipe the password instead of typing it: `printf '%s\n' "$PASSWORD" | timon init --email you@example.com --password-stdin`. The password is never accepted as an argument.

`timon init` only works on the server itself, as the account that owns Timon's data: it proves who you are with that account's daemon token, so it asks neither for the one-time setup token nor for an email code.

Alternatively, create it in the web form through an SSH tunnel, which nobody else can use:

```bash
ssh -N -L 3100:127.0.0.1:3100 you@your-server
```

Then open `http://127.0.0.1:3100` on your computer and complete the [first run](first-run.md). Replace `3100` with the web interface port of your installation: `timon app status` prints it. The full walkthrough, including the one-time setup token, is in [Remote access](remote-access.md#step-0-finish-the-first-run-through-an-ssh-tunnel).

## 3. Reach it over HTTPS with `tailscale serve`

[Tailscale](https://tailscale.com/) links your own devices in a private network and gives the server an HTTPS address that only they can open. No port is opened to the internet. On the server:

```bash
sudo tailscale up
sudo tailscale serve --bg --https=443 http://127.0.0.1:3100
tailscale serve status
```

**MagicDNS** and **HTTPS certificates** must be on in the Tailscale admin console. Then add `"daemon": { "behindTlsProxy": true }` to `~/.timon/timon.config.json` and restart the daemon, so session cookies are only sent over HTTPS. Open `https://<server>.<your-tailnet>.ts.net` from any of your devices: it is the full Timon interface, installable as an app on your phone.

:::warning Serve, not Funnel
`tailscale serve` shares with your tailnet only. **Tailscale Funnel** publishes on the public internet: never use it for Timon.
:::

A reverse proxy with a certificate (Caddy, nginx) or a Cloudflare Tunnel works too: [Remote access](remote-access.md) describes each method, with its firewall rules and its pitfalls.

## 4. Drive it from the Timon on your computer

With the **Machines** plugin, the Timon you already use on your computer (desktop app, browser or phone app) switches to the server in the same window, and back. Nothing is merged: each machine keeps its own agents, projects, settings and missions.

The interface on your computer talks to the server's **daemon**, so the daemon also needs an HTTPS address on your tailnet. The simplest way: on the server, in **Settings → Access & network → Devices** → **Authorize a new device**, choose **Make this machine reachable** ([Connected devices](../usage/connected-devices.md#make-this-machine-reachable)); the card then shows the address. On a server with no desktop, Timon cannot show a password prompt to install Tailscale or let your account manage it: the card gives the commands to run over SSH (`curl -fsSL https://tailscale.com/install.sh | sudo sh`, then `sudo tailscale set --operator=$USER`), and **Sign in to Tailscale** shows the sign-in link to open on any computer. By hand, publish it on a second HTTPS port (replace `3000` with the daemon port of your installation, shown in the *Daemon listener* row of **Settings → Access & network → Web interface → Technical details**):

```bash
sudo tailscale serve --bg --https=8443 http://127.0.0.1:3000
tailscale serve status
```

The server's address for Machines is then `https://<server>.<your-tailnet>.ts.net:8443`.

- **HTTPS is required.** A machine is never paired or reached over plain HTTP, even on a private network: put `tailscale serve`, or a reverse proxy with a valid certificate, in front of the daemon. Plain HTTP is only accepted for a Timon on the same computer.
- **Keep the daemon behind the account.** Once the first account exists, the daemon refuses every request without a signed-in account, a paired device or the daemon token, except the few that check their own proof: signing in, pairing a device and signed webhooks. That is why step 2 comes first. Keep `daemon.listen` on `127.0.0.1`: `tailscale serve` reaches it there.
- **Sign your webhooks.** Behind `tailscale serve`, Timon refuses any call to a trigger that uses the `none` scheme, since it comes through a proxy. Give every trigger the server receives an HMAC signature or a shared token anyway (see [Triggers](../usage/triggers.md)).

Then pair the two:

1. **On the server's interface** (its Tailscale address or the SSH tunnel), open **Settings → Access & network → Devices** and choose **Authorize a new device**. A one-time code appears, valid 5 minutes. Over SSH, `timon device pair` prints the same code, with the daemon address to use.
2. **On your computer**, turn on **Machines** in **Plugins**, then open **Settings → Plugins → Machines** → **Add a machine**: enter the server's address and the code.
3. Pick the server at the foot of the navigation menu. The whole interface becomes the server's; **This computer** in the same menu brings you back.

Everything about pairing, switching and what a paired device may do is in [Machines](../usage/machines.md) and [Connected devices](../usage/connected-devices.md).

## 5. Keep it up to date

Plan an update when no mission is running. Updating takes three steps, all on the server:

1. **Install the new package** (for a deb, `sudo apt install ./<package>.deb`). This replaces the installed program, not the service: the service runs from its own copy of the release inside the data directory, so the previous version keeps running.
2. **Move the service onto the new package.** On a desktop, quitting and reopening the app does it; on a server, run `timon update apply`. It restarts the service on the new release, checks that it answers, and puts the previous one back if it does not.
3. **Approve the data migration.** A packaged daemon waits for your explicit approval before it updates an existing database; restarting the service does not give it.

As the account that runs Timon (not with `sudo`; set `TIMON_HOME` if you use a separate data directory):

```bash
timon update apply
timon update status
timon update approve <daemon-version>
```

`timon update apply` ends with `The service now runs Timon <version>.` Check that the `daemonVersion` returned by `timon update status` is the version of the package you installed, then approve that exact version. Timon saves a copy of your data before migrating, in `backups/pre-<version>/` inside its data directory. All three commands work over SSH. If `timon update apply` fails, the previous service is restored and your data are not modified; the details are in `desktop-runtime/update-apply.log` inside the data directory.

As long as the service lags behind the installed package, `timon update status` and `timon doctor` say so and name the command to run. Then check:

```bash
timon service status
timon doctor
```

Update the interfaces that drive the server as well. When a machine runs a Timon too old for the interface you switch from, the switch is refused and the interface says to update that machine; a machine newer than the interface works, with a banner suggesting to update the interface. See [Upgrading](upgrading.md) for backups and restores.

## 6. The built-in browser on a server

Agents browse with the project's built-in browser on a server too, and you watch and drive it from the interface on your computer (through Machines or the server's Tailscale address), as on a desktop: agents open pages, read them and take screenshots, and you follow them in the live view. Nothing extra to install.

On a desktop, the Timon app runs that browser. A server has no app open, so `timon service install` adds a second background service next to the daemon, the **browser host**: the same Timon program, started with no window, that runs only the built-in browser. It is a systemd user service named `timon-browser-<id>`, installed only on Linux, with the deb package, on a machine with no desktop session. A machine with a desktop never gets one: there, the app runs the browser.

It follows the daemon: `timon service stop`, `timon service start`, `timon update apply` and `timon service uninstall` act on both. `timon service uninstall` removes the browser host first, and stops there, with both services left in place, if it does not stop: the message names the unit and the command to stop it, then you run the uninstall again. To see it:

```bash
timon service status     # a "browser" line: the unit and its state
timon doctor --browser   # does the built-in browser answer? if not, why, and the command that repairs it
```

`timon doctor` shows the same thing on its *built-in browser* line, and the daemon's log repeats it at start-up, on lines that begin with `[browser]`.

**Turn it off** if the server's projects never browse: set **Built-in browser service on a server** to off (search for it in **Settings**; in a file, `"settings": { "TIMON_BROWSER_HOST_SERVICE": false }` in `timon.config.json`), then run `timon service install`: it removes the browser host. Agents then get a clear refusal when they try to browse. Turn it back on the same way.

What the installation adds for it, and why:

- **Fonts.** A server image often ships with no font. The pages then still load, and agents still read their text, but every screenshot and the live view show them **without any text**. `install.sh` installs `fonts-liberation`, `fonts-noto-core` and `fonts-noto-color-emoji` when the server has no font at all; add `fonts-noto-cjk` for Chinese, Japanese or Korean pages.
- **An AppArmor profile, on Ubuntu 23.10 and later (24.04 included).** Chromium, which runs the browser, isolates every page in a sandbox; these Ubuntu releases allow it only to programs with an AppArmor profile. The deb package installs `/etc/apparmor.d/timon-desktop`, which grants that single right to `/opt/Timon/timon-desktop`. See [Linux: no usable sandbox](troubleshooting.md#linux-no-usable-sandbox) if it could not be loaded.

Two limits:

- The browser host comes with the **deb package** only. A server running the AppImage has no built-in browser.
- **Sign in with Chrome** opens a real Chrome window, which a server cannot show: it is refused there. Sign in to the site directly in the built-in browser, from the interface on your computer.

## What does not run on a headless server

- **Push notifications from the server** reach your phone through the Timon that serves your interface. If that Timon (your computer) is off, the server's cards wait in its own notification centre. See [Machines](../usage/machines.md#notifications).
- **Tools that need an open desktop session** (a sign-in through the system credential store, a window): see [Limits while no session is open](background.md#limits-while-no-session-is-open).
- **Sign in with Chrome** in the built-in browser (see [section 6](#6-the-built-in-browser-on-a-server)).

## Troubleshooting

| Symptom | Likely cause | What to do |
| --- | --- | --- |
| `timon service status` reports the service stopped after you log out of SSH | User lingering is off | `timon service session-mode always` (or `sudo loginctl enable-linger $USER`), then `timon service start` |
| *The machine must be reached over HTTPS* when adding the server | The address starts with `http://` | Publish the daemon with `tailscale serve` (section 4) and use its `https://` address |
| *No Timon machine answers at this address* | Something other than a Timon daemon answers at this address | Use the address published for the **daemon** port (`:8443` above), with no path, and check `tailscale serve status` |
| *The machine does not see this connection as HTTPS* | A reverse proxy in front of the daemon drops `X-Forwarded-Proto`, or `daemon.behindTlsProxy` is off behind a proxy on another host | Forward `X-Forwarded-Proto: https` and set `daemon.behindTlsProxy` to `true`, then restart the daemon |
| *The machine refused this code* | Code mistyped, expired (5 minutes) or already used; or the address is the server's **web interface**, not its daemon | Check that the address is the daemon's (`:8443` above), then authorize a new device on the server and use the new code at once |
| *This machine runs a Timon version too old for this interface* | The server was not updated | Update the server (section 5), then switch again |
| `timon update status` still shows the previous version after you installed the new package | The package replaces the installed program, not the service, which still runs the previous release | `timon update apply`, then `timon update status` and `timon update approve <daemon-version>` (section 5) |
| The built-in browser says *The built-in browser of this server is not running* | The browser host is stopped, failed, turned off or not installed | `timon doctor --browser` names the cause and the command; usually `systemctl --user restart <unit>` (the unit is on the `browser` line of `timon service status`), or `timon service install` |
| `timon service install` or `start` is refused: *the service timon-browser-… already runs on this data directory* | The browser host's unit was edited, or a drop-in (`systemctl --user edit`) changed what it runs: Timon only accepts the command it writes itself | Remove the drop-in (`systemctl --user revert <unit>`), or run `timon service install --force`, which takes that unit down and writes it again |
| Screenshots and the live view of the built-in browser show pages with no text | The server has no font | `sudo apt-get install fonts-liberation fonts-noto-core fonts-noto-color-emoji`, then `systemctl --user restart <unit>` |
| `timon doctor --browser` says the browser host *crashes at every start*, exit status 127, and its log says *error while loading shared libraries* | An older package did not declare that library | `curl -fsSL https://timon-ai.com/install.sh \| sh` (or install the library the log names, `libasound2t64` on Ubuntu 24.04), then `systemctl --user restart <unit>` |
| The browser host stays `failed`, and its log says *No usable sandbox* | Chromium's sandbox is refused (Ubuntu 23.10 and later) | See [Linux: no usable sandbox](troubleshooting.md#linux-no-usable-sandbox) |
| The server's interface asks to approve an update and nothing else works | A new package was installed and the migration is not approved | `timon update status`, then `timon update approve <daemon-version>` on the server |

For anything else, the daemon log has the answer: `journalctl --user -u <unit> -n 100`; `systemctl --user list-unit-files 'timon-*'` lists the unit names (the daemon's, and `timon-browser-<id>` for the built-in browser). See also [Troubleshooting](troubleshooting.md).
