/**
 * LiveStore monorepo configuration
 *
 * Extends effect-utils catalog with livestore-specific packages.
 * Uses genie from @overeng/genie for config file generation.
 *
 * ## Design Decisions
 *
 * ### Examples are not managed by genie
 * The `examples/` directory is intentionally excluded from genie management.
 * Examples must remain standalone and self-contained so users can copy them
 * directly without any genie dependencies or monorepo-specific configuration.
 * Each example has its own package.json, tsconfig.json, etc. that are manually
 * maintained to reflect what a real user project would look like.
 */

import {
  catalog as effectUtilsCatalog,
  baseOxlintCategories,
  baseOxlintIgnorePatterns,
  baseOxlintPlugins,
  baseTsconfigCompilerOptions as effectUtilsBaseTsconfigCompilerOptions,
  commonPnpmPolicySettings,
  defineCatalog,
  defineRepoContext,
  domLib as effectUtilsDomLib,
  githubRuleset,
  githubWorkflow,
  megarepoJson,
  oxfmtConfig,
  oxlintConfig,
  packageTsconfigCompilerOptions as effectUtilsPackageTsconfigCompilerOptions,
  packageJson,
  type PnpmPackageClosureConfig,
  pnpmWorkspaceYaml,
  projectionArtifact,
  reactJsx,
  tsconfigJson,
  type PackageJsonData,
  type PnpmWorkspaceData,
  type WorkspaceIdentity,
  type WorkspaceMeta,
  type WorkspaceMetadata,
  type WorkspacePackage,
  type WorkspacePackageLike,
} from '#mr/effect-utils/genie/external.ts'
import { baseOxfmtIgnorePatterns, baseOxfmtOptions } from '#mr/effect-utils/genie/oxfmt-base.ts'
import { tsconfigJsonForNodeModules } from '#mr/effect-utils/packages/@overeng/genie/src/runtime/mod.ts'

import { docsEffectApiPolicy } from './docs-effect-api-policy.ts'
import {
  effectV4Catalog,
  livestoreOnlyCatalog,
  livestoreWorkspaceCatalog,
  nativeExpoQualificationCatalog,
} from './external.ts'
import { livestoreCurrentPackageNames, type LivestorePackageName } from './repo-topology.ts'

export { baseTsconfigCompilerOptions, reactJsx }
export {
  baseOxfmtIgnorePatterns,
  baseOxfmtOptions,
  baseOxlintCategories,
  baseOxlintIgnorePatterns,
  baseOxlintPlugins,
  commonPnpmPolicySettings,
  githubRuleset,
  githubWorkflow,
  megarepoJson,
  oxfmtConfig,
  oxlintConfig,
  packageJson,
  pnpmWorkspaceYaml,
  projectionArtifact,
  tsconfigJson,
  tsconfigJsonForNodeModules,
}
export type {
  PackageJsonData,
  PnpmPackageClosureConfig,
  PnpmWorkspaceData,
  WorkspaceIdentity,
  WorkspaceMeta,
  WorkspaceMetadata,
  WorkspacePackage,
  WorkspacePackageLike,
}

// TODO: Remove this once effect-utils carries the TS 6 DOM lib cleanup upstream:
// https://github.com/overengineeringstudio/effect-utils/issues/892
// TypeScript 6 folds DOM iterable and async-iterable declarations into DOM.
export const domLib = effectUtilsDomLib.filter((lib) => lib !== 'DOM.Iterable' && lib !== 'DOM.AsyncIterable')

// Strip inherited options that now match defaults so generated
// tsconfigs only carry LiveStore-specific intent.
const {
  allowJs: _allowJs,
  esModuleInterop: _esModuleInterop,
  allowSyntheticDefaultImports: _allowSyntheticDefaultImports,
  forceConsistentCasingInFileNames: _forceConsistentCasingInFileNames,
  strict: _strict,
  ...baseTsconfigCompilerOptionsWithoutDefaults
} = effectUtilsBaseTsconfigCompilerOptions

// tsgo 0.64 renamed this same inside-Effect JSON check. Preserve its inherited
// severity and coverage without patching the pinned effect-utils source.
const { preferSchemaOverJson: effectJsonSeverity, ...effectDiagnosticSeverity } =
  effectUtilsBaseTsconfigCompilerOptions.plugins[0].diagnosticSeverity

// Astro's language-service host changes module defaults; retain explicit NodeNext resolution for SDK package exports.
const baseTsconfigCompilerOptions = {
  ...baseTsconfigCompilerOptionsWithoutDefaults,
  // Full-strict Effect-LSP gate (#811 capstone): LiveStore inherits effect-utils' effectDiagnosticsGate
  // unchanged — Effect warnings AND suggestions fail `tsgo --build`, not just errors. The advisory
  // LIVE-MIGRATION BRIDGE that kept the gate errors-only during the burndown is intentionally removed.
  // LiveStore-specific: the internal @livestore/utils duplicate-package diagnostics are an
  // LSP workspace-resolution artifact (not real duplication), so they are allowed here.
  plugins: [
    {
      ...effectUtilsBaseTsconfigCompilerOptions.plugins[0],
      diagnosticSeverity: { ...effectDiagnosticSeverity, globalJsonInEffect: effectJsonSeverity },
      allowedDuplicatedPackages: ['@livestore/utils'],
    },
  ],
} as const

/**
 * Explicit unstable APIs exercised by this SDK against the selected Effect
 * release. Keep capabilities package-local; test-only APIs are admitted only
 * by test files (or by the dedicated test projects), so runtime sources cannot
 * inherit their allowance.
 */
const effectUnstableApiPolicy = {
  'docs/src/content/_assets/code': docsEffectApiPolicy,
  'packages/@livestore/adapter-expo': {
    runtime: ['effect/http/FetchHttpClient#layer'],
  },
  'packages/@livestore/adapter-node': {
    runtime: ['effect/http/FetchHttpClient#layer', '@effect/platform-node/NodeFileSystem#layer'],
  },
  'packages/@livestore/adapter-cloudflare': {
    runtime: ['effect/http/FetchHttpClient#layer'],
  },
  'packages/@livestore/adapter-web': {
    runtime: [
      'effect/rpc',
      'effect/http/FetchHttpClient#layer',
      'effect/workers/Transferable',
      '@effect/platform-browser/BrowserWorker',
      '@effect/platform-browser/BrowserWorkerRunner',
      '@effect/opentelemetry/OtelTracer',
    ],
    tests: ['@effect/vitest', 'effect/workers/Worker#WorkerPlatform'],
  },
  'packages/@livestore/common': {
    runtime: [
      'effect/workers/WorkerError',
      'effect/workers/Transferable#Uint8Array',
      'effect/http/HttpClient#HttpClient',
      'effect/persistence/KeyValueStore',
      '@effect/opentelemetry/OtelTracer',
      'effect/Graph',
    ],
    tests: ['@effect/vitest', 'effect/testing/TestSchema'],
    diagnosticOverrides: [
      {
        // SyncState and merge results are exported structural DTOs; callers
        // pass plain values with the same fields through sync boundaries.
        include: ['src/sync/syncstate.ts'],
        options: { diagnosticSeverity: { schemaClassMissingBrand: 'off' } },
      },
      {
        // This regression pins JSON Number and NumberFromString to distinct encodings.
        include: ['src/schema/state/sqlite/db-schema/ast/fingerprint.test.ts'],
        options: { diagnosticSeverity: { schemaNumber: 'off' } },
      },
    ],
  },
  'packages/@livestore/common-cf': {
    runtime: ['effect/rpc', 'effect/http', 'effect/socket'],
    tests: ['@effect/vitest', '@effect/platform-node/NodeServices#layer'],
  },
  'packages/@livestore/effect-playwright': {
    runtime: [],
  },
  'packages/@livestore/framework-toolkit': {
    runtime: [],
  },
  'packages/@livestore/livestore': {
    runtime: ['@effect/opentelemetry/OtelTracer'],
    tests: ['@effect/vitest', '@effect/platform-node/NodeFileSystem#layer', 'effect/http/FetchHttpClient#layer'],
  },
  'packages/@livestore/react': {
    runtime: [],
    tests: ['@effect/vitest'],
  },
  'packages/@livestore/sqlite-wasm': {
    runtime: ['effect/FileSystem#FileSystem'],
    tests: ['@effect/platform-node/NodeFileSystem#layer'],
  },
  'packages/@livestore/sync-cf': {
    runtime: ['effect/rpc', 'effect/http', 'effect/socket', 'effect/observability/Otlp#layerJson'],
    tests: ['@effect/vitest', '@effect/opentelemetry/OtelTracer', 'effect/persistence/KeyValueStore#layerMemory'],
  },
  'packages/@livestore/utils': {
    runtime: [
      'effect/FileSystem#WatchBackend',
      'effect/Graph',
      '@effect/opentelemetry/OtelTracer',
      'effect/rpc',
      'effect/socket',
      'effect/workers/Transferable',
      'effect/http/HttpClient#HttpClient',
      '@effect/platform-node/NodeFileSystem#layer',
    ],
    tests: ['@effect/vitest', 'effect/FileSystem#FileSystem', 'effect/http/FetchHttpClient#layer'],
  },
  'packages/@livestore/utils-dev': {
    runtime: [
      '@effect/opentelemetry/OtelTracer',
      'effect/PlatformError',
      'effect/process/ChildProcessSpawner',
      'effect/process/ChildProcess',
      'effect/Logger#toFile',
      '@effect/platform-node/NodeFileSystem#layer',
      'effect/observability/Otlp#layerJson',
      'effect/http/FetchHttpClient#layer',
      'effect/FileSystem#FileSystem',
      'effect/http/HttpClient#HttpClient',
    ],
    tests: ['@effect/vitest', '@effect/platform-node/NodeServices#layer'],
  },
  'packages/@livestore/wa-sqlite': {
    runtime: [],
  },
  'packages/@livestore/webmesh': {
    runtime: [
      'effect/TxQueue',
      'effect/workers/Transferable#MessagePort',
      'effect/encoding/SchemaBinary#toCodec',
      'effect/http/HttpClient#HttpClient',
      'effect/socket',
    ],
    tests: ['@effect/vitest'],
  },
  'tests/integration': {
    testProject: true,
    tests: [
      'effect/FileSystem#FileSystem',
      'effect/cli',
      'effect/http',
      '@effect/platform-node/NodeServices#layer',
      '@effect/platform-node/NodeRuntime#runMain',
      '@effect/opentelemetry/OtelTracer',
      '@effect/vitest',
    ],
  },
  'tests/package-common': {
    testProject: true,
    tests: [
      '@effect/vitest',
      '@effect/platform-node/NodeFileSystem#layer',
      'effect/http/FetchHttpClient#layer',
      '@effect/opentelemetry/OtelTracer',
      'effect/FileSystem#FileSystem',
      'effect/persistence/KeyValueStore',
    ],
    diagnosticOverrides: [
      {
        // These tests intentionally call sync commit APIs from Effect callbacks
        // to assert the synchronous commit boundary and its exit value.
        include: ['src/client-session/ClientSessionReconciliation.test.ts'],
        options: { diagnosticSeverity: { runEffectInsideEffect: 'off' } },
      },
      {
        include: ['src/client-session/ClientSessionSyncProcessor.test.ts'],
        options: { diagnosticSeverity: { runEffectInsideEffect: 'off' } },
      },
    ],
  },
} as const

type EffectUnstableApiProject = keyof typeof effectUnstableApiPolicy

/** Builds a project-scoped tsgo plugin config without relaxing its diagnostics. */
export const effectTsgoPluginFor = (project: EffectUnstableApiProject) => {
  const policy = effectUnstableApiPolicy[project]
  const basePlugin = baseTsconfigCompilerOptions.plugins[0]
  const runtime = 'runtime' in policy ? policy.runtime : []
  const tests = 'tests' in policy ? policy.tests : []
  const testProject = 'testProject' in policy && policy.testProject === true
  const baseOverrides =
    'overrides' in basePlugin && Array.isArray(basePlugin.overrides) === true ? basePlugin.overrides : []
  const diagnosticOverrides = 'diagnosticOverrides' in policy ? policy.diagnosticOverrides : []
  const testApiOverrides =
    testProject === false && tests.length > 0
      ? [
          {
            // tsgo overrides replace the base API list, so preserve runtime
            // capabilities while adding test APIs only to test source files.
            include: ['src/**/*.test.ts', 'src/**/*.spec.ts', 'src/**/*.test.tsx', 'src/**/*.spec.tsx'],
            options: { allowedUnstableApis: [...runtime, ...tests] },
          },
        ]
      : []
  const overrides = [...baseOverrides, ...testApiOverrides, ...diagnosticOverrides]

  return {
    ...basePlugin,
    allowedUnstableApis: testProject === true ? [...runtime, ...tests] : [...runtime],
    ...(overrides.length > baseOverrides.length ? { overrides } : {}),
  }
}

/**
 * Package tsconfig compiler options for livestore.
 * Uses src/ as rootDir (effect-utils uses . for rootDir).
 */
export const packageTsconfigCompilerOptions = {
  ...effectUtilsPackageTsconfigCompilerOptions,
  rootDir: './src',
  tsBuildInfoFile: './dist/.tsbuildinfo',
} as const

/**
 * Internal workspace packages using workspace:* protocol.
 *
 * The repo-root pnpm workspace is the authoritative install owner and lockfile
 * source of truth. Package closures are derived from workspace metadata at
 * build time instead of being committed as package-local pnpm-workspace files.
 */

const repo = defineRepoContext({
  name: 'livestore',
  importMetaUrl: import.meta.url,
})

const releaseVersion = repo.readJson<{
  readonly version: string
}>('release/version.json')

const forkToolProfile = repo.readJson<{ readonly packages: { readonly '@effect/tsgo': string } }>(
  'scripts/fork-qualification/tool-profile.json',
)
export const forkEffectTsgoVersion = forkToolProfile.packages['@effect/tsgo']

// Qualifying the reviewed latest compiler also resolves its exact official
// native packages. Keep pnpm's freshness exceptions versioned and reproducible.
export const forkCompilerMinimumReleaseAgeExclude = [
  '@effect/tsgo',
  ...['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-arm', 'linux-x64', 'win32-arm64', 'win32-x64'].map(
    (variant) => `@effect/tsgo-${variant}`,
  ),
].map((name) => `${name}@${forkEffectTsgoVersion}`)

/** Composed catalog - effect-utils base + Effect v4 + livestore-specific + workspace packages */
export const catalog = defineCatalog({
  ...effectUtilsCatalog,
  ...effectV4Catalog,
  ...livestoreWorkspaceCatalog,
  ...livestoreOnlyCatalog,
})

// compose installs inherited workspace peers from its catalog, so the native consumer must select its own cohort here.
export const nativeExpoCatalog = defineCatalog({ ...catalog, ...nativeExpoQualificationCatalog })

const WORKSPACE_REPO_NAME = 'livestore'

export const workspaceMember = (
  memberPath: string,
  pnpmPackageClosure: PnpmPackageClosureConfig = {},
): WorkspaceIdentity => ({
  repoName: WORKSPACE_REPO_NAME,
  memberPath,
  pnpmPackageClosure,
})

export const repoPnpmAllowBuilds = {
  ...commonPnpmPolicySettings.allowBuilds,
  '@parcel/watcher': true,
  '@mixedbread/cli': true,
  'cbor-extract': true,
  'dtrace-provider': true,
  protobufjs: true,
  puppeteer: true,
  workerd: true,
} as const

export const repoPnpmOnlyBuiltDependencies = Object.entries(repoPnpmAllowBuilds)
  .filter(([, isAllowed]) => isAllowed === true)
  .map(([name]) => name)
  .toSorted()

/** Repo-specific pnpm packageExtensions for starlight/typedoc peer resolution */
export const repoPackageExtensions = {
  // The Vue compiler imports the host TS API but omits its peer; match Volar's supported pre-7 host.
  // Remove this exact-version completion when upstream declares the TypeScript peer.
  '@vue/language-core@3.3.14': {
    peerDependencies: {
      typescript: '>=5 <7',
    },
  },
  '@livestore/devtools-vite': {
    dependencies: {
      '@parcel/watcher': '^2.5.6',
    },
  },
  // These plugins import Astro's schema/loader APIs and must share the host's nominal types.
  'starlight-auto-sidebar@0.4.1': {
    peerDependencies: {
      astro: '^7.0.0',
    },
  },
  'starlight-links-validator@0.27.0': {
    peerDependencies: {
      astro: '^7.0.0',
    },
  },
  'starlight-sidebar-topics@0.9.0': {
    peerDependencies: {
      astro: '^7.0.0',
    },
  },
  typedoc: {
    dependencies: {
      'typedoc-plugin-markdown': '^4.8.1',
    },
  },
} as const

// =============================================================================
// Package Config Exports
// =============================================================================

/** Incremental compiler caches remain private build evidence, never consumer assets. */
export const livestorePackageBuildCacheExclusions = ['!**/*.tsbuildinfo']

export const livestorePackageFiles = (...extraFiles: string[]) => [
  'dist',
  'package.json',
  'src',
  ...extraFiles,
  // Packlist patterns are ordered: later inclusions can otherwise reinclude caches.
  ...livestorePackageBuildCacheExclusions,
]

/** Common fields for published @livestore packages */
export const livestorePackageDefaults = {
  version: process.env.LIVESTORE_RELEASE_VERSION ?? releaseVersion.version,
  type: 'module' as const,
  sideEffects: false as const,
  license: 'Apache-2.0' as const,
  files: livestorePackageFiles(),
  repository: { type: 'git', url: 'git+https://github.com/livestorejs/livestore.git' },
}

/** Common fields for private @local packages (internal tooling) */
export const localPackageDefaults = {
  version: '0.0.0',
  type: 'module' as const,
  private: true as const,
}

// =============================================================================
// Effect Peer Dependency Helpers
// =============================================================================

/**
 * Peer dependencies for the public @livestore/utils surface.
 * These are the packages that utils exposes types or values from and consumers need.
 * Effect v4 consolidated the old auxiliary Effect packages, so only surviving
 * platform/provider packages remain public peers here.
 *
 * Usage pattern:
 * - Include in devDependencies via catalog.pick() for local development
 * - Include in peerDependencies via catalog.peers() for consumers
 */
export const utilsEffectPeerDeps = [
  'effect',
  '@effect/platform-browser',
  '@effect/platform-bun',
  '@effect/platform-node',
  '@effect/platform-node-shared',
  '@effect/opentelemetry',
  '@effect/vitest',
  '@opentelemetry/api',
  '@opentelemetry/resources',
  '@standard-schema/spec',
] as const

/**
 * Helper to get peer dependencies object from utils package.
 * Used by packages that depend on @livestore/utils to re-expose its peer deps.
 */
export const getUtilsPeerDeps = () => catalog.peers(...utilsEffectPeerDeps)

/**
 * Helper to get dev dependencies for packages using Effect types.
 * Combines peer deps (for local dev) with additional dev-only deps.
 */
export const effectDevDeps = (...additionalDeps: Parameters<typeof catalog.pick>) =>
  catalog.pick(...utilsEffectPeerDeps, ...additionalDeps)

// =============================================================================
// TypeScript Configuration Helpers
// =============================================================================

/** Standard package tsconfig exclude patterns.
 * Excludes node_modules and dist to avoid type-checking copied local packages.
 * See: effect-utils/context/workarounds/pnpm-issues.md
 * Also excludes *.genie.ts files which are only used by genie CLI, not tsc.
 */
export const packageTsconfigExclude = ['node_modules', '**/dist', '**/node_modules/.pnpm', '**/*.genie.ts'] as const

/** Solid JSX configuration */
export const solidJsx = { jsx: 'preserve' as const, jsxImportSource: 'solid-js' }

import {
  bashShellDefaults,
  cachixCliBuildStep,
  cachixStep,
  defaultActionlintConfig as defaultActionlintConfigBase,
  dispatchAlignmentStep,
  installNixStep,
  applyMegarepoLockStep,
  checkoutStep,
  defaultRefPolicyCheckJob,
  prepareCiScriptsStep,
  preparedCiRuntimeScriptsDir,
  preparePinnedDevenvStep,
  pnpmStateSetupStep,
  restoreMegarepoStoreStep,
  restorePnpmStateStep,
  runDevenvTasksBefore,
  nixDiagnosticsArtifactStep,
  saveMegarepoStoreStep,
  savePnpmStateStep,
  validateNixStoreStep,
  workflowReportCollectorStep,
  workflowReportCommentBodyStep,
  workflowReportProducerStep,
  workflowReportPublisherStep,
} from '#mr/effect-utils/genie/ci-workflow.ts'

export const devenvShellDefaults = {
  run: { shell: 'devenv shell bash -- -e {0}' },
} as const
export { bashShellDefaults }
export {
  applyMegarepoLockStep,
  cachixCliBuildStep,
  cachixStep,
  checkoutStep,
  dispatchAlignmentStep,
  installNixStep,
  nixDiagnosticsArtifactStep,
  pnpmStateSetupStep,
  preparePinnedDevenvStep,
  restorePnpmStateStep,
  runDevenvTasksBefore,
  savePnpmStateStep,
  validateNixStoreStep,
  workflowReportCollectorStep,
  workflowReportCommentBodyStep,
  workflowReportProducerStep,
  workflowReportPublisherStep,
}

export const defaultActionlintConfig = {
  ...defaultActionlintConfigBase,
  selfHostedRunnerLabels: [
    ...(defaultActionlintConfigBase.selfHostedRunnerLabels ?? []),
    'namespace-profile-linux-x86-64;job.priority=3',
    'namespace-profile-linux-x86-64;job.priority=6',
  ],
}

/** LiveStore delivery is priority 3; optional background work is priority 6. */
export const namespaceRunner = (runId: string, priority: 3 | 6 = 3) => {
  return [`namespace-profile-linux-x86-64;job.priority=${priority};github.run-id=${runId}`] as const
}

const shellSingleQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`

const setupMegarepoRun = (run: string) =>
  run.replace(
    'nix run "github:overengineeringstudio/effect-utils/$EU_REV#megarepo" -- apply --all',
    [
      'nix run --no-write-lock-file',
      '"github:overengineeringstudio/effect-utils/$EU_REV#megarepo" -- apply --all',
    ].join(' '),
  )

const withNixRetry = <TStep extends { readonly name: string; readonly run: string }>(
  step: TStep,
  run = step.run,
): TStep => ({
  ...step,
  run: [
    `__genie_ci_retry_script='${preparedCiRuntimeScriptsDir}/run-with-nix-gc-race-retry.sh'`,
    `bash "$__genie_ci_retry_script" ${shellSingleQuote(step.name)} ${shellSingleQuote(run)}`,
  ].join('\n'),
})

const withNixSetupRetry = <TStep extends { readonly name: string; readonly run: string }>(step: TStep): TStep =>
  withNixRetry(step, setupMegarepoRun(step.run))

/**
 * The megarepo-store sync step, opted into the shared cacheable-store path (#1480). Paired with
 * {@link restoreMegarepoStoreStep} / {@link saveMegarepoStoreStep} (from effect-utils) it stops CI
 * from cold-cloning large members (e.g. `effect-ts/effect`) every run: the store lives at the
 * stable `cacheableMegarepoStore` path so the actions/cache version is stable across runs and
 * restores hit. `withNixSetupRetry` preserves the step's `env` (the cacheable path)
 * and retries transient Nix store races without overriding the producer's flake inputs.
 */
const stableStoreSyncStep = applyMegarepoLockStep({ cacheableStore: true })

/**
 * Setup steps for livestore CI jobs (without checkout).
 * Uses shared step atoms from effect-utils/genie/ci-workflow.ts.
 */
export const livestoreSetupStepsAfterCheckout = [
  // Copy CI helper scripts after checkout and Nix installation so retry-wrapped
  // commands keep a stable helper path. Required by the genie CI workflow validator.
  installNixStep({
    extraConf:
      'extra-substituters = https://cache.nixos.org\nextra-trusted-public-keys = cache.nixos.org-1:6NCHdD59X431o0gWypbMrAURkbJ16ZPMQFGspcDShjY=',
  }),
  prepareCiScriptsStep,
  cachixCliBuildStep,
  (() => {
    const base = cachixStep({ name: 'livestore' })
    return { ...base, with: { ...base.with, skipPush: true } }
  })(),
  restoreMegarepoStoreStep(),
  withNixSetupRetry(stableStoreSyncStep),
  saveMegarepoStoreStep(),
  preparePinnedDevenvStep,
  pnpmStateSetupStep,
  restorePnpmStateStep({ keyPrefix: 'livestore-pnpm-state-v1' }),
  withNixRetry(validateNixStoreStep),
] as const

/**
 * Full setup steps for livestore CI jobs (includes checkout).
 * Use livestoreSetupStepsAfterCheckout if you need a custom checkout step.
 */
export const livestoreSetupSteps = [checkoutStep(), ...livestoreSetupStepsAfterCheckout] as const

/** Dedicated source-policy job so policy failures do not hide test/lint results. */
export const livestoreDefaultRefPolicyJob = defaultRefPolicyCheckJob({
  runsOn: namespaceRunner('${{ github.run_id }}'),
  firstPartyOwners: ['overengineeringstudio'],
  normalizeGitBranchRefs: true,
  verifyReachable: true,
})

/**
 * OTEL configuration step for Grafana Cloud.
 * Sets up authorization headers and endpoint URLs for trace export.
 */
export const otelSetupStep = {
  name: 'Set OTEL_EXPORTER_OTLP_HEADERS environment variable',
  env: {
    GRAFANA_CLOUD_OTLP_INSTANCE_ID: '1227256',
    GRAFANA_CLOUD_OTLP_API_KEY: '${{ secrets.GRAFANA_CLOUD_OTLP_API_KEY }}',
  },
  run: `echo "OTEL_EXPORTER_OTLP_HEADERS=Authorization=Basic $(echo -n "$GRAFANA_CLOUD_OTLP_INSTANCE_ID:$GRAFANA_CLOUD_OTLP_API_KEY" | base64 -w 0)" >> $GITHUB_ENV
echo "GRAFANA_ENDPOINT=https://livestore.grafana.net" >> $GITHUB_ENV
echo "OTEL_EXPORTER_OTLP_ENDPOINT=https://otlp-gateway-prod-us-east-2.grafana.net/otlp" >> $GITHUB_ENV
# Disable in Vite (otherwise CORS issues)
echo "VITE_OTEL_EXPORTER_OTLP_ENDPOINT=" >> $GITHUB_ENV`,
}

// =============================================================================
// TypeScript Reference Helpers
// =============================================================================

type LivestoreRefKey = {
  [K in LivestorePackageName]: K extends `${infer A}-${infer B}`
    ? `${A}${Capitalize<B>}` extends `${infer A2}-${infer B2}`
      ? `${A2}${Capitalize<B2>}`
      : `${A}${Capitalize<B>}`
    : K
}[LivestorePackageName]

/** Convert kebab-case to camelCase */
const toCamelCase = (s: string) => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase())

/**
 * Internal refs for use within LiveStore repo.
 * All packages are siblings, so paths are simple relative refs.
 */
export const refs = Object.fromEntries(
  livestoreCurrentPackageNames.map((name) => [toCamelCase(name), { path: `../${name}` }]),
) as { [K in LivestoreRefKey]: { path: string } }
