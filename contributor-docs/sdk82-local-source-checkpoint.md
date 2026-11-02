# SDK82 local source checkpoint disposition

## Authority and scope

The coordinating lead in chat `01a13c15-257b-7010-a157-90c780b4f6fa`
approved a narrow LOCAL nonshippable WIP checkpoint exception on November 2,
2026, under the user's delegated architectural decision authority and request
for recoverable Git source. This is a LEAD disposition, not a new human quote,
release approval, application acceptance, or permission to publish.
Application requires the lead's final review of the exact policy patch.

The October 29 human focused-workflow approval and its original conditional
commit rule remain recorded unchanged in
`context/03-delivery/01-composition/01-developer-environment/.decisions/0004-focused-fork-qualification.md`.
This disposition narrowly amends local checkpoint policy; it does not assert
that the October 29 approval already authorized it. It is owner provenance,
not a user-decision log entry.

## Exact local transition

After final lead review, permit two normal local commits in the owned recovery
checkout, beginning at `5529896043c0154ce9a5c534c4ca008ceccfdae6`:

1. Policy-only commit: `AGENTS.md` and this document, with exactly the reviewed
   policy patch. Preserve the two pending SDK changes without staging them.
2. Source-only checkpoint: exactly
   `packages/@livestore/utils/src/browser/Opfs/Opfs.ts` and
   `packages/@livestore/utils/src/browser/Opfs/Opfs.test.ts`.
   The complete two-file patch must have SHA-256
   `d7271babf559c6e3a9a13bfd0574071a637f80ee73878421e858cb43ea7f6ae1`.

Before each commit, privately verify its exact parent, index path set and bytes,
absence of unrelated changes, immutable SDK82 source/support identity and all
thirteen retained qualification evidence hashes. Use existing bounded evidence;
do not introduce a maintained one-off checker mode, reusable attestation scheme,
hook bypass, dependency change, generated-file edit, or SDK artifact rebuild.
The existing `--commit` command and its refusal stay unchanged; they are not the
qualification lane for these two specifically authorized local WIP commits.

## Qualification and limits

The two SDK files match immutable source seal
`82eb1ecd9e7f98dc3b5fe14ccfb402fe931a5e52ace05319e59df81fdb8c3b48`.
Recorded exact-source checks passed: five canonical generator checks, format,
strict type-aware lint, 19 compiler projects, 927 runtime tests with three skips,
four process-kill controls, 11 focused tests and two cross-layer tests. These
are historical qualifications; preserving source does not execute them again.

Normal app web build, native update and retained 19-graph preservation passed.
Safari acceptance FAILED at native createSyncAccessHandle and remains OPEN.
Build success and native preservation do not replace web acceptance. All
existing adoption, release, full-site and full-upstream-parity gates remain.
The inherited devenv precommit requirement is replaced only for this exact
local transition by the focused checks and bounded verification above.

The resulting Git tree includes this explicit policy overlay. Do not relabel
its complete recipe/tree identity as the old immutable SDK82 snapshot. The
633 SDK source files and six support files can match SDK82 while owner policy
and this added provenance document differ. Prebuilt 1979-file artifacts,
qualification logs and local tool realization remain private; a source commit
is not a published artifact family or proof of a fresh independent rebuild.

No consumer-family files, app files, generated outputs, private evidence or
credentials may be staged. No new source fix is authorized. This exception is
exhausted by the two local commits and grants no authority to future changes.
Any public push remains HELD for separate review of the actual new payload;
prior public approval for exact commit552 does not extend to this transition.
