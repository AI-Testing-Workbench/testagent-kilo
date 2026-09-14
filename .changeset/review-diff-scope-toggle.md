---
"TestAgent": minor
---

Add a scope switch to the changes viewer so it shows only the files the current session changed, with a toggle back to all worktree changes. Applies to both the Agent Manager review panel and the standalone Changes tab.

The session's file list now also tracks edits live while the agent runs, so a freshly started session is scoped immediately instead of falling back to showing every change in the worktree.
