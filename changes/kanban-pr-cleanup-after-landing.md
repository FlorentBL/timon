---
type: fixed
---
Timon tells the job's conversation when its pull request opens, and, once you turn on Settings → Missions → Cleanup (off by default), removes a merged job's integration branch and the working folders of its tasks and of its sequential agent, keeping anything not proven to be in the target branch; `set-integration --delete-remote-branch on` also deletes the branch on the repository the pull request was opened on.
