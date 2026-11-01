# SQLite Schema Management — Spec

This document specifies how LiveStore detects SQLite state-schema changes,
selects a state database, and rebuilds derived state. It builds on
[requirements.md](./requirements.md) and the parent [SQLite spec](../spec.md).

## Status

Draft.

## Rebuild Trigger

Schema changes rebuild state through database identity, not by dropping
mismatched tables in place:

1. `makeState` computes one compound fingerprint from every state table,
   including LiveStore's system tables.
2. Adapters include that fingerprint in the persisted state-database name.
   The web adapter uses `state{fingerprint}.db` inside a
   storage-format-versioned directory. The Cloudflare adapter uses
   `state{fingerprint}@{liveStoreStorageFormatVersion}.db`.
3. A different fingerprint therefore opens a fresh, empty state database.
   During leader boot, missing state system tables or a missing rebuild-complete
   row causes `recreateDb` to run.

`migrateDb` never drops or clears tables; it uses `create-if-not-exists`.
Eventlog replay does not clear existing rows either. These operations are safe
because boot replaces incomplete derived state with an empty database before
running them. A mismatched fingerprint stored inside an existing database does not trigger a
rebuild by itself. The adapter-level database name is the rebuild trigger.

When the web adapter opens the selected state database, it deletes other state
database files. In development it archives up to three old files instead.
The Cloudflare adapter tracks state files it opens and removes other tracked
state-file pages after successful boot, including completed-state reuse.
Untracked historical files are preserved. Cleanup failure does not prevent serving the
completed store and is retried on the next successful boot.

## State Fingerprint Contract

LiveStore computes fingerprints synchronously from a canonical descriptor of
the normalized SQLite AST:

- A table fingerprint identifies one table and is stored in
  `__livestore_schema`.
- The compound fingerprint includes all state tables and selects the persisted
  state database.

For each table, the descriptor records:

- The table name and column order.
- Each column's name, SQLite type, primary-key status, nullability,
  autoincrement behavior, and default.
- Each index's name, uniqueness, primary-key status, and ordered columns.

Tables and indexes are treated as unordered collections and sorted with
locale-independent code-unit ordering. Column order within a table or index
remains significant.

For a JSON text column, the internally versioned `json-schema-v2` descriptor
includes Effect's public encoded and type representations. JSON is recognized
from the encoded string representation's `content.mediaType`, not from a
descriptive AST annotation. Its `content.schema` distinguishes the shape inside
the stored JSON string; the type side distinguishes decoded codecs. Consequently,
`SqliteDsl.json({ schema })` and
`SqliteDsl.text({ schema: Schema.fromJsonString(schema) })` produce the same
fingerprint without separate schema-provenance metadata.

If `State.SQLite.json()` is used without a schema, its value schema is
`Schema.Any`. Stored row values are never fingerprint input, so changing an
informal JSON shape without changing the declared schema does not trigger a
rebuild.

LiveStore allowlists its own semantic AST fields instead of serializing entire
runtime objects. Compile-time rest-key assertions and exhaustive tag switches
require new LiveStore AST fields to be classified. Within Effect's public
schema representation, LiveStore ignores the generated `annotations` and
`isMutable` fields. Identically named fields inside an application-owned
representation `payload` remain part of the fingerprint. Effect representation
arrays retain their upstream order.

The v2 boundary intentionally changes JSON fingerprints: the previous descriptor
could give `Number` and `NumberFromString` identical identities despite storing
`42` and `"42"`. Such a collision must not be preserved. The new state filename
selects normal replay from retained source; no event rewrite, source reset or
old-format reader is introduced. Unchanged non-JSON fingerprints remain stable.
See [decision 0004](./.decisions/0004-json-fingerprint-v2.md).

Within this format, cosmetic dependency representation changes are normalized
only when semantic equivalence is established. Semantic encoded content must
not be discarded merely to retain an old hash. A Union without a `mode` field is hashed with `mode: "anyOf"`.
Renamed check ids are hashed under their original names, for example
`effect/schema/isBetweenLength` as `effect/schema/isLengthBetween`. Removing a
normalization changes the fingerprint of every schema that uses the affected
representation.

Unknown structural representation tags fail closed. Application-owned payload
keys remain data, including keys named `_tag` or `content`.

Canonical UTF-8 bytes are digested with one shared synchronous SHA-256
implementation and encoded as an unpadded 43-character base64url string. The
same implementation runs in every adapter. It is internal and has no
application-configurable schema version, algorithm, override, or opt-out. The
base64url encoding retains all 256 digest bits while keeping Cloudflare state
filenames within its SQLite VFS limit.

This contract avoids Effect's private runtime AST shape, but it is not a
complete identity for arbitrary Effect behavior. Effect's public representation
does not identify transformation callbacks, so codecs with the same encoded and
type sides can produce the same fingerprint despite behaving differently. The
same limitation applies to `Schema.declare` callbacks without a public
`representation`.

## Rebuild Sequence

`recreateDb` performs the following operations against the fresh state
database:

1. Run the `init` migration hook.
2. Create state tables and record their table fingerprints.
3. Run the `pre` migration hook.
4. Replay the full eventlog through the current materializers.
5. Discard journal records at or below the retained backend head; pending records remain.
6. Run the `post` migration hook.
7. Insert the singleton consistency row (`id = 1`) in `__livestore_state_consistency`.

Replay consumes eventlog pages in order, with each page committed in one
state-database savepoint. The per-client runtime parameter
`createStore.params.stateRebuildBatchSize` accepts positive integers and defaults
to 100. It controls both the eventlog page and savepoint batch; it is
not part of the state fingerprint, so changing it does not trigger a rebuild.
Application rows, the state head and undo metadata commit together for each
batch. Failure or interruption rolls back the current batch. Earlier batches can
remain in the incomplete database, which boot discards before retrying. Progress
still reports each processed event, not a durability boundary. Lower values can
reduce per-batch resource usage at the cost of more queries, savepoints and
persistence writes. The event count does not bound payload bytes, materializer
work, WASM capacity or total client memory.

Table existence and the state head alone do not prove completion: a materializer
can fail partway through replay, or a hook can fail after replay reaches the tip.
Boot reuses state only when all state system tables and the completion row exist.
Otherwise it replaces the derived database using SQLite's backup/import operation
from an empty in-memory database, before creating materializers or running hooks.
This discards partial application rows, hook-created objects and undo data without
altering the eventlog or its pending events and sync metadata. Recovery does not
depend on failure finalizers deleting the state file.

Both browser session variants apply the same check when loading an OPFS snapshot
for fast-path boot. An incomplete snapshot falls back to the leader's recovered
snapshot before the session becomes available to application queries. A completed
capture is also validated against the serving owner's completed transition;
completion at capture time alone cannot admit a delayed image. Validation,
conditional export and attachment of subsequent changes occupy one serialized
leader turn. Both web variants await admission and local import before exposing
ClientSession; see the web persistence opening contract.

Completion is recorded only on the successful path, never by a finalizer. Hooks
can run again after a failed/interrupted rebuild. External hook side effects must
tolerate retries; the marker does not make them exactly-once.

The same marker fences live persistence. The leader deletes it in a separate
state autocommit before opening either database transaction, then restores it
only after both commits succeed. Every failure fences that persistence owner
and shuts down its sessions, including when ordinary sync errors are ignored.
Public Store reads/commits are fenced as teardown starts. A failed final marker
write also closes the owner; it cannot publish a receipt. A process death at
any intermediate boundary leaves either a consistent completed pair or an
incomplete state database that boot reconstructs from the full retained source.
This covers same-head/count rebases and confirmation-only journal changes.

Leader snapshot exports share the persistence semaphore and reject failed
owners. Both OPFS fast-open variants reject the absent marker. Explicit
in-memory seed imports may migrate legacy snapshots with no marker table, but
must reject a current-format table with no completion row. Devtools database
replacement remains an explicit destructive administrative operation, not a
recovery path; it is outside this crash-recovery guarantee.

The marker table participates in the compound state fingerprint. Upgrading from
the legacy `__livestore_rebuild` marker selects a fresh derived database and
causes a one-time rebuild, including for previously complete databases. Legacy
completion proves only that boot finished, not that the last live transition
committed in both databases, so compatibility readers cannot safely trust it. No eventlog schema or
storage-format version changes. This protocol detects incomplete **readable**
SQLite databases, not arbitrary file corruption or loss of the eventlog.

See [the completion/recovery decision](./.decisions/0001-rebuild-completion.md)
and [the replay batching decision](./.decisions/0002-batch-replay-writes.md).
The fork extends completion into a live fence in
[decision 0003](./.decisions/0003-persistence-consistency-fence.md).

The rebuild produces a `migrationsReport` surfaced through adapter boot info.
On the Cloudflare Durable Object adapter, replay writes the newly materialized
rows to Durable Object storage and can therefore incur billed row writes.

## Schema-Meta Tables

Two system tables track hashes (`system-tables/state-tables.ts`):

| Table                           | Keyed by    | Tracks                                       |
| ------------------------------- | ----------- | -------------------------------------------- |
| `__livestore_schema`            | `tableName` | textual table fingerprints + `updatedAt`     |
| `__livestore_schema_event_defs` | `eventName` | event-definition schema hashes + `updatedAt` |

Event-definition hashes feed drift detection on read
(`LS.SYS.EVT-R08`); unknown hashes are tolerated so newer-app logs do not
brick older readers.

## State vs Eventlog Versioning — asymmetry

| Mechanism          | State DB                                                      | Eventlog DB                                                                            |
| ------------------ | ------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Persisted identity | compound state fingerprint plus storage-format namespace      | `liveStoreStorageFormatVersion`                                                        |
| Schema change      | opens a fresh database and replays the eventlog automatically | **no auto-migration; schema changes without a version bump cause permanent data loss** |
| Recovery source    | eventlog                                                      | none; the eventlog is itself the source of truth                                       |

The eventlog side is guarded only by a code comment
(`eventlog-tables.ts:10`: "NEVER modify eventlog schemas without bumping
`liveStoreStorageFormatVersion`") and a TODO for a proper versioning system.
This asymmetry is the sharpest edge of the schema-management story and is
captured honestly rather than as a guarantee.

## Open Design Questions

- **LS.SYS.STATE.SQLITE.SM-DQ1 Format-bump policy.** What an incompatible
  `liveStoreStorageFormatVersion` bump owes users — refuse to open, migrate,
  export, or the current silent soft-reset/orphaning — is deliberately
  undecided (2026-07-16 interview). Blocked on: a migration/export story
  design.
