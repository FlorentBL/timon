---
type: fixed
---
Compacting a long Codex conversation on the same model now uses Codex's native in-place compaction (`thread/compact/start`) instead of summarizing the full transcript. Cross-model and cross-provider compaction now splits oversized transcripts into bounded sections summarized in parallel so long conversations no longer fail input-size limits or time out.
