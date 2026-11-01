# 0003 — Fence incomplete leader persistence with state consistency metadata

Status: accepted in the user-owned correctness fork (2026-10-24), based on the retained-file regressions in `tests/package-common/src/leader-thread/persistence-recovery.test.ts`; full tooling/application-native qualification remains pending; the standalone real OPFS worker proof is recorded below.

## Context

The existing two-database transaction boundary commits derived state before
source. Rejected eventlog COMMIT leaves a completed state containing a different
event at the same logical head/count. Unchanged upstream boot reuses it. The
retained-file regression fails against base aafda2024137edb59795f9711c5a877c09450eba.
The original rebuild marker proves boot completion, not the latest live commit.

## Decision

Use a state-only write-ahead fence: invalidate completion in an autocommit before
either database transaction; restore it only after both commits succeed. Missing
completion invokes existing empty-state reconstruction from the complete retained
eventlog. Preserve source records, pending events, backend metadata and identity.
Prune only confirmed derived journal records after replay.

Any failed transition fences its persistence owner and closes sessions. Store
teardown rejects public operations before asynchronous cleanup. Snapshot exports
serialize with persistence; current-format incomplete imports and OPFS fast opens
are rejected. The new physical state marker name changes the normal compound
fingerprint, rebuilding legacy state without changing source format/version.

## Alternatives

- Shared unique revisions can detect the same gap, but require source metadata
  changes and a separate rule for state-only browser fast opens.
- Head/count equality misses same-position rebases and journal-only changes.
- Rollback cannot undo an already committed independent database.
- Compatibility readers trusting the old completion row preserve the defect.

## Consequences

Two extra state autocommits per transition trade write throughput for recovery
without source migrations. Batches amortize these writes across events. Completed
boots remain read-only. The protocol inherits adapter durability; Node's VFS
currently skips fsync, and Cloudflare's direct eventlog drops transaction control.
Neither power-loss durability nor Cloudflare atomicity is established here.
Manual Devtools replacement is an administrative path, not crash recovery.

## Evidence

The real-file matrix covers rejected and ambiguous commits, rollback/completion
failure, same-head/count replacement, legacy completed-state upgrade, and
confirmation-only changes. Separate subprocesses receive SIGKILL before state
commit, between commits, after eventlog commit and after completion restoration;
normal offline common-leader boot checks source, pending work, projection,
journal and heads. Existing rebuild tests cover interrupted reconstruction and
hook/materializer failure. Snapshot serialization, incomplete imports, mandatory
shutdown under ignored sync errors, public cached-query fencing, multiple
query-dependent B/Undo rebases and genuine nondeterminism have standalone tests.

The standalone maintained browser page and worker fixture
`packages/@livestore/adapter-web/src/web-worker/common/persistence-recovery.test-fixture.{html,ts}`
pass seven checks in the Codex in-app Browser against real OPFS: four abrupt
worker-termination boundaries, a concurrent fast reader, interrupted reconstruction
and confirmation-only recovery. An exclusive-owner Web Lock models handoff after
termination; no sleeps/retries or application recovery logic are involved. Source,
pending identity, journal, heads and marker are checked. This is dedicated-worker
termination, not whole-browser crash, power loss or native acceptance. Exact
source hashes, raw results and cleanup are in `contributor-docs/fork-browser-proof.md`.

## Completed captures and admission

A completion row alone describes capture-time consistency. A delayed valid image
can arrive after recovery under a new leader whose process-local pull history is
empty. The valid A1/B2 -> A1/X2/B3 retained-file regression confirms persistent
session divergence after a later C4; the ongoing-owner control passes.

The same completion row now identifies an owner incarnation and completed
transition. `OpenSession` checks it and attaches a fresh live queue in one core
mailbox turn, exporting replacement bytes under the persistence semaphore on
`StaleSnapshot`. Both web variants wait for admission/import before exposing a
Store. All later changes reach the queue without cached-head filtering. Normal
stream end, owner loss and bounded-buffer overflow are terminal; cancellation
and failed import detach and join owned resources. This extends the existing
consistency contract rather than adding application recovery.

Independent read-only protocol review found the mailbox ordering sound and
caught interruption being turned into a defect; that was corrected and covered.
The retained delayed-image case now passes both modes. Eight OPFS cases and two
real adapter RPC checks pass; the latter includes concurrent shared-owner client
sessions within one page, not a full multi-tab/whole-browser takeover campaign.
Earlier seven-check source/result artifacts remain historical evidence only.
