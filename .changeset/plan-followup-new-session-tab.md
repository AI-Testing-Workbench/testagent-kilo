---
"@kilocode/cli": patch
---

Fix the "Start new session" button on the plan follow-up prompt not switching the VS Code Agent Manager to the new session when handover generation is slow. The new session now opens immediately, shows the plan text right away, stays visibly busy while the handover summary is being prepared, and appends that summary once it finishes generating.
