# Node adapter

Generic co-located SQLite adapter for the qualified format7 core. Pass a stable explicit clientId; caller must retain exclusive physical ownership through actual teardown. Source discovery and common initialization precede derived-state creation. Missing/stale derived completion rebuilds; invalid retained source refuses. No migration, state seed or live import API.

Node VFS omits fsync: process-restart retention is not physical power-loss durability. Worker/devtools surfaces are unsupported.

Implementation promoted from the application-owned generic adapter, informed by Apache-2.0 livestore-contrib commit a5543eba0498a6f1b4968b87f7b61db033472cfb. See LICENSE.upstream. Canonical recovery remains common-owned; platform code never patches event heads or rewrites event identities.
