---
'@livestore/common': patch
---

Recognize Effect 4.1 JSON codecs through their public representation and use a
versioned storage fingerprint that distinguishes encoded JSON shapes. JSON
fingerprints intentionally change, selecting ordinary reconstruction from the
retained eventlog; canonical events are not rewritten or reset. Unchanged
non-JSON fingerprints remain stable.
