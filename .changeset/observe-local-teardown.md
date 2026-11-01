---
'@livestore/livestore': patch
'@livestore/adapter-web': patch
'@livestore/common': patch
---

Expose strict local teardown observation over one shared cleanup operation, correct bounded shutdownPromise observation, and retain web worker database-close failures. Keep bounded requests and cancellation semantics explicit; local completion does not attest to another session's shared leader or exclusive file availability.
