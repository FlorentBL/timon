---
title: GLM (Z.ai)
sidebar_position: 13.4
---

Timon can run agents on **GLM**, the models of Z.ai (Zhipu AI). GLM is a built-in provider: missions run through the Claude Code CLI, pointed at Z.ai's Anthropic-compatible endpoint with your own Z.ai key. You do not add a backend by hand.

## Set it up

1. Install the Claude Code CLI on the machine that runs Timon, if it is not there yet: GLM missions run through it. You do not need a Claude account for GLM.
2. Create an API key in your Z.ai account (**API Keys**, on the Z.ai platform).
3. In Timon, open the **Secrets** page and add an entry named `ZAI_API_KEY`, in *inject* mode, with your key as its value. Grant it to `global`, or reserve it to the `zai` backend so that only GLM missions receive it.
4. **GLM (Z.ai)** turns active without a restart and appears in the model selectors.

The key stays in the vault. Timon passes it to the Claude Code process of each GLM mission, and never writes it to a file, a log or the command line. A `ZAI_API_KEY` variable in the daemon's environment is used too, and wins over the vault.

If GLM does not appear, check that the vault entry is named exactly `ZAI_API_KEY` and is granted to `global` or reserved to `zai`, and run `timon doctor`: it tells you whether the `claude` command was found.

## Coding Plan or pay-as-you-go

Z.ai sells two kinds of access, and the endpoint decides which one a request uses:

- **GLM Coding Plan**, a monthly subscription. It answers on `https://api.z.ai/api/anthropic`, the address Timon uses by default. Usage counts against the plan's quota, reset every 5 hours and every week; when it runs out, requests wait for the next window; according to Z.ai, the plan never draws on your account balance.
- **Pay-as-you-go API**, billed by the token on your account balance, on another endpoint.

To send GLM missions to another address, such as a proxy, set `ZAI_BASE_URL` in the daemon's environment. It replaces the default address for every GLM mission.

:::caution Coding Plan terms
Z.ai's usage policy for the Coding Plan limits it to the tools and products Z.ai lists as supported, and forbids sharing an account or using it for several users. Timon is not on that list; GLM missions run through the Claude Code CLI, which is. Read Z.ai's current terms before you use a Coding Plan key with Timon, in particular if several people use your Timon or many missions run at once. A violation can lead Z.ai to limit, freeze or close the account. The account, and compliance with its terms, are yours.
:::

## Models

The selectors offer **GLM-5.4** (the default), **GLM-5.3** and **GLM-5.3-Flash**, the models every Coding Plan tier includes at the time of writing. Claude Code also asks for its own model names for background work and sub-agents: Timon maps them to GLM-5.4, and to GLM-5.3-Flash for the lightweight calls. If Z.ai renames or adds a model, type its name in the model field of an agent.

GLM is never chosen automatically when another provider runs out of quota. You can still name it in a fallback rule of a task, a series or the global settings.

## What agents can do

A GLM mission is a Claude Code mission: the same permission cards, tools, session resume and usage-limit detection. Claude Code keeps the mission's sessions and settings in a folder of its own, kept by Timon, never in your `~/.claude`: your own Claude Code settings and sign-in are not used.

## Limitations

- **Not yet tried with a real key.** The provider was checked against the Claude Code CLI and a scripted session, not a full mission on a Z.ai account. How GLM's thinking mode answers Claude Code's thinking setting, and how Z.ai reports an exhausted quota, are still to be confirmed. Report what you see.
- **No quota gauge.** Z.ai documents no public API for the plan's remaining usage, so Timon does not display it.
- **Global platform only.** Z.ai's mainland China platform (BigModel) is a separate account with its own keys and is not offered as a card. Setting `ZAI_BASE_URL` to its Anthropic-compatible address, with a key from that platform, may work but has not been checked.
