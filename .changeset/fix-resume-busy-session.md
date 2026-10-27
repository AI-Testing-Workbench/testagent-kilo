---
"TestAgent": patch
---

Fix sub-agent task cards around stop and resume: a cancelled card no longer comes back to life or offers a stop button when the same sub-agent is resumed, each card lists only the tool calls made during its own invocation, stale cards stop showing a permanent "starting" state after reloading VS Code mid-task, and continuing a running session fails fast with a clear error instead of hanging.
