# Fork repair workspace

This checkout owns library repairs. Application reproduction paths below are relative to `/Users/jiehan/.codex/worktrees/133b/ecbks`, not this repository. The authoritative application handoff is `docs/development/livestore-fork.md` in that checkout.

# LiveStore fork: correctness repairs and integration gate

Owner: this lead chat coordinates application integration; the independent
LiveStore repair chat owns library changes in `~/workspace/livestore`.

## Authorization and architecture

On October 24, 2026, the user authorized maintaining their own upstream fork,
an independent repair chat reporting to this lead, and using the qualified fork
in ECBKS. The approval is recorded in the lead chat and the ECBKS dependency-maintenance decision log.

Fork: https://github.com/jiehanzheng/livestore
Upstream: https://github.com/livestorejs/livestore
Lead: `codex://threads/01a13c15-257b-7010-a157-90c780b4f6fa`.

Requirements: preserve durable pending work, deterministic query-dependent
materializers, undo attribution, truthful synchronization progress and offline
reopen after interrupted writes. Keep event ordering, transactions, replay and
recovery in LiveStore core. Platform adapters own SQLite/resource integration;
application code must not repair internal heads or hide invalid projections.

The event log is authoritative. The state database and materialization journal
are derived. Prefer existing official corrections over reimplementations. A
fork permits reviewing and maintaining missing core fixes without installed-file
patches, forced peer compatibility, or application-level recovery machinery.

## Baseline and evidence

Reproduced baseline: `@livestore/common` and `@livestore/livestore` 0.5.0.
Approved Effect preview source:
`97ea6904cdb7436f5142fe35b09d3136f73e7d8b` (package version 4.0.6).
Inspected newer upstream snapshot:
`13a6883da46b9a9234006ecc6e5f17697cee92e0`.
Resolve the actual fork base immutably and record its full SHA before repairs;
these historical identities do not assert the latest available upstream version.

Untracked investigation evidence is in
`temp_nocommit/core-correctness-20261023/`: `upstream-findings.md`,
`pr1660-replay-comparison.md`, `sql-reopen-characterization.log`, and captured
immutable upstream source. Do not depend on these artifacts remaining available:
port minimal standalone regression tests into the fork.

### 1. Backend cursor survives a failed event application — reproduced

The pull path saves `__livestore_sync_status.head` before materialization and
event insertion finish. Injecting a duplicate-primary-key failure rolls back
the projection/event inserts, but retains head 2 with only event 1. Offline
reopen fails: “During boot the backend head (2) should never be greater than
the local head (1)”. Local-only rollback cases pass; shared-pull cases fail.

Reproduction: `packages/graph-live/tests/diagnostics/shared-sql-failure.test.ts`;
control: its sibling `sql-failure.test.ts`. Retain both failure positions,
after the object write and after the outcome write, and the offline reopen.

Public reports: [409](https://github.com/livestorejs/livestore/issues/409),
[1532](https://github.com/livestorejs/livestore/issues/1532).
Existing repair direction: [1661](https://github.com/livestorejs/livestore/pull/1661).

Required repair: one leader persistence owner. Event inserts, rebase deletions,
confirmation metadata and backend progress share a genuine eventlog transaction.
Publish progress/results and release pushes only from successful persistence
receipts. Inspect real adapter transaction behavior; a transaction-shaped API
is not evidence of atomicity. Stop a store after uncertain rollback/commit.

### 2. Rebase compares materialization against a stale base — reproduced

Canonical value A; pending edit B followed by undo U; competing canonical X
arrives. Replaying B must record X as its prior value, so U restores X. In
0.5.0, B retains the session SQL hash produced over A and leader replay compares
it with the legitimate SQL produced over X. Development mode terminates with
`MaterializerHashMismatchError`. The identical production-mode case passes;
this is characterization, not permission to disable the guard.

Reduced public-contract reproduction:
`apps/client/src/acceptance/transport-push-hold/replay.test.ts` and its
`replay-schema.ts`. No graph wrappers or transport admission are needed.

Related report: [503](https://github.com/livestorejs/livestore/issues/503).
Existing repair: [1660](https://github.com/livestorejs/livestore/pull/1660),
part of a dependent upstream stack, not an isolated drop-in patch.

Required repair: immutable encoded events; execution hashes stored separately;
hash actual sequential materialization; discard rolled-back execution hashes;
recompute pending replay hashes; compare equivalent executions at confirmation.
Distinguish event identity from a possibly overlapping sequence position.
Preserve genuine nondeterminism detection and transactional in-memory bookkeeping.

Oracle: final value X, owner U; exactly one B history row and one U-owned final
row; original pending actions survive, no terminal mismatch. Add multiple
rebases and later confirmations without changing the oracle to make it pass.

### 3. Split database commit recovery — suspected, not reproduced

Inspected `LeaderPersistence` commits state first, then eventlog. A process
death or failed second COMMIT cannot roll back the already committed state.
Inspected boot rebuilds only on missing initialization/tables, not a mismatch
between the state execution and retained source. Do not label this confirmed
corruption until a real retained-file reproduction demonstrates it.

First inject failure after successful state COMMIT and before eventlog COMMIT,
close/reopen offline, then inspect source events, pending events, state, journal
and heads. Also terminate a separate process at the boundary; thrown exceptions
alone do not test crash behavior. Verify whether newer upstream already repairs it.

Proposed repair if confirmed: generate one unique persistence revision per
transition and store matching revisions inside each database's own transaction.
Before exposing a store or starting synchronization, compare revisions and
rebuild mismatched derived state/journal from the complete retained log,
including pending work. Mark reconstruction complete and stamp its source
revision atomically. Serialize against writes during reconstruction. Cover
confirmation-only changes and same-head/same-count rebases; numeric head equality
alone cannot identify equivalent state. An alternative is welcome if simpler
and supported by an equally strong failure/recovery argument.

Never erase source events or silently clamp a cursor to conceal corruption.
An unreadable/invalid source must be preserved and reported. A failed or
ambiguous commit must close/fence the live instance until durable truth is
re-established. Test failure during reconstruction and restart it safely.

## Delivery and acceptance

- Repair chat owns the fork only; lead owns application dependency selection,
  public adapter adaptation, application tests and existing PR stack.
- Questions, blockers and completion go to the lead. Direct user input in the
  repair chat changes only that narrow slice. No approval to contact upstream.
- Use local tests only. Disable fork GitHub Actions before pushes, preserve
  upstream workflow history, and do not add/dispatch automatic workflows.
- Keep source provenance, original license and a concise maintained fork delta.
  Use immutable commits/artifacts with integrity; no floating branch installs,
  unreviewed registry publication, or installed `node_modules` edits.
- Package the complete required peer-compatible family. Missing published Node
  or S2 adapters do not justify mixing old core packages with new core packages.
- Prove baseline failures and repaired success, real file reopen, process kill,
  ambiguous commit result, rollback failure, same-head rebase, pending retention,
  multiple rebases, confirmation and genuine nondeterminism controls.
- Application adoption requires renewed local web and assigned iOS Simulator
  acceptance. Preserve PFM, existing approved origins, process ownership and
  keyboard-capture prohibition. No physical device or homelab work is required.
- Report exact base/head SHAs, concise diff ownership, exact test commands and
  results, remaining risks and package-consumption instructions to the lead.

The application worktree currently has unrelated in-flight changes and an
unqualified mixed Effect installation. Do not use that dependency tree as a
trusted baseline or claim its tests qualify the fork. Re-establish one coherent
family before application acceptance. Preserve the existing public PR layout.
