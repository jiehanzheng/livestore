# 0004 — Correct the JSON storage fingerprint format

Status: accepted for isolated qualification; application adoption remains gated

## Context

Effect 4.1 represents actual JSON encoding with public string content metadata.
The previous annotation lookup misses it, omits JSON schema identity and rejects
JSON-array queries. Even before that change, the descriptor could collide for
JSON `Number` and `NumberFromString` despite different persisted values.

## Decision

On October 29, 2026 the coordinating lead approved an explicit corrected JSON
format under the user's pre-V1 correctness scope. Use the public representation
and an internal `json-schema-v2` descriptor retaining both encoded content and
decoded type. Preserve cosmetic normalizations and unchanged non-JSON hashes;
reject unknown structural representation tags rather than assigning false
identity. Opaque callback behavior without a public persistence representation
remains outside the fingerprint's stated guarantees.

This is an intentional bug-fix format boundary, not a claim that dependency
upgrades can never require reconstruction. Do not preserve a known collision
with a compatibility branch, function hashing or semantic-content removal.

## Consequences

- JSON state filenames change and normal retained-event replay constructs the
  new derived state. Canonical events are not rewritten, reset or reseeded.
- Real file tests must retain source rows, pending/client/session/backend
  identity, client-only document values and compatible decoded facts. Failed
  reconstruction must not publish completion or admit a leader.
- Canonical event schema hashes can also change with Effect: inventory them
  separately and establish decoder compatibility instead of assuming only the
  state cache changes. Incompatible historical source blocks qualification.
  Successful local replay does not establish strict remote acceptance of pending
  events carrying historical schema hashes. That protocol boundary requires
  separate source-matched qualification before adoption.
- State-only writes outside retained events are not promised durable replay.
  Migration hooks already need retry-safe effects; this decision does not
  authorize replay on every completed physical leader open.
- The coordinating app uses no client documents, raw state writes or custom
  hooks and is pre-V1. Its lead requires a fresh candidate before opening prior
  data. This decision authorizes neither app installation nor commit-policy
  activation, and it does not introduce an old-data migration for synthetic data.
