# Expo adapter

Generic co-located SQLite adapter for the qualified format7 core. Pass a stable explicit clientId; caller must retain exclusive physical ownership through actual teardown. Source discovery and common initialization precede derived-state creation. Missing/stale derived completion rebuilds; invalid retained source refuses. No migration, state seed or live import API.

`makeOwnedAdapter` returns the same adapter implementation plus `assertClosed` for positive native resource-ledger attestation. `makeAdapter` delegates to it. Expo platform conformance still requires actual native SQLite.

Implementation promoted from the application-owned generic adapter, informed by Apache-2.0 livestore-contrib commit a5543eba0498a6f1b4968b87f7b61db033472cfb. See LICENSE.upstream. Canonical recovery remains common-owned; platform code never patches event heads or rewrites event identities.

The adapter may establish only its configured declared base with idempotent/intermediate directory creation. It then enumerates descendants read-only to determine source absence before any SQLite factory. It never scans ancestors or treats exists=false as absence. Base creation/list failures refuse startup. The default Expo SQLite directory is not assumed to preexist.

`expoPersistencePaths` is a validated pure layout utility for caller-owned closed-file policy. It grants no IO, pruning, adoption or deletion authority.
