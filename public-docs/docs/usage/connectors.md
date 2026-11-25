---
title: Official connectors — connect your services in one click
sidebar_position: 2.6
---

The **official connectors** are the MCP servers of services your agents can work with, such as GitHub, Linear, Notion, Sentry, Stripe or Supabase. Each one is hosted by the service's own publisher. Connecting it takes one click and a sign-in on the publisher's site: you never copy an address or edit a configuration file.

They open the **Connectors** tab of **Capabilities**, above the MCP servers you added yourself, grouped by category (Code, Data, Design, Productivity, Payments), connected ones first. The tab's search box filters connectors and your own servers at once. On a wide screen, a column on the left lists the categories and your own servers: click one to jump to it. Click a connector to see a few examples of requests, how it connects, what it does, and links to the publisher's website, privacy policy and terms of use.

The section is provided by the **Official connectors** plugin, on by default (**Settings → Plugins**).

## Connect a connector

Each connector connects in one of three ways:

- **Sign-in with the publisher** (most connectors). Press **Connect**. The publisher's sign-in page opens in a new tab, or in your system browser in the desktop app. Sign in, approve access, and come back. The card switches to **Connected** within a few seconds. If the page did not open, for example because the browser blocked it, open the card and choose **Open the sign-in page again**.

After you approve access, the publisher sends your browser to a short Timon page that takes you back to the app. If the sign-in fails, that page stays open with the reason and a link back to Timon. A sign-in has to be finished within 10 minutes and is lost if Timon restarts in the meantime: start it again from the card. Opening the same sign-in link a second time only says whether the connector is already connected.
- **A key** (GitHub, for example). Open the card, paste the key in the masked field, then press **Connect**. The **Get a key** link opens the publisher's page that issues it. For GitHub, use a fine-grained personal access token: the token decides which repositories and actions your agents can reach. Timon keeps the key in its secrets vault, where it appears in **Settings → Secrets** as `MCP_APP_GITHUB_KEY`. No agent receives the key itself, and Timon sends it only to that connector. If the vault is switched off, a key connector cannot be connected.
- **No account** (Context7, for example). Press **Connect** and the connector is ready.

Connecting creates an MCP server named `app-<name>`, for example `app-linear`. It also appears under **Your MCP servers**, below the connectors: it is an MCP server like the others.

## Give a connector to an agent

Connecting makes the connector available, but no agent has it yet. Add it to an agent from the **MCP** tab of the agent editor, or switch it on in the MCP card of the chat sidebar. The agent receives its tools the next time it starts.

Agents running on a backend that only loads local MCP servers do not receive connectors, since every connector is a remote server.

## Disconnect a connector

Open the card and press **Disconnect**. Its MCP server is removed, and so is its key if it has one. Agents that used it lose its tools the next time they start. To revoke the access you granted at sign-in, also remove it from your account settings on the publisher's site.

If you added an MCP server called `app-<name>` by hand, the matching card shows **Name taken**. Timon never changes or removes that server. Rename or delete it under **Your MCP servers** to use the connector.

## Add a server that is not in the list

**New MCP**, in the tab's toolbar, opens the MCP server form. There you can add any MCP server: a remote address with its own headers, or a program that runs on your machine.

The headers of a remote server, an API key for example, are kept in the secrets vault and are not written into the agents' configuration: the agent talks to Timon, which adds the headers when it relays each call to the server. Once saved, a header value shows as `***` in the form: leave it as is to keep the value, or type a new one to replace it. This needs the secrets vault. If it is switched off, the server's card reads **Needs the secrets vault** and agents do not get the server until you switch the vault back on; the headers you typed are kept and move into the vault as soon as you switch it back on.

A program that runs on your machine (a `stdio` server) with environment variables is handled the same way: its variables are kept in the secrets vault, show as `***` in the form, and are never written into the agent's configuration. Timon starts the program itself for each conversation that uses it, gives it its variables, and the agent reaches it through Timon. The program runs in the conversation's folder and stops when the conversation ends. If it cannot start (the command is not found, for example), the agent runs without it and you receive a notification; its variables are never handed to the agent instead. A program without variables is started by the agent's own tool, as before. Agents that cannot reach an MCP server through Timon yet, such as opencode and Hermes, start the program themselves and receive its variables, as in earlier versions. The **Run MCP servers with variables outside the agent** setting, under **Settings → Missions → Permissions**, turns this off: the agent's tool then starts the program and its variables are written into the agent's configuration, as in earlier versions.

Agents on opencode and Hermes do not receive a remote server that Timon relays, since they only load programs they start themselves.

When a server signs in with OAuth, the secret the publisher gives Timon at registration is kept in the secrets vault too.

## What a connector receives

A connector receives what your agents send it: the requests they make and the data they include. The publisher processes that data under its own privacy policy and terms, linked from each card. Timon only lists servers whose publisher is verified by the official MCP registry. Each one is reviewed before it ships, and its address and sign-in are checked. The publishers' logos ship with Timon, so nothing is loaded from a publisher's site to display them.

Who can connect connectors: an account that holds the `mcp:manage` permission (administrators by default). Agents cannot connect or disconnect one, because a connector acts with your own account at the publisher.
