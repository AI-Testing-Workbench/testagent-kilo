---
"TestAgent": patch
"@kilocode/cli": patch
---

Add `GET /testagent/server/auth` to fetch the web UI share-link credential (`?auth_token=`). It is always available to loopback callers, and reachable from remote clients in cloud mode — the same `isCloudMode()` gate that shows the "copy Web UI link" button.
