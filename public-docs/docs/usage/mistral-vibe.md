---
title: Mistral Vibe
sidebar_position: 13.3
---

Timon can run agents on **Mistral Vibe**, the open-source coding agent from Mistral AI. It is an agent of the [ACP registry](../plugins/providers.md#agents-from-the-acp-registry): Timon downloads Vibe's own program for your system and drives it over the Agent Client Protocol. Vibe keeps its own sign-in and keys; Timon never sees or stores them.

## Install it

1. Open **Settings → AI models → Providers**, choose **Add a provider**, then **From the catalog**.
2. Search for **Vibe** and click **Install** on **Mistral Vibe**.

Timon downloads the program Mistral publishes for your system (macOS on Apple silicon or Intel, Linux on x86-64 or ARM64, Windows on x64), checks it against the checksum of the registry, and adds the provider **Mistral Vibe** (backend `acp-mistral-vibe`) to the list. Nothing else is needed: no Python, no package manager. A newer version of Vibe shows up on the same line of the catalog, and installing it swaps the program once the new one is verified.

## Sign in

Vibe tells Timon it signs in with **Sign in through Mistral AI Studio**, a browser step that Vibe runs only when its client starts it. Timon never starts a sign-in by itself, so sign Vibe in once from a terminal, under the OS account that runs Timon, with Vibe's own setup:

```bash
~/.timon/providers/acp-registry/agents/mistral-vibe/<version>/vibe-acp --setup
```

On Windows, in PowerShell:

```powershell
& "$env:USERPROFILE\.timon\providers\acp-registry\agents\mistral-vibe\<version>\vibe-acp.exe" --setup
```

Replace `<version>` with the folder you find there (the version shown on the catalog line, such as `3.1.4`). The setup offers two ways in:

- **your Mistral account**, in the browser;
- **an API key** you created in Mistral AI Studio, which you paste there.

Vibe keeps the key in your system's keyring, or in `~/.vibe/.env` when there is no keyring. If you already signed in to the Vibe command line or an editor extension of Vibe on the same machine, under the same account, Vibe reuses that sign-in and there is nothing to do.

**Sign-in methods**, on the Mistral Vibe line of the catalog, lists what Vibe announces. A mission that starts before Vibe is signed in stops with a sign-in message: run the setup above, then send the message again.

## Which sign-in is billed how

Your Mistral plan decides what Vibe costs. Read the [Mistral pricing page](https://mistral.ai/pricing) for the current plans and their limits.

- **Subscription**: signed in with your Mistral account, Vibe uses the coding allowance of your plan. The Free plan has limited coding sessions; Pro and Team include Vibe with higher limits.
- **Billed by the token**: usage past your plan's limit, when you turn on pay-as-you-go credits in your Mistral account, and any API key you create yourself in Mistral AI Studio (bring your own key).

Timon runs whatever Vibe is signed in to: with a key billed by the token, every mission is billed by Mistral. The account is yours, under Mistral's terms.

## Models and permissions

Timon does not pick a model for Vibe: the default is Vibe's own. The model picker lists what Vibe offers for your sign-in; opening it starts Vibe briefly.

When Vibe asks before a tool runs, the request appears as an **Allow / Deny** card, like on the other backends, and the agent's permission mode applies to it. What Vibe asks about is set by its own approval policy, which Timon does not change for an agent of the catalog:

- by default (`accept-edits`), Vibe **edits files without asking** and asks before it runs a command;
- with `auto-approve`, chosen in Vibe's settings, it asks nothing;
- with `ask`, it asks before every edit and every command.

To get a card for each edit, set `default_approval_policy = "ask"` in `~/.vibe/config.toml`. Whatever the policy, a [fenced mission](mission-isolation.md) still writes only where the fence allows.

Replies stream into the chat and tool calls appear with their results. Timon's own tools (Kanban, questions, missions, memory) and the stdio MCP servers configured for the agent are handed to Vibe when a session opens.

## Limitations

- **No usage gauge.** Mistral publishes no endpoint for the usage left on a plan, so Timon shows none for Vibe. Check it in your Mistral account.
- **Not yet tried on a tester's own account.** A first mission may still fail. Report what you see.
- **Vibe's folder is read-only inside the fence.** A [fenced mission](mission-isolation.md) can read your home but not write it, and Vibe writes its settings, logs and session history in `~/.vibe`. If a mission stops on a refused write there, allow `~/.vibe` as writable for the agent under [Exceptions](mission-isolation.md#exceptions), or accept the card the chat offers for that folder.
- **Timon does not know `~/.vibe` as a sign-in folder.** Missions running on the other backends are not kept from reading it. If you signed in with an API key and have no keyring, that key sits in `~/.vibe/.env`.
- **HTTP MCP servers are not passed on.** MCP servers you added over HTTP do not reach Vibe agents.
- **Vibe's approval policy is its own.** Timon does not pin it, so `accept-edits` or `auto-approve` lets edits through without a card (see [Models and permissions](#models-and-permissions)).
- **No direct Mistral API provider.** Timon reaches Mistral's models through Vibe only.
