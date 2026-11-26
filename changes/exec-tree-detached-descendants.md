---
type: fixed
---
Checking a provider's program version and creating a task's worktree no longer leave background processes running when the program started one that detached itself, and such a call no longer runs past its time limit while cleaning up.
