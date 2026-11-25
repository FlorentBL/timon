---
type: fixed
---
Codex (or another CLI) installed with npm now starts when Node.js was installed with fnm, mise or asdf, or is not installed at all, instead of failing with `env: node: No such file or directory`; a Node.js in a folder other accounts can write is never used, and with no other Node.js the mission stops on `no trusted Node.js to run codex` instead of using the first `node` on its PATH.
