---
"TestAgent": patch
---

Fix stale sub-agent cards and a hanging "continue task" after reloading VS Code mid-task: sub-agent cards no longer show a permanent "starting" state with a stop button that does nothing, interrupted tool calls are finalized when a session is resumed, and continuing a session that is still running now fails fast with a clear error instead of hanging.
