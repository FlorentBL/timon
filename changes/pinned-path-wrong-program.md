---
type: fixed
---
A provider's pinned path now names the CLI it expects (Ollama Cloud asks for the Codex CLI) and refuses a file that is another program, such as `ollama`, instead of saving it and failing every mission; `timon doctor` marks such a path as failed.
