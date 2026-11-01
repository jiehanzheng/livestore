# 0006 — Preserve contracts while qualifying Effect diagnostics

Status: accepted for isolated qualification; commit authority remains conditional

## Context

The maintained Effect 4.1 SDK intentionally integrates capabilities marked
unstable by the official compiler. The compiler also recommends nominal schema
classes, while the public sync-state DTOs deliberately accept structural values.
Suppressing diagnostics globally would hide unrelated mistakes; branding every
class would narrow the existing DTO contract.

## Decision

On October 29, 2026 the coordinating lead approved project-scoped unstable API
allowlists and exact-file semantic exceptions through canonical generator
sources. Runtime capabilities stay local to their owning SDK package. Test
tooling is allowed only in test files or dedicated test projects. Requalify
these integrations when changing the pinned Effect cohort.

Keep errors, warnings and suggestions contributing to compiler exit status.
Keep the missing-brand rule active except in `common/src/sync/syncstate.ts`,
whose five public DTO classes retain their structural contract. Give the
remaining tagged errors nominal type identities without changing constructors,
encoded schemas or runtime behavior; local schema test classes may also receive
type-only brands.

Two deliberate test subjects receive exact-file exceptions: the fingerprint
regression compares unrestricted Number and NumberFromString codecs, and two
session tests invoke runSyncExit to test synchronous commit boundaries. Other
number schemas and nested runtimes remain diagnostic subjects.

## Consequences

- Negative controls must retain diagnostics for unlisted unstable/experimental
  APIs, test tooling in runtime files, ordinary TypeScript errors, other
  suggestions within an excepted file, and the same rule outside that file.
- Type-erased emission, constructor/decoder consumers, schema fingerprints and
  runtime tests must validate the nominal error change. Plain error-object
  assignment is not evidence for an exception: these errors already implement
  the YieldableError protocol.
- These settings apply only to the selected SDK owners. They neither qualify
  excluded dependency closures nor activate a contributor-policy exception.
