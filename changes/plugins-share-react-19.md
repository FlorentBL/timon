---
type: changed
---
Plugins run on Timon's own React 19: a plugin that bundles its own React or uses an API React 19 removed stops working, and the shared `react` module now also exports `use`, `useActionState`, `useOptimistic`, `useTransition`, `forwardRef`, `Children` and the other React 19 APIs by name (plugin API 20).
