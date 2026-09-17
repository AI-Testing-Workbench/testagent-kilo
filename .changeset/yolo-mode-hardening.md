---
"TestAgent": minor
"@kilocode/cli": minor
---

Harden YOLO mode for unattended runs: turning YOLO on now releases already-pending permission prompts and questions immediately; transient API failures auto-resume the run (bounded, with backoff) instead of silently stopping; truncated or empty model turns are recognized as unfinished work and continue; stream retries no longer replay partially generated output; the YOLO switch now reflects true backend state (rolls back on sync failure); and TESTAGENT_YOLO=1 enables the mode from startup for scripted runs.
