---
'@livestore/livestore': patch
---

Skip disposed subscription effects at dispatch time so a callback can synchronously unsubscribe other subscriptions in the same refresh batch without reading destroyed queries. Preserve direct destroyed-node errors and normal initial reads for replacement subscriptions.
