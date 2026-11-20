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

## November 19, 2026 — Named maintained owners

The human approved **“Extend Node/pnpm qualification (Recommended)”** in the
coordinating chat (answer to `call_4e2609aa0eef498391bd00ddbe6ab6b8`). The
reviewed Full Setup checkpoint proposal has SHA-256
`380ed5c640184f4197f66f9190e809246637b9ed37705ed10762ae913101cbbf`;
option B is the approved change. The earlier October approval and compiler
profile above remain historical, not descriptions of today's installed tools.

Support the normal Node/pnpm workflow for these named owners: the docs site and
snippet workspaces, `astro-twoslash-code`, `astro-tldraw`, maintained example
commands/generation, and the Cloudflare TodoMVC, web TodoMVC, script TodoMVC,
Sync-CF TodoMVC, email, tutorial starter and LinearLite demos. Standalone Expo
and platform application journeys retain their separately bound native proofs.
Use the existing declared tool profile: Node 24, pnpm 12.16.0, Bun 1.4.2,
official `@effect/tsgo` 0.64.1 / TypeScript 7.0.2, Oxfmt 0.61.0, Oxlint 1.82.0
and pinned canonical Genie. No alternative compiler or parallel toolchain is
introduced.

Canonical generation, strict frozen installation, compiler diagnostics,
format/type-aware lint, renderer/cache/import-restoration/diagnostic/process
lifetime tests, production builds and real maintained journeys remain required.
Reuse requires identical relevant source/tool/dependency inputs and actual
hashed artifacts; an older summary or a successful setup is insufficient.
The source-bound fixed check matrix in
[`scripts/maintained-qualification/README.md`](../../../../../scripts/maintained-qualification/README.md)
records the whole source/index, current tools, exact reused input projections,
joined checks and artifact evidence for lead review. It never commits or grants
application adoption. The SDK-only guard and its refusal behavior are unchanged;
this extension is not an arbitrary SDK scope mode or permission to put renderer
changes through that finite guard. Commit review remains conditional on the
actual final source/index and complete named-owner evidence.

Original cold Nix closure realization, Nix-supplied tool/browser integration,
automatic devenv shell readiness and native setup-trace smoke remain explicitly
**unverified**. This supported workflow is not a Full Setup pass or upstream /
Darwin parity claim. Native SQLite distribution rebuilds, release and
infrastructure changes remain outside this extension and require their owning
qualification. No machine/Docker settings, global installations, registry or
upstream writes, workflow dispatch or deployment are authorized.
