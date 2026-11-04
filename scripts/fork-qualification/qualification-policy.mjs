import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, readFileSync } from 'node:fs'
import path from 'node:path'

import {
  UPSTREAM_AUTHORED_README,
  UPSTREAM_SOURCE_INPUTS,
  UPSTREAM_SOURCE_ROOT,
  validateUpstreamSourceInputs,
} from './upstream-source-inputs.mjs'

const readJson = (file) => {
  const text = readFileSync(file, 'utf8')
  return JSON.parse(text.slice(text.indexOf('{')))
}

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

const OWNER_ROOTS = [...PROJECTS]
export const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'])

const GENERATOR_SOURCES = [
  '.oxfmtrc.json.genie.ts',
  '.oxlintrc.json.genie.ts',
  'package.json.genie.ts',
  'pnpm-install-contract.json.genie.ts',
  'pnpm-workspace.yaml.genie.ts',
  'tsconfig.dev.json.genie.ts',
  'tsconfig.json.genie.ts',
  'tsconfig.fork.json.genie.ts',
]

// These helpers are imported by generators outside the qualified package owners.
const ROOT_SUPPORT_SOURCES = new Set([
  'genie/external.ts',
  'genie/repo.ts',
  'genie/repo-topology.ts',
  'genie/release-topology.ts',
  'genie/docs-effect-api-policy.ts',
])

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

const TEST_OVERRIDE_PROJECTS = new Set([
  'packages/@livestore/sqlite-wasm',
  'packages/@livestore/adapter-web',
  'packages/@livestore/common',
  'packages/@livestore/common-cf',
  'packages/@livestore/livestore',
  'packages/@livestore/react',
  'packages/@livestore/sync-cf',
  'packages/@livestore/utils',
  'packages/@livestore/utils-dev',
  'packages/@livestore/webmesh',
])

export const REQUIRED_CRASH_CASES = [
  'crash-before-state',
  'crash-after-state',
  'crash-after-eventlog',
  'crash-after-completion',
]

const APPROVED_DIAGNOSTIC_EXCEPTIONS = new Map([
  [
    'packages/@livestore/common',
    new Map([
      ['src/sync/syncstate.ts', 'schemaClassMissingBrand'],
      ['src/schema/state/sqlite/db-schema/ast/fingerprint.test.ts', 'schemaNumber'],
    ]),
  ],
  [
    'tests/package-common',
    new Map([
      ['src/client-session/ClientSessionReconciliation.test.ts', 'runEffectInsideEffect'],
      ['src/client-session/ClientSessionSyncProcessor.test.ts', 'runEffectInsideEffect'],
    ]),
  ],
])

export const createSourcePolicy = (root) => {
  const validateSourceInventory = () => {
    validateUpstreamSourceInputs(root)
    const missing = [
      ...GENERATOR_SOURCES,
      ...ROOT_SUPPORT_SOURCES,
      ...PROJECTS.map((project) => `${project}/tsconfig.json.genie.ts`),
    ].filter((file) => existsSync(path.join(root, file)) === false)
    if (missing.length > 0) throw new Error(`Qualification source inventory is incomplete: ${missing.join(', ')}`)

    const forkConfig = readJson(path.join(root, 'tsconfig.fork.json'))
    const references = (forkConfig.references ?? []).map((reference) => path.normalize(reference.path))
    const expected = PROJECTS.map((project) => path.normalize(`./${project}`))
    if (
      references.length !== expected.length ||
      new Set(references).size !== references.length ||
      expected.some((project) => references.includes(project) === false) === true
    ) {
      throw new Error('tsconfig.fork.json references differ from the explicit 19-project qualification inventory')
    }
  }

  const gitFiles = (cwd) => {
    const result = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    if (result.error !== undefined || result.status !== 0) {
      throw new Error(`Could not inventory source files with git ls-files: ${result.stderr || result.error?.message}`)
    }
    return result.stdout.split('\0').filter(Boolean)
  }

  const isGeneratedOrBuildOutput = (file) => {
    const segments = file.split('/')
    return (
      segments.some((segment) =>
        ['node_modules', '.yarn', 'dist', 'build', 'out', '.turbo', '.vite'].includes(segment),
      ) ||
      /(?:\.gen|\.generated)\.tsx?$/.test(file) ||
      file.endsWith('/routeTree.gen.ts')
    )
  }

  const sourceInventory = () => {
    const upstream = validateUpstreamSourceInputs(root)
    const generatorFiles = new Set(GENERATOR_SOURCES)
    const ownerConfigSources = new Set(PROJECTS.map((project) => `${project}/tsconfig.json.genie.ts`))
    const gitInventory = gitFiles(root)
    const boundInputs = [...upstream, UPSTREAM_AUTHORED_README]
    if (boundInputs.some((file) => gitInventory.includes(file) === false) === true)
      throw new Error('Pinned upstream inputs or authored provenance are absent from git source inventory')
    const files = [
      ...new Set([
        ...gitInventory.filter((file) => {
          if (generatorFiles.has(file) === true || ownerConfigSources.has(file) === true) return true
          if (ROOT_SUPPORT_SOURCES.has(file) === true) return true
          // Git lists tracked deletions too. They remain receipt changes, but are no longer current authored inputs.
          const absolute = path.join(root, file)
          if (existsSync(absolute) === false && lstatSync(absolute, { throwIfNoEntry: false }) === undefined)
            return false
          if (file.startsWith('scripts/fork-qualification/') === true) return SOURCE_EXTENSIONS.has(path.extname(file))
          return (
            OWNER_ROOTS.some((owner) => file.startsWith(`${owner}/`)) &&
            SOURCE_EXTENSIONS.has(path.extname(file)) &&
            isGeneratedOrBuildOutput(file) === false
          )
        }),
        ...boundInputs,
      ]),
    ].toSorted((left, right) => (left < right ? -1 : left > right ? 1 : 0))

    const missing = files.filter((file) => existsSync(path.join(root, file)) === false)
    if (missing.length > 0) throw new Error(`Source inventory includes missing files: ${missing.join(', ')}`)
    if (files.length === 0) throw new Error('Source inventory is empty')
    return files
  }

  const upstreamStyleExclusions = new Set(UPSTREAM_SOURCE_INPUTS.map((row) => `${UPSTREAM_SOURCE_ROOT}/${row.path}`))
  const authoredSourceInventory = () => sourceInventory().filter((file) => upstreamStyleExclusions.has(file) === false)

  const validateCompilerPolicy = () => {
    for (const project of PROJECTS) {
      const tsconfig = readJson(path.join(root, project, 'tsconfig.json'))
      const plugin = tsconfig.compilerOptions?.plugins?.find((item) => item.name === '@effect/language-service')
      if (plugin === undefined)
        throw new Error(`${project}/tsconfig.json is missing the Effect language-service plugin`)
      for (const flag of [
        'ignoreEffectSuggestionsInTscExitCode',
        'ignoreEffectWarningsInTscExitCode',
        'ignoreEffectErrorsInTscExitCode',
      ]) {
        if (plugin[flag] !== false) throw new Error(`${project} must keep ${flag}=false`)
      }
      if (plugin.includeSuggestionsInTsc !== true)
        throw new Error(`${project} must keep Effect suggestions visible to tsc`)

      if (TEST_OVERRIDE_PROJECTS.has(project) === true) {
        const expectedPatterns = ['src/**/*.test.ts', 'src/**/*.spec.ts', 'src/**/*.test.tsx', 'src/**/*.spec.tsx']
        const hasTestOverride = (plugin.overrides ?? []).some((override) =>
          expectedPatterns.every((pattern) => override.include?.includes(pattern) === true),
        )
        if (hasTestOverride === false) throw new Error(`${project} must scope test-only APIs to TS and TSX test files`)
      }

      const observedExceptions = new Map()
      for (const override of plugin.overrides ?? []) {
        const severities = override.options?.diagnosticSeverity ?? {}
        for (const [rule, severity] of Object.entries(severities)) {
          if (severity !== 'off') continue
          for (const include of override.include ?? []) observedExceptions.set(include, rule)
        }
      }
      const expectedExceptions = APPROVED_DIAGNOSTIC_EXCEPTIONS.get(project) ?? new Map()
      const compareEntries = ([left], [right]) => left.localeCompare(right)
      if (
        JSON.stringify([...observedExceptions].toSorted(compareEntries)) !==
        JSON.stringify([...expectedExceptions].toSorted(compareEntries))
      ) {
        throw new Error(`${project} has missing or unapproved per-file diagnostic exceptions`)
      }
    }
  }

  return { validateSourceInventory, sourceInventory, authoredSourceInventory, validateCompilerPolicy, gitFiles }
}

export const declaredCommands = (profile, typescript) => ({
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
