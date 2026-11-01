# DELTA-001 — Fast-path snapshot trusted without validation

Status: resolved in the user-owned correctness fork (2026-10-24); full tooling and application/native adoption remain gated

## Divergence

LS.SYS.RT-R15 requires fast-path-derived head/state to be validated against
what the leader would report. Before the fork repair, the web fast path reads the persisted
state DB directly from OPFS and derives `leaderHead` from
`__livestore_state_head`, while the leader derives its head from the
eventlog — two sources that can diverge. The snapshot's system tables and
rebuild-completion row are checked before fast-path use (the #1605 recovery fix),
but its head and identity were not validated against the leader.

## VRS

[requirements.md](../requirements.md) LS.SYS.RT-R15 (adopted 2026-07-16,
interview); spec §Session Boot captures the dual-source reality.

## Implementation Contract

On fast-path boot, verify the derived head (and, cheaply, the snapshot
identity) against the leader once it is reachable; on mismatch fall back to
the slow path instead of proceeding on divergent state. Close this delta
when the validation exists and is exercised by a test.

## Resolution and evidence

A valid retained-file reproduction captures confirmed A1 plus pending B2, then
retains canonical X2 and rebased B3 across an interrupted source commit. Ongoing
owner catch-up passes; reconstructed-owner delivery leaves the old session
missing X even after a later C4 (baseline one pass/one fail).

Core now admits completion provenance and attaches a fresh live queue in one
serialized mailbox turn. The web adapters wait for the first admission frame and
completed local import before constructing ClientSession. A delayed completed
image is explicitly rejected as `StaleSnapshot` and replaced; later changes use
the already-attached queue, not sequence-filtered cached history. Owner loss,
overflow, cancellation and import failure have terminal, owned teardown paths.

The exact retained pending-action test now passes both modes. The 572-pass
core/Store lane includes admission, same-position replacement, confirmation,
concurrent opener, cancellation, overflow and ownership-loss coverage. The real
OPFS matrix passes eight checks, and real single/shared adapter RPC cold reopen
plus concurrent shared-owner sessions pass. See
`contributor-docs/fork-browser-proof.md` for exact source/result identities and
limits. This resolves LS.SYS.RT-R15's implementation gap; it does not qualify
native adapters or whole-browser/power-loss behavior.
