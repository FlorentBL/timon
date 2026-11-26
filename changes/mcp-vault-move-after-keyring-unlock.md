---
type: fixed
---
An MCP server saved while the system keyring was still locked gets its keys moved into the secrets vault as soon as the keyring opens, instead of staying unavailable to agents until Timon restarts.
