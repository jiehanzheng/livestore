import path from 'node:path'

export const sdkNames = [
  'adapter-node',
  'adapter-expo',
  'adapter-web',
  'common',
  'common-cf',
  'framework-toolkit',
  'livestore',
  'react',
  'sqlite-wasm',
  'utils',
  'wa-sqlite',
  'webmesh',
].map((name) => `@livestore/${name}`)
export const supportPaths = [
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'pnpm-install-contract.json',
  'tsconfig.fork.json',
  'scripts/fork-qualification/tool-profile.json',
  'scripts/fork-qualification/qualification-observations.mts',
  'scripts/fork-qualification/qualification-recipe.mts',
  'scripts/fork-qualification/qualification-runtime.mts',
]
export const requiredGates = [
  'genie-root-bootstrap',
  'genie-packages',
  'genie-tests',
  'genie-scripts',
  'genie-docs',
  'source-format',
  'source-lint-type-aware',
  'package-files-policy',
  'commit-evidence-tests',
  'typecheck-19-projects',
  'vitest-eight-project-runtime-suite',
]
export const PROJECTS = [
  'packages/@livestore/adapter-expo',
  'packages/@livestore/adapter-node',
  'packages/@livestore/adapter-cloudflare',
  'packages/@livestore/adapter-web',
  'packages/@livestore/common-cf',
  'packages/@livestore/common',
  'packages/@livestore/effect-playwright',
  'packages/@livestore/framework-toolkit',
  'packages/@livestore/livestore',
  'packages/@livestore/react',
  'packages/@livestore/sqlite-wasm',
  'packages/@livestore/sync-cf',
  'packages/@livestore/utils-dev',
  'packages/@livestore/utils',
  'packages/@livestore/wa-sqlite',
  'packages/@livestore/webmesh',
  'tests/package-common',
  'tests/integration',
  'tests/wa-sqlite',
]
export const PROJECT_TEST_ROOTS = [
  'packages/@livestore/sqlite-wasm',
  'tests/wa-sqlite',
  'packages/@livestore/adapter-node',
  'packages/@livestore/adapter-expo',
  'packages/@livestore/react',
  'packages/@livestore/common',
  'packages/@livestore/livestore',
  'packages/@livestore/adapter-web',
  'tests/package-common',
]
export const REQUIRED_CRASH_CASES = [
  'crash-before-state',
  'crash-after-state',
  'crash-after-eventlog',
  'crash-after-completion',
]
export const declaredCommands = (profile: string, typescript: string) => ({
  pnpm: [path.join(profile, 'node_modules/.bin/pnpm')],
  genie: [
    path.join(profile, 'node_modules/@oven/bun-darwin-aarch64/bin/bun'),
    path.join(profile, '.canonical-genie/genie.js'),
  ],
  compiler: [path.join(profile, 'node_modules/.bin/effect-tsgo'), `tsc@${typescript}`],
  lint: [
    path.join(profile, 'node_modules/@oven/bun-darwin-aarch64/bin/bun'),
    path.join(profile, 'node_modules/oxlint/bin/oxlint'),
  ],
  format: [path.join(profile, 'node_modules/.bin/oxfmt')],
})

// Bind the whole maintained recipe owner, not just direct imports of the CLI.
// The literal-local dependency audit also includes checker tests and bootstrap's Python verifier.
export const recipePaths = [
  'README.md',
  'bootstrap.mjs',
  'bootstrap.test.mjs',
  'check.mjs',
  'commit-consumer.mjs',
  'commit-consumer.test.mjs',
  'commit-evidence.mjs',
  'commit-evidence.test.mjs',
  'commit-files.mjs',
  'commit-fixture.mjs',
  'commit-source.mjs',
  'package-files.test.mjs',
  'qualification-policy.mjs',
  'qualification-runtime.mjs',
  'qualification-observations.mts',
  'qualification-recipe.mts',
  'qualification-runtime.mts',
  'tool-profile.json',
  'upstream-source-inputs.mjs',
  'upstream-source-inputs.test.mjs',
  'verify-native-artifact.py',
  'vitest.config.ts',
]
  .map((name) => `scripts/fork-qualification/${name}`)
  .sort()

export const producerChangePaths = [
  'scripts/standalone/stage-source-directory.ts',
  'scripts/standalone/qualification-source-contract.ts',
  'scripts/standalone/stage-source-directory.test.ts',
  ...[
    'README.md',
    'bootstrap.test.mjs',
    'commit-files.mjs',
    'commit-consumer.mjs',
    'commit-source.mjs',
    'qualification-policy.mjs',
    'qualification-runtime.mjs',
    'qualification-observations.mts',
    'qualification-recipe.mts',
    'qualification-runtime.mts',
  ].map((name) => `scripts/fork-qualification/${name}`),
]

// This is local qualification source scope, not a commit/Full Setup exemption.
export const qualificationFixturePaths = [
  'tests/sync-provider/src/do-rpc-transport-recovery.test.ts',
  'tests/sync-provider/src/sync-provider.test.ts',
]
