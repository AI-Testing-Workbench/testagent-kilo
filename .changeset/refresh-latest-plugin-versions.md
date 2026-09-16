---
"@kilocode/cli": patch
---

Always re-resolve floating plugin versions against the registry so newly published releases are picked up instead of reusing a stale cached install. Exact pinned versions keep using the cache.
