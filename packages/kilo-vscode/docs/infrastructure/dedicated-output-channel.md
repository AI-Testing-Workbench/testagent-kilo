# Dedicated Output Channel

**Priority:** P2

Agent Manager has its own output channel. No general "Kilo Code" output channel exists.

## Remaining Work

- Create `vscode.window.createOutputChannel("Kilo Code")` during activation
- Centralized logging utility with log levels (debug, info, warn, error)
- Route all `[TestAgent]` log messages to this channel
- Dispose on deactivation
- Migrate existing `console.log("[TestAgent] ...")` calls to the logger
