# Correctness fork delta

This fork preserves LiveStore's Apache-2.0 license and upstream history. Its base
is official main `aafda2024137edb59795f9711c5a877c09450eba`, verified against
upstream HEAD on October 24, 2026. The latest official release checked was
[v0.5.0](https://github.com/livestorejs/livestore/releases/tag/v0.5.0),
`42a59b73f9fb1ad4204f6c52bcaafc249f15eda7`. No upstream contact, registry
publication or Actions execution was performed.

## Architecture thinking

Requirements: preserve authoritative events and pending work, query-dependent
materialization/undo attribution, truthful backend progress, offline recovery,
identity and real nondeterminism checks. Core owns ordering/persistence/recovery;
adapters own SQLite and resource lifetime.

The ideal retained store exposes only state reconstructed from the source or a
fully completed source/state transition. A failed owner cannot keep serving
optimistic cached state. Snapshots obey the same boundary.

The base already includes upstream #1660/#1661: separate execution hashes,
sequential replay, and a leader persistence owner with real eventlog transactions
on ordinary SQLite. Those corrections are retained. Real retained-file tests
confirm the remaining gap: state COMMIT can succeed before eventlog COMMIT,
while the legacy rebuild marker still permits reuse. Logical head/count equality
cannot distinguish the conflicting states.

The repair uses the existing state-completion mechanism as a write-ahead fence,
with a new fingerprinted physical marker name. This avoids a source-format
migration or a cross-database shared revision protocol. Missing completion causes existing empty
state reconstruction from all retained source, including pending events.

## Local changes

- Invalidate state consistency before either transaction; restore it only after
  both commits. Permanently fence failed persistence owners and always notify
  sessions, independent of normal sync-error policy.
- Serialize state snapshot exports with persistence, route adapter/worker/devtools
  exports through core, and reject current-format incomplete explicit seed imports.
- Mark the public Store shut down at teardown admission so cached queries cannot
  outlive a poisoned persistence boundary.
- Rebuild legacy completed state once through the normal compound fingerprint;
  retain eventlog/source/client identity and prune only confirmed derived journal
  records after replay. Source schemas and storage-format version stay unchanged.
- Release every native materialization session on SQL/changeset failure; independent
  review found this bounded lifetime leak and two regressions establish the fix.
- Port standalone SQL-failure and query-dependent B/Undo regressions. Add real-file
  commit/rollback failure, legacy migration, confirmation-only, snapshot and
  public-session regressions, including four real subprocess SIGKILL boundaries.

Owning contract and rejected alternatives:
[consistency-fence decision](../context/02-system/02-state/01-sqlite/02-schema-management/.decisions/0003-persistence-consistency-fence.md).
The maintained gate/results are in [fork-status.md](./fork-status.md), and adoption
instructions are in [fork-consumption.md](./fork-consumption.md).

## Boundaries and overhead

The protocol assumes real SQLite transactions and exclusive leader ownership.
OPFS VFS sync calls `syncFlush`; seven real dedicated-worker termination and
concurrent fast-reader cases now pass in the in-app Browser. This does not qualify
whole-browser process kill, end-to-end adapter leadership or native behavior. Node retained-file tests prove process-termination
recovery, not power-loss recovery: the Node VFS deliberately skips fsync.
The existing Cloudflare eventlog wrapper suppresses SQL transaction control;
this patch does not repair or qualify its partial-source semantics. Its snapshot
routing now uses the shared export owner, without changing its transaction API.
Manual destructive Devtools database replacement is outside the recovery contract.

The fence adds exactly two state autocommits per persistence transition, not per
event. A bounded local Node/WASM file benchmark used 20 warmup transitions then
100 measured transitions, alternating unfenced/fenced/fenced/unfenced on fresh
file pairs. The comparator suppressed only the two fence statements in the same
code; both paths included the new semaphore. For batches of ten events, unfenced
runs were 125.06–138.06 ms and fenced runs 150.06–181.25 ms.
One-event batches were noisy: 54.33–75.37 ms versus 78.66–81.55 ms. The measurement
was refreshed after session cleanup; these small samples do not establish a
stable percentage overhead.
This is a bounded observation, not a portable performance claim. It does not
measure fsync, OPFS or Expo costs. Raw script/results remain locally under ignored
`temp_nocommit/persistence-overhead.ts` and `persistence-overhead-reviewed.log`.

The browser proof and cleanup are recorded in [fork-browser-proof.md](./fork-browser-proof.md).
The actionable cohort/Node migration proposal is in [fork-cohort-proposal.md](./fork-cohort-proposal.md).

## Atomic browser snapshot admission

A further valid retained-file regression exposed delayed completed snapshots:
A1 plus pending B2 is captured before X2 rebases B to B3. Recovery has the right
source/projection, yet a delayed client image misses X even after C4. Baseline:
one ongoing-owner pass, one reconstructed-owner failure; repaired: both pass.

The derived completion row now records opaque owner and transition identities.
One mailbox `OpenSession` turn admits the exact completed image, conditionally
exports current bytes, and attaches a fresh live queue. Both persisted web
variants use that opening contract; core `openSnapshotSession` waits for its
first frame and successful local import before ClientSession/Store exposure.
The validation/subscription interval is eliminated, and same-position and
confirmation changes require no numeric-head/cache heuristics.

New admission queues are bounded at 128 items; overflow fails/detaches the slow
session without blocking healthy sessions. Client buffering is one frame with
backpressure. Owner loss/end closes the session rather than silently reattaching.
Caller cancellation and import failure join stream/queue teardown. Legacy pull
cache APIs remain for existing non-fast-path adapters and are not the new browser
opening contract. Native and Cloudflare admission remain separately unqualified.

The intentional state marker columns change only the derived-state fingerprint.
The new empty-state hash is `b5lfQXwXnEOIvfnMKGgrWU3PEFnp-1Ky8EwAejczjZg`;
the historical pre-fence marker fixture explicitly retains its original id-only
shape/hash. Hash algorithm and eventlog format are unchanged. Full affected lane:
572 passed, two existing skips, 57 files. Browser evidence is eight OPFS cases
plus both real adapter RPC smoke paths; see `fork-browser-proof.md`.

## Preserve terminal persistence causes on admitted streams

Real application diagnostics found that generic admitted-stream closure could
race the shutdown notification and replace the original constraint failure.
Core now normalizes the originating terminal error once and sends the same value
on both paths. It retains the no-error owner-loss fallback, scoped cancellation
and legacy pull teardown. Regression coverage preserves both original SQL
failure positions and asserts the actual MaterializeError/constraint cause.
This is a narrow correction to failure propagation; no source ordering, replay,
recovery, schema, admission or queue-capacity behavior changed.

The per-session admission bounds do not bound the inherited owner-lifetime
legacy replay cache. That remains an explicit limitation; arbitrary eviction
would violate existing late `pull(cursor)` consumers.


## Subscription disposal during refresh — October 25, 2026

A synchronous subscriber callback could dispose another subscription already
captured in the current refresh batch. Its queued effect still ran, read the
now-destroyed query thunk, and shut down the Store. The same dispatch code is
present in the committed fork base; this is independent of persistence repairs.
The graph now checks effect lifetime immediately before dispatch, including
adapter-delayed batches. Direct reads of destroyed nodes still fail.

Baseline regressions: three failures and 25 passes. Repaired focused regressions:
28 passes, including immediate/deferred disposal, replacement subscriptions,
surviving effects and delayed adapter dispatch. The affected Store/common/core
suite passes 582 tests with two existing skips across 58 files; Store TypeScript
passes. The formatter binary is unavailable in Minimal Setup; the full Nix lint
and release gates remain unchanged. New source requires a fresh app install and
qualification; previous browser/native artifacts retain their original hashes
and scope. No new browser/native or approved-preview Bun result is claimed here.


## Explicit dedicated-worker transport — October 28, 2026

Persisted and single-tab worker callbacks may return a `MessagePort`; constructors
still return `Worker`. `WorkerOptions.transport?: MessagePort` selects Effect's
existing `BrowserWorkerRunner.layerMessagePort`, while omission keeps the ambient
runner. This separates SDK transport closure from an application's ownership of
the worker global, allowing the owner to join scoped cleanup before sending its
own completion receipt and terminating the Worker. Inner initial messages,
shared-worker coordination and admission are unchanged. This receipt cannot
attest to physical SQLite close errors suppressed by the underlying adapter.

The live official upstream check found LiveStore v0.5.0 / main
`aafda2024137edb59795f9711c5a877c09450eba` has no endpoint seam. Effect and
platform-browser v4.0.7, checked at browser release source
`b174739b6b39e4bf48f00f38f1d9fde7a6934368`, retain ambient endpoint closure
and expose `layerMessagePort`; no cohort upgrade was made.

Four colocated controls cover endpoint types, default ambient behavior,
transferable outer initialization, inner readiness, joined owner finalization
and preserved finalizer defects over real Node MessageChannels. The four
normal Minimal Setup projects pass 586 tests, two existing skips, 59 files;
adapter source plus colocated tests pass no-emit TypeScript. Independent review
found no blocker. App/browser bootstrap and real worker validation remain
lead-owned; no new actual browser/native result is claimed here.

Automatic review rejected an adapter emit/detachment command because it would
write generated outputs and involve hardlinks. It was not executed or retried.
Tests were colocated in their owning adapter project and validated source-only;
no generated or installed files were changed. Full Nix lint/commit/release gates
and previously recorded qualification limits remain unchanged.


## Typed admitted-owner termination — October 28, 2026

`@livestore/common` now exports `AdmittedOwnerEndedError`, a no-field tagged
error whose message remains “Admitted leader ended; reopen the Store”. Only
normal completion of the local post-admission frame wrapper raises this defect.
Interruption, RPC failures, materializer failures and invariant defects retain
their original causes. No RPC schema, admission, snapshot or resume behavior
changed; callers may join teardown and explicitly seek fresh Store admission.

Focused controls pass ten tests: the tagged defect survives public Store
shutdown observation, an ordinary error with the same message remains distinct,
query/commit fencing and a single open remain enforced, and real constraint
failures remain MaterializeError. All four affected Minimal Setup projects pass
588 tests with two existing skips across 59 files; common source passes no-emit
TypeScript, and independent review found no blocker. App recovery policy and
actual multi-tab handoff acceptance remain lead-owned. All previous APIs,
patches and proof artifacts retain their original scope; no generated or
installed-file edits, native rebuilds or new browser results are claimed.


## Sync-status fanout and listener lifetime — October 28, 2026

The original shared `syncStateUpdateQueue` distributed completed status updates
between observers instead of broadcasting them. Each status stream now owns a
scoped PubSub subscription. One replay snapshot seeds late listeners; with no
listeners no historical queue accumulates. The synchronous model stays the sole
state authority, and the same outbox sites publish only after materialization
and owner release. Failed owner bodies discard their notifications.

`Store.syncStatusStream` consumes current-plus-updates directly, establishing
its subscription before the first callback can commit. Unsubscribe immediately
stops callback delivery and joins the bootstrap fiber before interrupting the
actual scoped listener; previously it interrupted only the completed bootstrap.
Processor shutdown closes the PubSub before acknowledging completion, and scope
cleanup releases it as well. Other subscribers remain independent.

Upstream checked on October 28: maintained main
[`aafda202`](https://github.com/livestorejs/livestore/blob/aafda2024137edb59795f9711c5a877c09450eba/packages/@livestore/common/src/sync/ClientSessionSyncProcessor.ts)
and release v0.5.0 still contain the queue. The
[SubscriptionRef proposal #1238](https://github.com/livestorejs/livestore/pull/1238)
was closed without merging and predates the synchronous owner architecture.
[Status API #967](https://github.com/livestorejs/livestore/pull/967) introduced
the public surface; [#1535](https://github.com/livestorejs/livestore/pull/1535)
fixes fanout only in MockSyncBackend. No supported configuration or directly
compatible maintained replacement was found. No upstream writes occurred.

A public Store baseline on frozen V5 fails waiting for both observers to receive
progress. Repaired controls cover local/shared broadcast after materialization,
initial-callback commits, independent and pre-bootstrap unsubscribe, actual
listener finalization, late/no-listener replay, Store shutdown completion, and no
false progress from rolled-back local/shared writes. Three existing processor
tests now select completed state transitions rather than draining shared queue
history; their original rebase/pending/rejection oracles remain intact.

The four affected Minimal Setup projects pass 595 tests, two existing skips,
61 files. Common and Store source no-emit TypeScript pass. Independent review
found no blocker. Existing V5 terminal errors, V4 transport and earlier repairs
remain unchanged. App installation, managed-session cleanup and real browser/
iOS acceptance remain lead-owned; no new app result is claimed here. Generated
output, installed files, dependencies and host storage were not changed. Full
Nix lint/commit/release gates remain unchanged.


## Scoped leader-election lock — October 28, 2026

Interrupted opening could retain the tab's Web Lock: acquisition completed
before snapshot admission, but the release Deferred's finalizer was registered
only after successful boot. The acquisition callback's AbortSignal does not
own the later adapter lifetime. A “Releasing lock” debug message came from a
different finalizer and did not prove release.

An internal `makeLeaderElectionLock` now owns the release Deferred with
`Effect.acquireRelease` before exposing immediate or waiting acquisition. The
persisted adapter uses that handle and no longer completes the Deferred from
the late boot-only finalizer. Later SDK resources finalize before the earlier
lease owner signals release. Follower promotion and a grant callback arriving
after owner closure use the same release ownership. Public utility APIs and
all V6/core repairs remain unchanged.

Current official main
[`aafda202`](https://github.com/livestorejs/livestore/blob/aafda2024137edb59795f9711c5a877c09450eba/packages/@livestore/adapter-web/src/web-worker/client-session/persisted-adapter.ts)
was rechecked on October 28 and retains the late finalizer. Related reports
[#734](https://github.com/livestorejs/livestore/issues/734) and
[#954](https://github.com/livestorejs/livestore/issues/954) do not supply a
maintained correction for this ownership gap. The initially considered simple
shared-worker self-join is guarded against by the pinned Effect runtime and was
not used as the fix's rationale.

A finite probe of the original helper with the approved Effect 4.0.6 preview
and a deterministic LockManager fixture reproduced a held lock after joined
opening interruption; its acquisition signal remained un-aborted and the
release Deferred incomplete. Explicit probe cleanup released and joined it.
Six production-helper controls pass: startup interruption/failure, SDK cleanup
ordering, follower promotion, queued cancellation, and a late grant callback.
The four affected Minimal Setup projects pass 601 tests, two existing skips,
62 files. Adapter source and colocated tests pass no-emit TypeScript;
independent review found no blocker.

The probe and controls validate ownership mechanics with isolated browser-boundary
fixtures; they are not a complete adapter boot or actual-browser Web Locks test.
Same-origin close/reopen acceptance, managed-session joins and normal package
refresh remain lead-owned. No generated/installed output, dependency, public
upstream or host-storage mutation occurred. Prior V6 artifacts remain immutable;
full Nix lint/commit/release gates remain unchanged.


## Strict local teardown candidate — October 29, 2026

V8 is a source candidate; the app still selects frozen V7 until lead-owned normal
installation and acceptance. Previous patches, manifests and proof remain
immutable. No commit, package version change or release has occurred.

`shutdownPromise` now observes the actual bounded request rather than just its
fork bootstrap. `shutdownAndWait` and `shutdownAndWaitPromise` start or join the
same createStore-owned teardown fiber as bounded shutdown and scope disposal.
Its creation/publication is serialized before observers can cancel or start a
second cleanup. Strict observers retain cleanup failures and hard drain timeout;
local scope cleanup still runs on timeout. Cancelling a waiter leaves the owned
cleanup running, and later/repeated observers see the same outcome and first
request cause. `shutdownDeferred` remains a bounded-request notification, not a
strict completion receipt.

Both leader-worker DB finalizers now retain synchronous close failures through
scope exit. OPFS exclusive handles have their own scoped releases. Local Store
completion does not shut down another session's shared leader or attest to
exclusive file availability; worker owner Exit and independent OPFS handle
probing remain separate evidence. No retry of an ambiguously closed connection
or transport receipt masquerading as physical closure was added.

The normal four affected Minimal Setup projects pass 612 tests with two existing
skips across 64 files, including 11 new controls. Store, common and adapter
source/tests pass no-emit TypeScript; independent lifecycle review found no
blocker. The real browser shared-owner/physical-handle proof remains lead-owned.
Current official main remains aafda202 and latest release v0.5.0; no maintained
strict observer or close-error fix was found there. Full Nix/precommit/type/test
qualification, canonical preview subprocess crash cases and immutable commit
readiness remain required. Temporary supported-toolchain bootstrap investigation
is separate from this source candidate and is not a gate waiver.

## Local commit outcomes

The fork adds public `Store.commitWithOutcome` / `LocalCommitOutcome` without
changing legacy `commit`, durable events or transport messages. One shared
savepoint implementation retains rollback/release completion evidence; the
client-session owner supplies rejection only before admission. Local execution
hashes are staged, rollback restores the diagnostic head, and native changeset
sessions finish even on materializer failure. Session-cleanup failure remains
indeterminate. Local acceptance is not durability or server acknowledgement.
