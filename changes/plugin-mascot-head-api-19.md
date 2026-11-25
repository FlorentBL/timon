---
type: changed
---
For plugin authors: a mascot pack that draws its own head now declares `apiVersion: 19`, like its template, so Timon 0.1.9 refuses it with "needs a newer Timon" instead of installing it and showing its own mascot; the plugin documentation now gives API 19 for the other capabilities that arrived in 0.1.10 (`reportsTo` on `ctx.agents`, several statuses in `ctx.kanban.list`, a `get` result written back with `ctx.mcpServers.put`).
