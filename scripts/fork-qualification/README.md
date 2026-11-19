# Fork qualification runner

`pnpm run fork:check` runs the local SDK gates using the versions prepared by
`pnpm run fork:bootstrap`. It does not install dependencies or write generated
configuration. The runner verifies the prepared tool descriptor, Node 24,
pnpm 12.16.0, and the explicit 19-project SDK/test TypeScript inventory before checking:

1. Root bootstrap Genie outputs, then Genie outputs under `packages/`, `tests/`,
   `scripts/`, and `docs/`.
2. Source formatting and type-aware Oxlint over the explicit, Git-derived source
   inventory for the 19 SDK/test owners and the approved qualification tooling.
   Oxlint uses the canonical effective configuration, with only the Genie JS
   plugin path made portable to the prepared tool profile.
3. A portable Node regression reads the real generated public package files
   declarations and uses the pinned normal `pnpm pack --dry-run --json` command
   on real fixtures. It checks cache exclusion, docs pattern ordering, retained
   asset bytes/modes and private cache preservation without an extra dependency.
4. The official `tsgo --build` project-reference graph in `tsconfig.fork.json`.
5. Runtime Vitest discovery for the eight configured test projects. The JSON
   reporter is checked for the established floor of 904 passing tests, three
   explicitly named pre-existing skips, 96 files, and each of the four real
   process-kill recovery cases. The suite executes the runtime-discovered tests, including
   Node, Expo, React, Babel compatibility, and all SQLite unit tests.
   Test names and counts come from Vitest's completed run
   report, not source parsing or a maintained filename list.

The SQLite unit fixture is generated deterministically in memory. Its separate
500 MiB performance job is opt-in (`pnpm --dir tests/wa-sqlite test:performance`)
and never reports a pass merely because its fixture is absent.

The retained skipped cases cover backend-mismatch reset, varying cache lifetimes,
and React's zero-cache-time load (#916). They remain unqualified; the runner
rejects any changed or additional skipped case.

Each gate runs sequentially and stops at the first failure. Full logs and the
runtime test report are written under ignored
`temp_nocommit/fork-qualification/run-*` directories; failures print a short log
tail and retain the full output.

Bootstrap requires the initial `pnpm` on `PATH` to match `tool-profile.json`'s
`pnpm` pin (currently 12.16.0), before it creates the profile manifest or installs
dependencies: the initial installer also generates the hashed tool launchers.
Put the pinned pnpm before Node 24's actual `node/bin` directory; a broader toolchain
`.bin` directory may select another pnpm. Bootstrap installs no system tools and
does not declare the profile's `packageManager` until the owned pnpm is installed,
preventing automatic global provisioning. Use the profile's
`node_modules/.bin` before the verified Node 24 directory on `PATH` for subsequent
workspace installs. The runner selects this order itself. Profiles include their
specification in their directory identity, preserving earlier qualified profiles.
pnpm 12.16.0 includes the maintained [injected peer-context fix](https://pnpm.io/blog/releases/12.15.0)
needed to keep the native React consumer separate from the web consumer.

`pnpm run fork:check:fix` regenerates outputs through the canonical root
bootstrap and package/test/script/docs Genie phases, then runs Oxfmt only over
the explicit source inventory. It never formats generated outputs directly.

## Conditional source commit check

`pnpm run fork:commit-check --evidence /private/commit-evidence.json` implements
original decision 0004's conditional gate. It never stages, commits, changes a
hook, imports application code or executes commands supplied by a receipt.
Missing or stale proof fails closed before expensive gates; complete preflight
alone is not eligibility. Successful preflight runs all maintained gates and
then rechecks source/index/tools, immutable refs and the live consumer.
The final private `commit-decision.json` lists exact blocking case IDs or binds
the conditional scoped verdict. No push/release or whole-V1 claim is implied.

The current staged path set must exactly equal the reviewed changed path set;
working bytes, symlink targets and Git executable bits must match the index.
The full authored tree is bound, including new tooling. Excluded Full Setup
inputs cannot change through this finite lane. Shared metadata requires an
explicit reviewed direct/transitive owner classification; unchanged direct
manifests alone do not prove an unchanged closure. The original decision and
its proposal hash are checked; no one-off checkpoint exception is consulted.

The exact generated catalog fixture config at
`packages/@local/astro-twoslash-code/src/cli/test-fixtures/catalog/tsconfig.json`
is shared compiler metadata and requires its own current shared-input review
and canonical Genie check. Its adjacent generator, fixture TypeScript, renderer
and other Astro source configs remain Full Setup inputs. A fresh byte review
cannot approve hand-mutated generated output; actual Astro/docs behavior remains
unqualified by this finite lane.

### Private evidence contract

The manifest contract is `livestore-fork-commit-evidence-v1`, with exactly these
sections. Paths in references resolve relative to the manifest's directory.
A reference is `{ "path": "local-file", "sha256": "<64 lowercase hex>" }`.
All files are reread. A changed old path/hash fails; a separately approved sealed
successor needs its own explicit reference and does not repair the old hash.

| Section       | Required bindings                                                                                                                                                                                                        |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `authority`   | Original `proposalSha256` and hashed root `review`. The scope review contract is `livestore-fork-scope-v1`, with original `decisionSha256` and a canonical `bindingSha256` over source/tools/artifact/consumer/strategy. |
| `source`      | Exact `base`, whole Git-semantic `tree`, `changed` rows, frozen `excluded` rows, `shared` reviews, pinned `external` root/base/tree and two `builds` refs.                                                               |
| `tools`       | Checked-in `specSha256` and concrete `inputs` from the current prepared recipe, including binary bytes/modes and command arguments.                                                                                      |
| `artifact`    | Content-addressed `root`, hashed `sourceInventory`, `payloadInventory` and exact `compatibility` refs. The full SDK/support source and declared package vectors are recomputed/checked.                                  |
| `consumer`    | Actual `entries` (root/includeDev), hashed manifest/lock `inputs`, and complete expected runtime Effect `cohort` file/mode/byte/hash vectors.                                                                            |
| `application` | Explicit `strategy`, hashed `strategyEvidence`, lead `review`, source-bound `artifacts`, required `cases`, and open `limits`.                                                                                            |

Source rows contain `path`, `kind`, `executable`, `sha256`, and `target` for
symlinks. They represent Git source meaning, not readonly projection bits.
Actual candidate, clean produced payload and installed regular/executable modes
are checked in full; source permission handling never normalizes package modes.
The producer helpers `sourceState`, `sdkIdentity`, `toolInputs`, `digest` and
`scopeBinding` expose facts/bindings only. They do not grant root acceptance.

A shared review uses `livestore-fork-shared-input-v1`, with exact `inputs`,
`affectedOwners`, `unqualifiedOwners`, `finiteSdkOnly` and `fullSetupRetained`.
A clean reconstruction ref uses `livestore-fork-clean-build-v1`: joined successful
`bootstrap` and `install` log refs (frozen/strictPeers), plus a `local` ref to the
fresh `livestore-fork-local-qualification-v1` produced by the maintained runner.
Both independent roots must match the complete current source/generator/tool
recipe and produce the actual accepted package vector. Never rebuild an
immutable candidate in place to update qualification tooling.

Installed producers use directory selection without virtual workspace-root
tarball additions. An immutable source-only candidate is the exact union of
sealed authored SDK inputs and qualified produced files: selected bytes/modes,
the entire sealed source snapshot (including SDK/support, generator and source
context), full modes/link targets, overlap agreement and missing/extra membership
are checked directly. It needs neither an installation nor tarball generation.

Consumer validation traverses normal installed dependency/peer resolution from
the declared bound entry manifests. It checks every effective SDK instance and
every actual file/mode, refuses missing/extra members, and verifies coherent
Effect content/version/core resolution. Historical inode/ctime/path observations
are not portable identity: current resolution and content are recaptured rather
than rewriting old build receipts. Within an active check, authored source/index
mutation invalidates the local gate that consumed those inputs.

Application artifacts contain an ID, `platform` (`web`/`ios`), actual hashed
`files`, an actual `source` vector ref (`livestore-application-source-v1` with
hashed source `files`), `sourceTreeSha256`, `sdkSourceSeal`, and `payloadSha256`.
The lead application review contract `livestore-fork-application-v1` binds the
canonical application body, excluding its own review ref. Cases have exactly
`id`, `status` (`pass`/`pending`/`fail`), nonempty actual `evidence` refs and
matching-platform `artifacts` IDs. English passed-scope labels are not parsed
into green. Root owns semantic attestations; local provenance is not a digital
signature proving that a person observed a UI.

Required common cases are:

- `web.local-persistence` and `ios.local-persistence`;
- `web.multicontext-offline-recovery`;
- `web.physical-close-exclusive-handle` and `ios.native-close-authority`.

`fresh-preserve-old` additionally requires `compatibility.old-files-web` and
`compatibility.old-files-ios`, with explicit user/root strategy provenance.
It deliberately makes no transparent old-to-new pending migration claim.
`continuous` instead requires actual `web.old-pending-continuity` and
`ios.old-pending-continuity`. Cases are fixed by policy, not an optional
receipt-selected list; local-only passes cannot substitute for missing cases.
Full V1/dinner/capacity/backup completeness is not silently added to this finite
scope. Relevant changed excluded domains still require Full Setup.

Verifier tests use isolated disposable Git histories and real filesystem
mutation controls. They do not stage or commit the SDK checkout. Existing
2,092-file/d744 evidence remains immutable when checker-only recipe changes are
qualified separately. Reuse of runtime-equivalent application evidence requires
actual source and entire produced/candidate/live payload byte-and-mode proof.

Candidate compatibility uses `livestore-fork-candidate-compatibility-v1`: exact old
`sourceSnapshotSha256`, new `currentSourceTreeSha256`, and recomputed `changes`
with old/current semantic path/hash/kind/executable/link descriptors. Only the
explicit thirteen reviewed checker/spec paths are eligible; no prefix exemption
applies. Scope review binds this reference and the final whole-source recipe.
Producer selection replay, full candidate closure and actual installed payload
validation are separate proofs. Old and new authored recipes are compatible
under this explicit exception; they are not described as identical.

## Frozen local qualification directory

`node scripts/standalone/stage-source-directory.ts` materializes source-matched
bytes for app qualification **before** conditional commit eligibility. It does
not install dependencies, run builds, create Git contexts, commit, or publish.
Root supplies one managed source context, one normal installation/build and one
absent output directory whose basename is the SDK source seal. Existing dirty
checkouts and older immutable directories remain untouched.

The qualification-input contract owner (`qualification-source-contract.ts`),
the CLI/materialization owner (`stage-source-directory.ts`), and their tests
are checked with the three shared `.mts` owners by the canonical
`scripts/standalone/tsconfig.json` project. Its generator uses the normal strict
Effect settings, explicit Node types, and the sole workspace project reference
to `@livestore/utils`. Generate the config with the canonical Scripts Genie pass
before running the pinned `effect-tsgo tsc@7.0.2 --build scripts/standalone`.
The umbrella Scripts project retains its existing coverage. Run the full
Scripts, docs and sync gates separately wherever required; this producer
check and its receipt do not supply those results. The 19-project SDK graph
remains a separate gate.

The actual shared implementations are checked `.mts` owners:
`qualification-observations.mts` owns Git/files/package observations,
`qualification-recipe.mts` owns the unchanged gate/cohort recipe, and
`qualification-runtime.mts` owns the runtime-suite contract. Existing `.mjs`
entrypoints forward to those same functions for Node 24/Bun consumers; they do
not contain parallel implementations or declarations that hide unchecked bodies.
The three implementation files are also required support inputs in SDK source
identity. This does not claim that all existing JS authority verifiers have
been converted or that the broader Full Setup obligations are qualified.

Required arguments are `--source-root`, `--source-base`, `--source-snapshot`,
`--source-patch`, `--build-receipt`, `--output`, and `--receipt`. The receipt must
be outside the immutable output. A receipt inside the source context must be
ignored by Git; otherwise the final source-invariance check rejects and cleans
up the attempted materialization.

The frozen source manifest uses `livestore-fork-qualification-source-v1`:

- `base`, `tree`, and `changed` bind the actual Git base and complete current
  semantic source state. The replay scope requires its four SDK/test paths and admits
  the existing reviewed producer changes and optional fixture pair. The worker scope
  requires exactly its ten regular adapter-web implementation and test paths on a
  tracked producer recipe, with no replay, producer, or fixture changes. The
  coordinator successor separately requires its exact 23 adapter-web and 16
  producer paths, including bootstrap, generation retirement and admitted-write
  wire owners. It admits regular files only, with no replay or fixture changes.
  All three profiles require a hashed, independently reviewed patch that
  reverse-checks against the actual source without modifying it.
- `external` binds `repos/effect-utils`, its pinned Git revision and complete
  unchanged source tree. Sharing an existing pinned checkout is accepted only
  when this real source-state verification succeeds.
- `baseInventory` and `baseChanges` declare the actual compatibility delta from
  the accepted candidate. They cannot disguise the five f126 qualification-recipe
  differences as an identical old Git tree.
- `producerInputs` is the exact ordered `producerPaths` export, with hashes of
  both the running producer recipe and its copies in the frozen source. This
  includes the new producer, its tests, normal selection/identity/closure helpers,
  checker, bootstrap, tool specification, and the producer compiler generator
  and generated config. `producerChecks` contains joined, successful
  `producer-typecheck`, `tests`, `source-format`, and `type-aware-lint` log refs.
  Capture the exact dedicated compiler invocation in the producer-typecheck log.
- `patch`, `build`, `baseInventory`, and `review` are normal `{path, sha256}` local
  references. Relative paths resolve against the manifest directory. The review
  uses `livestore-fork-qualification-source-review-v1`; its `bindingSha256` is
  `digest(manifest without review)`. Root must independently review this expanded
  source and producer recipe; the original four-file review does not cover it.

For a separately reviewed product patch, the manifest can include
`reviewedProducer` with contract `livestore-fork-reviewed-source-producer-v1`,
the executing producer's Git `base`, and `sourceTreeSha256` (the canonical
digest of its entire authored source tree). The root review binds that pin
and the candidate's exact patch, changed paths and postimage hashes. The
producer replays the patch in a temporary index and compares paths, bytes
and modes. This mode admits regular files in the reviewed candidate scope.
Shared inputs require a `shared` array on the source manifest, using the same
`{path, review}` references as the final commit scope. Every changed shared
path needs an exact current path/hash in a `livestore-fork-shared-input-v1`
proof, direct/transitive `affectedOwners`, explicit `unqualifiedOwners`, and
both `finiteSdkOnly: true` and `fullSetupRetained: true`. Missing, duplicate,
extra or stale reviews fail. These references join the root-reviewed manifest
binding and final reference revalidation. The fixed legacy profiles do not
accept this authority; Full Setup inputs remain excluded even with a review.
Changes to the producer recipe still require their separate `producerPatch`.
The build, generator and installed package selection belong to
the candidate checkout. Its export includes only its own authored and
produced files. The existing fixed profiles use the original manifest form.

`tools` is a hash reference to the actual source context's raw generated
`temp_nocommit/fork-qualification/tools.json`. Its bytes join final reference
revalidation, and the actual existing `toolInputs` digest is observed again at
the final publication cutpoint. A normalized descriptor alone is insufficient.
`producerInputs` conservatively binds the complete maintained qualification
recipe directory, including `commit-evidence.mjs`, `upstream-source-inputs.mjs`,
owned tests/configs and bootstrap's Python verifier, plus the three producer TS
files. Membership drift requires a fresh recipe review. The audited literal
local imports remain inside those owned boundaries.

Accepted-base snapshot entries and old/current compatibility descriptors are
decoded by their actual file/symlink contracts before path or mode operations;
unknown fields, invalid modes/hashes, missing link targets and escaped paths are
rejected. They are not forwarded as untyped arrays.

Only the two independently reviewed sync-provider fixture corrections may join
the frozen LOCAL qualification source when required by the normal Scripts
project. In that case `fixtures` supplies their distinct hashed `review` and
exact ordered `{path, sha256}` `inputs`. Both exact fixture paths must be
present with matching current file bytes. This source-input declaration does
not alter conditional commit Full Setup classification or compatibility lists.

The build wrapper retains `livestore-fork-clean-build-v1` and requires real,
joined `bootstrap`, frozen/strict-peer `install`, and `local` receipts. It also
requires `payload`, a hash ref to the actual normal-produced
`livestore-qualified-package-payload-v1` vector, and `closureSha256`, the digest
of the normal installed `consumerGraph` seeded from the 12 SDK package roots.
These must be captured by the real normal build workflow. The existing local
checker receipt alone does **not** hash `dist` files; it is insufficient to
claim that selected compiled bytes are unchanged. Missing output/closure evidence
is a blocker, not permission to reuse a previous candidate or guess output files.

The producer rereads normal selected package bytes through the existing pinned
`packPayload` contract, checks the real installed dependency closure, and copies
only the exact authored-source/selected-output union. It rejects stale hashes,
extra scope, output overlap, escaping/nonrelocatable links, altered modes, changed
inputs, and existing destinations. Failed materialization cleans up only after
receipt descriptor closure is confirmed. An uncertain close is never retried:
the original error and descriptor observation are retained with the owned output
and receipt for the caller to settle. Cleanup failures likewise retain the
original error and remaining artifacts. No package lifecycle scripts or
receipt-supplied commands are executed.

The output contains the existing candidate source/payload inventory contracts;
its separate receipt is `livestore-fork-local-qualification-directory-v1` with
`qualificationOnly: true`, `commitEligible: false`, and
`independentReproduction: false`. One build is sufficient only for this local
qualification step. The existing commit consumer still requires two independent
final-recipe builds, the five app proofs, source/index equality and all original
conditions. Manual iOS Simulator holds remain independent blockers for iOS proof.

Producer tests use real disposable Git repositories and normal pinned pnpm
selection with explicitly synthetic unit receipts. They do not qualify an SDK
build. Run them with the pinned Node 24 toolchain after normal tool bootstrap:
`node --test scripts/standalone/stage-source-directory.test.ts`.

## Export the SDK from a clean commit

Check out the intended fork commit and the `effectUtilsRevision` from
`tool-profile.json` at `repos/effect-utils`. With the pinned Node and pnpm,
run `pnpm run fork:bootstrap` and put the prepared profile's `node_modules/.bin`
first on `PATH`. Run the following from the fork root:

```sh
pnpm install --frozen-lockfile --strict-peer-dependencies
pnpm run fork:check
node scripts/standalone/export-sdk.ts /path/to/absent-sdk-directory
```

The output's parent must exist outside the checkout. The command checks for a
clean Git checkout, uses the pinned pnpm pack selection, and copies only the
selected files with their modes. It writes `candidate-artifact-inventory.json`
last and removes an incomplete output on failure. An existing directory is
never replaced.

Pass the export directory to the downstream project's SDK staging tool. Verify
the inventory hash and package files against the project's committed pin, then
install with its frozen lockfile and strict peer dependency checks.

Run the focused regression with `node --test scripts/standalone/export-sdk.test.ts`.
