# 0004 — Qualify a focused maintained-fork workflow

Status: accepted for implementation; commit authority remains conditional

## Context

The user-owned correctness fork needs normal generation, dependency installation,
Effect diagnostics and retained-data qualification. Its attempted Full Setup
could not establish a correct local Nix store. A general recreation of that
system would add tooling ownership unrelated to the SDK change.

## Decision

On October 29, 2026 the human approved “Approve the focused workflow
(Recommended)” in coordinating chat `01a13c15-257b-7010-a157-90c780b4f6fa`.
The reviewed proposal is identified by SHA-256
`ebda1cec985838b43ecd1db6338f5a1445c549ae016420de64af083b6b525d69`.
Implement a small Node/pnpm workflow with canonical Bun Genie, the complete
approved Effect preview, official `@effect/tsgo` 0.63.0 and all relevant SDK
checks. This is an explicit compiler migration from the inherited special
compiler revision; plain TypeScript and ignored diagnostics are not substitutes.

This approval permits implementation and qualification. It does not authorize
committing before replacement gates pass. The inherited precommit requirement
remains effective until the focused lane proves its declared scope, compiler,
format/lint, canonical generation, runtime/crash and source-matched application
acceptance gates. The scoped hook must refuse missing or stale evidence.

## Consequences

- Preserve canonical generator source ownership and normal package-manager
  installation. No handwritten generated outputs, patched installed files,
  incompatible peers or hidden integrity relaxations.
- No global installation, system/Docker changes, registry publication, upstream
  writes or automatic workflow execution is included.
- Unchanged Nix/native SQLite/full website/release inputs can be excluded only
  by a verified scope guard; shared changes may expand the required scope.
- Full Setup remains required outside that scope and for full upstream parity.
- V7/V8 immutable snapshots remain evidence; future projection invalidation
  work is a separate design decision and is not authorized by this workflow.
