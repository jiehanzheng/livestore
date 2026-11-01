---
'@livestore/adapter-web': patch
---

Allow dedicated-worker factories to return MessagePort and makeWorkerEffect to accept a paired transport port. Applications can join scoped SDK cleanup before terminating their own worker, using Effect's existing MessagePort runner without changing default worker behavior or inner session protocols.
