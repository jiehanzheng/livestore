# Maintained docs, renderers and demos

This is the supported normal Node/pnpm qualification path approved in the
November 19 extension of developer-environment decision 0004. It is a fixed
matrix for the named maintained owners, not a selectable SDK scope or a Full
Setup replacement. The SDK-only guard remains unchanged and refuses broader
renderer/docs inputs.

Use the actual Node 24 executable and the existing tool profile prepared by
`pnpm run fork:bootstrap`. Its `temp_nocommit/fork-qualification/tools.json`
declares canonical Bun Genie, official Effect compiler, formatter and type-aware
linter commands. Put the verified Node directory, profile `node_modules/.bin`
and declared Bun directory on PATH. Do not infer the Node version from a path
label, install global tools, edit generated files or change machine settings.

```sh
node scripts/maintained-qualification/check.mjs /absolute/private/reviewed-plan.json
```

The command checks its version-2 plan before running anything. Its twenty fixed gates include the retained SDK909 source-staging suite before generation. Each child is foreground,
joined, logged and stops the matrix on failure. There is no arbitrary command or
scope field. It runs canonical root/package/test/script/docs generation checks,
strict frozen installation, formatting and type-aware lint of every fixed named-owner authored file, the
owning official compiler projects, evidence negative controls, all three
renderer/docs Vitest suites, intent-layer checks and normal Astro check. The
renderer suites include cache/invalidation, import restoration, expected
compiler diagnostics and child/resource lifetime behavior. Deliberate diagnostic
fixtures stay under their owning renderer tests, as declared by that project's
tsconfig; their diagnostics are not suppressed or relabeled as implementation. Canonical generated projections are checked by Genie; their owning generators are included in authored checks. SDK/test/support inputs keep their explicitly accepted inherited byte identity. Generated inherited metadata is pinned to the explicit canonical ancestor below; remaining out-of-owner format diagnostics stay visible.

Production docs/demo builds and real journeys are required evidence. This checker always runs a fresh normal production docs build and markdown export. Browser docs evidence is reused only after every reviewed page/asset byte and mode matches that fresh build; its original source epoch remains explicit. Reusing a
pass is permitted only when the fixed relevant source/dependency projection is
identical to its recorded baseline and the actual artifacts still match their
inventories. Changed demo or shared runtime/dependency inputs invalidate journey reuse. Renderer/compiler configuration changes require fresh strict checks and production rendering; unchanged generated Browser bytes can then support the prior reviewed view. Run its normal production command and actual owning journey again;
never rewrite an old baseline or claim a cached result used the new whole tree.
Normal docs production is `pnpm exec astro build --outDir <owned-output>` from
`docs/`, with the existing declared diagram runtime, not a Nix setup pass.
Retain reviewed pages/assets and complete inventories/recipe; retire full-site
copies once their hosting owner releases them.

## Canonical tool and ancestor ownership

All generation and validation use `toolEnvironment` from `environment.mjs`.
Genie silently falls back to raw output when it cannot resolve Oxfmt; exposing
the declared profile consistently is required, rather than accepting that
fallback as current canonical generation.

The original85 ancestor remains immutable. Its reviewed canonical successor
changes only nine generated formatting hashes and preserves every logical value.
The old docs config's values remain in this derived ancestor; its separately
reviewed jsPlugin addition remains a maintained-owner change. `inherited-source.mjs` owns this immutable derivation and then applies exactly
five trusted support replacements from SDK commit
`909bb3920451659911fab70e973decc956c0a73a`. It pins their preimage/postimage
hashes, regular nonexecutable modes and committed Git blobs. The resulting
inherited inventory is
`e99cb8a33589d4710192cf5f625a38047f7acf95b8aa68e92f44516927c1d86a`.
The private plan supplies hashed evidence bytes, never replacement authority.
All other inherited inputs remain frozen; SDK `fullSetupInput` and shared-review
admission retain the exact909 implementation. No whole maintained snapshot is
promoted into the ancestor.

Focused controls use the same declared Node/profile as the full matrix:

```sh
node --test scripts/maintained-qualification/contract.test.mjs
node --test scripts/standalone/stage-source-directory.test.ts
```

The fourteen support-transition controls supplement the ten existing maintained
controls. The retained SDK suite covers shared review, source staging and Full
Setup refusal. Qualification at the old225 source remains dated evidence;
this successor requires its own source-bound review and full twenty-gate run.
Final delivery is one ordinary commit with parent909; neither this checker nor
its result creates a commit or authorizes publication.

SDK and standalone reuse bind the SDK payload/source and the standalone's own
source/lock/archives. Demo rebuilds bind their actual production source epoch.
A prior Browser view can be reused only after complete relative byte, mode and
membership equality, fresh relevant checks and explicit lead review; its
original receipt is retained with its original scope and epoch.

## Private plan contract

`livestore-maintained-qualification-v2` contains:

- `proposalSha256`: the approved unified integration design
  `84516d5680afe98386f0d4fd62caf349b0bfd9d6c41b881bef671b76bcf8fc2b`.
- `decision`: hashed current decision-0004 file reference.
- `source`: actual `sourceState(root, base)` fields `base`, `tree`, `changed`
  and `indexDigest`; the complete authored tree and index are reread afterward.
- `rendererRuntime`: the existing declared diagram runtime root and hashed executable/mode; no new browser installation or desktop validation surface.
- `tools`: exact `toolInputs(tools)` observations from the declared profile.
- `inheritedFormatDiagnostics`: hashed current formatter observation for frozen SDK/test/support inputs; recorded failures stay explicit and outside the named authored gate.
- `baseline`: hashed `livestore-unified-inherited-ancestor-v2`, derived from immutable original85 by exactly nine generated-format deltas and five trusted909 support changes. `delta` retains the nine formatting references; `supportTransition` contains the fixed `commit` and ordered `delta` with exact `path`, `beforeSha256`, `afterSha256`, `gitBlob`, hashed `preimage` and `postimage` references. Original, canonical and unified ancestor hashes, complete evidence bytes and dependency-closure identity are verified. It is not a replacement snapshot of maintained work.
- `canonicalTransition`: hashed actual generation delta, derived ancestor, reconstructed-preimage provenance, and unchanged identity/dependency-graph evidence. These references are reread during qualification.
- `standalone`: its actual source inventory (including package/lock), source archive and unsigned app archive; every retained source file and archive hash is reread independently of broader workspace metadata.
- `reuse`: exactly the fixed `reuseIds` in `contract.mjs`, with explicit `pass`
  and nonempty hashed evidence for each. These cover SDK, rendered
  docs, the seven named demos and the separately qualified standalone Expo
  consumer. Native source/binary proof remains separate from this checkout.
- `artifacts`: exactly `sdk`, `docs`, and the six web demo build IDs (all named
  demos except the backend-only Cloudflare observer). Each has an actual `root`
  and hashed `inventory`. SDK payload inventories or ordinary file vectors bind
  bytes, modes and complete membership, including the compact reviewed docs.
- `review`: hashed lead review, contract
  `livestore-maintained-qualification-review-v2`, with the approved
  `proposalSha256` and `bindingSha256 = binding(plan)` over the body excluding
  `review`. The lead reviews semantic journey acceptance and input coverage;
  hashes alone do not establish that somebody observed a UI.

References are `{path, sha256}`; paths resolve relative to the plan. No receipt
supplies executable commands. The plan has no scope switch. Named-owner
admission refuses release/infrastructure/Nix or other new owners, and freezes
SDK/checker/test inputs against the already accepted baseline. Actual
production files and source/index must not mutate during validation.

A successful result under ignored `temp_nocommit/maintained-qualification/`
means only that these named normal-workflow inputs passed. `commitEligible`
and `adopted` remain false: final broader source/index/artifact review is still
required. Never amend immutable SDK `909bb3920451659911fab70e973decc956c0a73a`
or its qualified export to add this work.

Original cold Nix closure realization, its supplied tool/browser integration,
automatic devenv shell readiness and native setup-trace smoke remain unverified.
No upstream/Darwin parity, native SQLite rebuild, release, deployment, registry
publication, system change or automatic workflow execution is inferred.
