---
title: Let an agent control your computer
sidebar_position: 3.4
---

With **Computer use**, an agent can look at your main screen and drive the mouse and the keyboard, like a person sitting at the machine. It is meant for what has no other way in: a desktop application without an API, a settings window, a legacy tool. For web pages, the [built-in browser](missions.md#the-built-in-browser) is safer and more precise.

Computer use needs the **Timon desktop app** running on the machine to control. It is off for every agent until you turn it on.

## Turn it on for one agent

1. Open the agent's settings and go to **Permissions**.
2. Switch on **Computer use**.

Only that agent gets the screen and input tools; other agents are unaffected. Switching it off removes them at the agent's next conversation. The agent can take a screenshot (resized, 1280 px wide by default), move the pointer, click, double-click, drag, scroll, type text and press key combinations.

## Allow Timon on your system

| System | What to do |
|---|---|
| macOS | In **System Settings › Privacy & Security**, allow Timon under **Accessibility** (mouse and keyboard) and **Screen Recording** (screenshots). Restart Timon if macOS asks. |
| Windows | Nothing to grant. Windows does not let Timon type into an application running as administrator unless Timon runs as administrator too. |
| Linux | An **X11** session with the `xdotool` tool installed. |

**Wayland is not supported**: under Wayland the system does not let an application inject mouse and keyboard events, so Computer use reports itself as unavailable. Log in to an X11 session instead. The same happens when `xdotool` is missing or when macOS permissions are not granted yet; the agent's settings tell you which.

## Stop it at any time

While the agent is in control, a banner with a **Stop** button is visible in Timon, and a small always-on-top bar shows on the screen. You can also press **Cmd+Shift+Esc** (macOS) or **Ctrl+Shift+Esc** (Windows and Linux) from any application.

After a stop, every Computer use action of every agent is refused until you resume it from the banner. Only a person can stop or resume; an agent cannot. If another application already uses the shortcut, the button still works.

## Security

- **The agent really controls the machine.** It acts in whatever is open on your screen, with your accounts and your rights. Watch it work, close sensitive windows first, and do not leave it unattended with anything you cannot afford to lose.
- **Never ask the agent to type a password**, a recovery code or a payment detail, and never leave a password manager unlocked in view: every screenshot is sent to the model provider of the agent. Type secrets yourself.
- What is on the screen is data, not instructions: an agent can be misled by text shown in a window or a page. Stop it if it does something you did not ask for.
- Text the agent types is never written to Timon's logs.
