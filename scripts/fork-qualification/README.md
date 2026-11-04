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

| Section | Required bindings |
| --- | --- |
| `authority` | Original `proposalSha256` and hashed root `review`. The scope review contract is `livestore-fork-scope-v1`, with original `decisionSha256` and a canonical `bindingSha256` over source/tools/artifact/consumer/strategy. |
| `source` | Exact `base`, whole Git-semantic `tree`, `changed` rows, frozen `excluded` rows, `shared` reviews, pinned `external` root/base/tree and two `builds` refs. |
| `tools` | Checked-in `specSha256` and concrete `inputs` from the current prepared recipe, including binary bytes/modes and command arguments. |
| `artifact` | Content-addressed `root`, hashed `sourceInventory`, `payloadInventory` and exact `compatibility` refs. The full SDK/support source and declared package vectors are recomputed/checked. |
| `consumer` | Actual `entries` (root/includeDev), hashed manifest/lock `inputs`, and complete expected runtime Effect `cohort` file/mode/byte/hash vectors. |
| `application` | Explicit `strategy`, hashed `strategyEvidence`, lead `review`, source-bound `artifacts`, required `cases`, and open `limits`. |

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
