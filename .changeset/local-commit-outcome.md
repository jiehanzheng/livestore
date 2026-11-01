---
"@livestore/common": minor
"@livestore/livestore": minor
---

Expose a per-invocation local commit outcome while preserving void commit behavior.
Certify rejection only after rollback and savepoint release before admission; keep
cleanup failures and admitted work indeterminate. Finish failed changeset sessions
and stage local execution hashes until the complete SQLite batch succeeds.
