---
'@livestore/common': patch
'@livestore/livestore': patch
'@livestore/adapter-web': patch
'@livestore/adapter-cloudflare': patch
---

Reconstruct derived state from the retained eventlog after interrupted or failed
leader persistence. Serialize leader snapshots with persistence, reject incomplete
snapshot imports, and close public Store operations before failure teardown.
This fork requires one derived-state rebuild; source events and identities remain.
Cloudflare transaction semantics and platform power-loss durability remain unqualified.

Admit browser snapshots by completed owner/transition provenance and attach their
live changes atomically before exposing queries. Explicitly replace stale images;
close on owner loss or bounded catch-up overflow. Add the core `openSnapshotSession`
consumer and `LeaderSyncProcessor.openSession` contract for compatible adapters.

Preserve the originating terminal persistence error on admitted streams as well
as shutdown notifications, so a stream closure cannot hide a constraint failure.
