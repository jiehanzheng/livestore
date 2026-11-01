---
'@livestore/common': patch
'@livestore/livestore': patch
---

Broadcast sync status updates to independent scoped subscribers, replaying only the latest completed status for late listeners. Preserve the synchronous model owner and post-materialization outbox publication, remove the initial read/subscribe gap, and stop the actual scoped listener on unsubscribe. Failed or rolled-back mutations do not announce progress.
