# 0005 — Qualify the maintained Effect registry cohort

Status: accepted for isolated qualification; application adoption remains conditional

## Context

The temporary Effect preview supplied a SQL migration packaging fix absent from
registry 4.0.6. Official registry 4.1.0 now contains the mainline fix, so retaining
preview-only resolution machinery would introduce avoidable maintenance.

## Decision

On October 29, 2026 the coordinating lead in chat
`01a13c15-257b-7010-a157-90c780b4f6fa` authorized qualifying exact registry
4.1.0 for all nine Effect family members under the user's maintained-dependency
requirement and the temporary pin's exit condition. This updates the cohort in
decision 0004 without waiving its qualification or commit gates.

Independent registry integrity, provenance and tarball inspection identify
publication source `9a91b1926a5fbfaffd302a7a41a94d4d53a1154e` and mainline fix
`be9895bd7608f606dfdc4910ab722e2eb700ab19` (#9157). The publication is 79 commits
ahead of that fix with none behind. The preview branch itself diverges; its SHA
is not claimed as a literal ancestor of the stable publication.

Keep the repository-wide 4.0.3 catalog. Qualified SDK public peers require 4.1
because the corrected source uses its representation and persistence APIs; an
older compatible-looking range is not proof of support. An
independent SDK catalog owns 14 explicit SDK generators and the common and
integration qualification tests. The qualification root materializes the nine
exact registry members. Selected owners and the root use Vitest 5.0.5 to satisfy
`@effect/vitest` 4.1.0. The qualified tooling uses Vite 8.3.5 and maintained
DevTools Vite 0.5.0. Excluded owners retain their source declarations.
Any resolution override change must first pass a normal fresh and frozen
fixture demonstrating both cohorts without relaxing peers or integrity checks.

## Consequences

- Audit excluded generated manifests and reachable resolutions independently.
  Public peer propagation or global resolution changes are real expanded scope,
  even when direct manifests remain identical. They keep the commit gate closed
  until explicitly qualified; they are never implicit exemptions.
- Remove Effect-wide overrides rather than narrowing genuine upstream peer
  ranges. The ordinary strict fixture proves separate baseline and selected
  direct cohorts without a peer-isolation setting or policy relaxation.
- Node 24 satisfies the platform-node and Undici Node >=22.19 requirement.
- The maintained compiler, actual test discovery, at least 612 passing unit
  controls and all four real SIGKILL cases must be requalified on this cohort.
- Version equality alone is insufficient evidence. Bind installed artifacts,
  lockfile resolution, source identity and application receipts to exact hashes.
- Original frozen V8 and the running application remain untouched until the
  lead coordinates adoption. Registry availability does not establish runtime
  compatibility or open the commit gate.
