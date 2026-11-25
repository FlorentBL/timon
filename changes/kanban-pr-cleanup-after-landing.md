---
type: fixed
---
Once a job's pull request is merged, Timon removes its integration branch and the working folders of its tasks and of its sequential agent, and tells the job's conversation when the pull request opens; `set-integration --delete-remote-branch on` also deletes the branch on the remote.
