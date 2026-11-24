---
type: changed
---
The environment variables of a local MCP server are no longer written into the agent's configuration: Timon keeps them in its secrets vault, starts the server itself and relays the agent's calls to it.
