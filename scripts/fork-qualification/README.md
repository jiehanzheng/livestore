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
3. The official `tsgo --build` project-reference graph in `tsconfig.fork.json`.
4. Runtime Vitest discovery for the eight configured test projects. The JSON
   reporter is checked for the established floor of 904 passing tests, three
   explicitly named pre-existing skips, 96 files, and each of the four real
   process-kill recovery cases. The current suite executes 907 tests, including
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

Bootstrap uses an existing pnpm to install the exact declared package manager into
the owned tool profile; it does not install system tools. Use the profile's
`node_modules/.bin` before the verified Node 24 directory on `PATH` for subsequent
workspace installs. The runner selects this order itself. Profiles include their
specification in their directory identity, preserving earlier qualified profiles.
pnpm 12.16.0 includes the maintained [injected peer-context fix](https://pnpm.io/blog/releases/12.15.0)
needed to keep the native React consumer separate from the web consumer.

`pnpm run fork:check:fix` regenerates outputs through the canonical root
bootstrap and package/test/script/docs Genie phases, then runs Oxfmt only over
the explicit source inventory. It never formats generated outputs directly.

`pnpm run fork:commit-check` runs the local gates, then fails closed. No approved
scope/tool/excluded-input policy, source-matched web acceptance, or iOS
acceptance receipts are currently available. Passing local checks does not
grant SDK qualification or commit eligibility. This command never creates a
commit.
