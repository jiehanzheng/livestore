# Web Persistence — Spec

This document specifies persistence and identity in the browser adapter. It
builds on [requirements.md](./requirements.md); topology and leadership are
siblings ([../02-topology/](../02-topology/spec.md),
[../03-leadership/](../03-leadership/spec.md)).

## Status

Draft.

## OPFS Databases

The leader worker owns two OPFS-backed SQLite databases
(`web-worker/leader-worker/make-leader-worker.ts:214-254`), both on the
AccessHandlePoolVFS (single connection per database):

- **State DB** — file name `state<suffix>.db` where `suffix` is the state
  schema hash (`web-worker/common/persisted-sqlite.ts:125`;
  LS.SYS.RT.WEB.PERSIST-R02). A schema change therefore opens a fresh file,
  which is what makes the leader see `dbStateMissing` and rebuild. See the
  trigger chain specified in
  `../../../02-state/01-sqlite/02-schema-management/`.
- **Eventlog DB** — fixed file name `eventlog.db`; versioned only by
  `liveStoreStorageFormatVersion` (see the schema-management node for the
  asymmetry).

Old state-db files are archived/cleaned on leader boot
(`cleanupOldStateDbFiles`, keeping at most `MAX_ARCHIVED_STATE_DBS_IN_DEV
= 3` in dev) to avoid exhausting the OPFS access-handle pool.

## Storage Probes and Fallback

Two independent OPFS probes run (`checkOpfsAvailability`): the client
session probes before deciding the fast path and the app-visible
`storageMode`; the leader worker probes to decide actual DB backing and, on
failure, creates in-memory databases plus a `bootStatus` warning with a
`BootWarningReason` (`private-browsing` on `SecurityError`/
`NotAllowedError`, else `storage-unavailable`). The dual-probe divergence
risk is contracted at the parent level (`LS.SYS.RT-R16`,
[../../.delta/DELTA-002-dual-storage-probes.md](../../.delta/DELTA-002-dual-storage-probes.md)).

## Fast-Path Snapshot Read

Unless disabled or OPFS is unavailable, a booting session reads the state DB
from OPFS (`readPersistedStateDbFromClientSession`). It requires the state system
tables and a completion row. An incomplete capture is discarded. A completed
capture is only a candidate: its owner/transition provenance must still be
admitted by the serving leader before application queries become available.

Both persisted web variants use one `OpenSession` streaming RPC. A serialized
`LeaderSyncProcessor` mailbox turn validates the completed provenance under the
persistence semaphore, returns `Accepted` or `StaleSnapshot` with current bytes,
and attaches a fresh live queue before resolving admission. The first stream
frame contains that admission and migrations report; subsequent frames carry
complete pull items. A stale or absent candidate receives the current projection,
including retained pending work. `openSnapshotSession` waits for this first frame
and completes local SQLite import before either adapter creates its ClientSession.
The returned database supplies its own StateHead cursor. Head equality is not a
source-identity check.

The completion row carries an opaque owner incarnation and completed transition
identity. Construction of a serving persistence owner changes the incarnation;
each completed persistence transition changes the transition identity. The row
is deleted before either database transaction and restored only after both
commits. Dirty captures therefore fail the completeness check, and delayed
completed captures fail provenance admission. Recovery reconstructs from the
complete eventlog before admitting clients; source records are unchanged.

No transition can fall between validation and queue attachment: they occupy one
owner turn, after earlier persistence/publication and before later transitions.
The new session starts at the exact admitted projection and consumes all later
live changes. It does not depend on the legacy sequence-filtered pull cache,
which cannot identify generation-only or confirmation-only transitions.

The live admission queue holds at most 128 pull items. A consumer that exceeds
that limit fails explicitly and detaches; it never silently drops an item or
blocks other sessions. Client frame buffering holds one frame with backpressure.
These limits count items, not payload bytes. Ownership loss or premature stream
completion fails the opener/session; when a terminal failure is available the
stream retains the same originating error as the shutdown notification, so
transport arrival order cannot hide a persistence/constraint cause. No-error
owner loss retains a terminal fallback. It does not silently reopen the stream
against another owner. Callers can create a new Store after normal teardown.
Normal stream completion after successful admission raises the public
`AdmittedOwnerEndedError` defect from `@livestore/common`, with the existing
message “Admitted leader ended; reopen the Store”. Store shutdown preserves this
cause so a caller can distinguish it without matching text. Existing stream
failures and interruptions retain their original causes; materializer and
invariant failures are not relabeled. The error is local to the admitted frame
wrapper, so RPC schemas are unchanged. A caller that chooses continuity must
join the old Store's teardown and create a new Store with fresh admission;
this error never resumes an old snapshot.

No queries are exposed before admission/import. Cancellation and import failure
close the request scope, detach the queue and join the stream producer.

Candidate databases and leader fallback databases belong to the session scope.
The worker stream remains bound to the admitted worker context. OPFS `jSync`
calls `syncFlush`; this protocol relies on SQLite autocommit and the VFS contract,
not a new power-loss guarantee. The retained-file delayed-image regression and
real OPFS/adapter RPC evidence are recorded in
[../../.delta/DELTA-001-fast-path-unvalidated.md](../../.delta/DELTA-001-fast-path-unvalidated.md)
and `contributor-docs/fork-browser-proof.md`.

## Identity Keys

Both persisted variants derive identity via `getPersistedId`
(`persisted-adapter.ts:593-620`; LS.SYS.RT.WEB.PERSIST-R04):

- `clientId` — `localStorage` key `livestore:clientId:<storeId>`, shared by
  all tabs of the origin, created once as `nanoid(5)`.
- `sessionId` — `sessionStorage` key `livestore:sessionId:<storeId>`, per
  tab; survives reloads and same-tab restores; a new tab gets a fresh id.
  Browser tab duplication copies `sessionStorage`, so a duplicated tab
  inherits the same `sessionId` (platform behavior, not guarded).
- Non-window contexts fall back to a fresh random id per boot.

`resetPersistence` deletes the persisted databases and broadcasts an
intentional shutdown (`adapter-reset`) first
(LS.SYS.RT.WEB.PERSIST-R03); it is skipped with a warning when storage is
unavailable (`persisted-adapter.ts:221-230`).


## Close observation

Leader-worker state and eventlog database finalizers retain synchronous close
failures in the owner's scoped exit rather than suppressing them. Every
registered release is attempted even when another fails. SQLite connection
closure and OPFS pool-handle release are separate: `createSyncAccessHandle`
owns each exclusive handle through its acquisition scope. A completed local
Store teardown does not close a shared leader retained by another session.
A worker completion receipt is useful only after its full scope has exited
without cleanup failure; exclusive file availability still needs an independent
OPFS access-handle probe while new writer admission is prevented.
