---
"TestAgent": patch
---

Show local Cloud archives in the same history list and chat view as local sessions, keep archive conversations read-only until imported as local forks, allow retry after failed cloud service creation, and support upload and export actions in session history. Verify bound services before blocking uploads, refresh the native session list after Cloud imports, preserve full session-list actions in Cloud mode, and send failures to extension diagnostics instead of custom list notices. After importing an archive, verify its Gitee repository and branch and fast-forward the matching clean local branch when possible.
