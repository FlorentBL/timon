---
title: Qwen Code
sidebar_position: 13.2
---

Timon can run agents on **Qwen Code**, the open-source coding agent from the Qwen team at Alibaba. It drives the `qwen` command over the Agent Client Protocol; Qwen Code keeps its own sign-in and keys, and Timon never sees or stores them.

## Set it up

1. Install Qwen Code, version **0.28.4 or later**, with its installer (`curl -fsSL https://qwen-code-assets.oss-cn-hangzhou.aliyuncs.com/installation/install-qwen-standalone.sh | bash`, or on Windows `irm https://qwen-code-assets.oss-cn-hangzhou.aliyuncs.com/installation/install-qwen-standalone.ps1 | iex` in PowerShell), with Homebrew (`brew install qwen-code`), or with npm (Node.js 22 or later):

   ```bash
   npm install -g @qwen-code/qwen-code
   ```

   The **Install** button of the Qwen Code card, in the onboarding and in **Settings › AI models › Providers**, runs the installer for you.

2. Sign in, in a terminal, under the OS account that runs Timon: start `qwen`, type `/auth`, and choose how Qwen Code connects (see [Which sign-in is billed how](#which-sign-in-is-billed-how)). The **Sign in** button of the card copies the command with the path Timon found. `qwen auth` no longer exists: use `/auth` inside `qwen`.

3. Restart Timon. **Qwen Code** then appears in the model selectors.

Timon looks for `qwen` on the service's PATH, in `~/.local/bin` (where the installer puts it on Linux and macOS), in the npm and Homebrew folders, and on Windows in `%LOCALAPPDATA%\qwen-code\bin`, where its installer writes `qwen.cmd`.

If Qwen Code does not appear, run `timon doctor`: it tells you whether the `qwen` command was found. A command installed somewhere the service's PATH does not cover can be pinned: set `host.binaries.qwen` to its absolute path. If a mission stops with a sign-in message, run `qwen` in a terminal on the machine that runs Timon, type `/auth`, then start the mission again. If a mission says Qwen Code is older than 0.28.4, update it (the npm command above, or its installer again) and send the message again.

## Which sign-in is billed how

Everything is chosen in `/auth`, inside Qwen Code, and kept in its own `~/.qwen` folder. The endpoint, international or mainland China, is chosen there too.

- **Subscriptions** (a monthly plan, no bill per token): **Qwen OAuth**, with the plan of your chat.qwen.ai account, and the **Coding Plan** of Alibaba Cloud Model Studio, whose keys start with `sk-sp-`.
- **Billed by the token**: a standard API key (Model Studio, QwenCloud pay-as-you-go, or another OpenAI-compatible provider) that you set up in `/auth` or in Qwen Code's own settings. Timon runs whatever Qwen Code is signed in to; with such a key, every mission is billed by that provider.

The account is yours, under the terms of the Qwen and Alibaba Cloud services.

If you only have a Model Studio key and do not want to install Qwen Code, Qwen models can also be reached through a **Compatible endpoint** ([Add a provider](add-a-provider.md)), without the CLI.

## Models

Timon does not pick a model for Qwen Code: the default is Qwen Code's own. The model picker lists what your sign-in offers, asked from Qwen Code and refreshed at most every 12 hours; opening it starts Qwen Code briefly, which leaves one empty session in its own history. A model change applies from the next session.

## What agents can do

Qwen Code **asks before it edits a file or runs a command**. The request appears as an **Allow / Deny** card, like on the other backends, and the agent's permission mode applies to it. Timon starts Qwen Code in its `default` approval mode, whatever its own settings say, so that its `auto` and `yolo` modes never let a tool through without that card. The **Plan** permission mode switches Qwen Code to its own plan mode, which analyses without changing anything. When Qwen Code offers it, **Always allow** lets Qwen Code remember the approval on its side.

Replies stream into the chat and tool calls appear with their results. **Stop** in a chat ends the current turn and keeps the conversation; after a restart, the mission reopens its Qwen Code session. Timon's own tools (Kanban, questions, missions, memory) and the stdio MCP servers configured for the agent reach Qwen Code.

## Limitations

- **Not yet tried on a tester's own account.** Timon was checked against Qwen Code 0.28.4 and a scripted stand-in, not a full session on a Qwen OAuth or Coding Plan account, so a first mission may still fail. Report what you see.
- **HTTP MCP servers are not passed on.** MCP servers you added over HTTP do not reach Qwen Code agents.
- **No live model switch.** A model change applies from the next session.
- **No quota gauge.** Timon does not display your remaining usage.
