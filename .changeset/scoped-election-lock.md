---
'@livestore/adapter-web': patch
---

Own the leader-election lock release before immediate or waiting acquisition. Interrupted or failed startup, including a late grant after scope closure, releases the lease without waiting for successful snapshot admission. Preserve cleanup ordering by finalizing later SDK resources before signaling release.
