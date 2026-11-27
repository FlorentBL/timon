# plugin-agent-folders

Replaces the extra folders of an agent (slot `agent.folders`) with one list
per owner — the project first, then each agent — and a read/write switch on
every folder. It changes both screens that show them: the Workspace tab of
the agent's page and the project's settings. The product's section comes back
as soon as the plugin is removed.

The component takes no props: it reads `useAgentFolders()` from `@timon/ui`
(client API 20) — the `rows` (owner, path, name, access, and why a launch
leaves a folder out), the `owners` a folder may be added to, and the gestures
`add`, `setMode`, `remove` and `browse`. Timon reads and writes the lists,
checks every path again and announces each change; a refusal comes back in
the gesture's result, for the plugin to show. A change applies from the
agent's next mission.

What a replacement must respect is in [Slots](../../public-docs/docs/plugins/slots.md),
under `agent.folders`.

The package deliberately ships no `SIGNATURE` file.
