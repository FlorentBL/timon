---
type: fixed
---
Timon no longer fills the disk on its own: tasks wait with an alert when free space runs low instead of crashing the daemon, finished worktrees whose work is already in the remote's main branch and their `.next` build caches are removed, and each agent's event archive is capped.
