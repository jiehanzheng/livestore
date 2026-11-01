---
'@livestore/common': patch
---

Export AdmittedOwnerEndedError for the existing local admitted-stream completion defect. Preserve its message, terminal Store fencing and original failure causes, allowing callers to choose a fresh Store admission without matching error text or resuming an old snapshot.
