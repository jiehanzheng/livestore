import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const profilePath = path.join(root, 'scripts/fork-qualification/tool-profile.json')
const toolsPath = path.join(root, 'temp_nocommit/fork-qualification/tools.json')
const qualificationConfig = path.join(root, 'scripts/fork-qualification/vitest.config.ts')

const PROJECTS = [
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
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'])

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

const PROJECT_TEST_ROOTS = [
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

const REQUIRED_CRASH_CASES = [
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

const parseArgs = (args) => {
  if (args.length === 0 || (args.length === 1 && args[0] === '--check')) return { mode: 'check' }
  if (args.length === 1 && args[0] === '--fix') return { mode: 'fix' }
  if (args.length === 1 && args[0] === '--commit') return { mode: 'commit' }
  if (args.length === 1 && ['--help', '-h'].includes(args[0]) === true) return { mode: 'help' }
  throw new Error('Usage: node scripts/fork-qualification/check.mjs [--check | --fix | --commit]')
}

const readJson = (file) => {
  const source = readFileSync(file, 'utf8')
  return JSON.parse(source.slice(source.indexOf('{')))
}

const sha256 = (value) => createHash('sha256').update(value).digest('hex')

const tail = (text, lineCount = 40) => text.trimEnd().split(/\r?\n/).slice(-lineCount).join('\n')

const captured = (command, args, cwd, env) => {
  const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  if (result.error !== undefined) throw new Error(`${command} could not run: ${result.error.message}`)
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} exited ${result.status}: ${tail(result.stderr || result.stdout || '')}`,
    )
  }
  return result.stdout.trim()
}

const validateToolchain = (profile, tools, env) => {
  if (`${process.platform}-${process.arch}` !== profile.platform) {
    throw new Error(`This qualification profile requires ${profile.platform}; got ${process.platform}-${process.arch}`)
  }
  if (Number(process.versions.node.split('.')[0]) !== profile.nodeMajor) {
    throw new Error(`Node ${profile.nodeMajor} is required; current runtime is ${process.version}`)
  }
  if (JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).packageManager !== `pnpm@${profile.pnpm}`) {
    throw new Error(`package.json must pin pnpm@${profile.pnpm}`)
  }
  if (tools.specSha256 !== sha256(readFileSync(profilePath))) {
    throw new Error('Prepared tool descriptor does not match the checked-in tool profile; rerun fork:bootstrap')
  }

  const pnpm = path.join(tools.profile, 'node_modules/.bin/pnpm')
  if (captured(pnpm, ['--version'], root, env) !== profile.pnpm) throw new Error(`pnpm ${profile.pnpm} is required`)

  const bunVersion = captured(tools.commands.genie[0], ['--version'], root, env)
  if (bunVersion !== profile.packages['@oven/bun-darwin-aarch64'])
    throw new Error('Prepared Bun version does not match tool-profile.json')

  const compilerVersion = captured(
    tools.commands.compiler[0],
    [...tools.commands.compiler.slice(1), '--version'],
    root,
    env,
  )
  if (
    compilerVersion.includes(`${profile.packages.typescript}+effect-tsgo.${profile.packages['@effect/tsgo']}`) === false
  ) {
    throw new Error(`Prepared Effect TypeScript compiler differs from the tool profile: ${compilerVersion}`)
  }

  const lintVersion = captured(tools.commands.lint[0], [...tools.commands.lint.slice(1), '--version'], root, env)
  if (lintVersion.includes(profile.packages.oxlint) === false)
    throw new Error(`Prepared Oxlint version differs: ${lintVersion}`)
  const formatVersion = captured(tools.commands.format[0], ['--version'], root, env)
  if (formatVersion.includes(profile.packages.oxfmt) === false)
    throw new Error(`Prepared Oxfmt version differs: ${formatVersion}`)

  for (const command of Object.values(tools.commands)) {
    if (Array.isArray(command) === false || typeof command[0] !== 'string' || existsSync(command[0]) === false) {
      throw new Error(`Prepared tool is missing or malformed: ${JSON.stringify(command)}`)
    }
    if (command.some((arg) => typeof arg !== 'string') === true)
      throw new Error(`Malformed prepared command: ${command[0]}`)
  }
  return { pnpm, bunVersion, compilerVersion, lintVersion, formatVersion }
}

const validateSourceInventory = () => {
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
  const generatorFiles = new Set(GENERATOR_SOURCES)
  const ownerConfigSources = new Set(PROJECTS.map((project) => `${project}/tsconfig.json.genie.ts`))
  const files = gitFiles(root)
    .filter((file) => {
      if (generatorFiles.has(file) === true || ownerConfigSources.has(file) === true) return true
      if (ROOT_SUPPORT_SOURCES.has(file) === true) return true
      if (file.startsWith('scripts/fork-qualification/') === true) return SOURCE_EXTENSIONS.has(path.extname(file))
      return (
        OWNER_ROOTS.some((owner) => file.startsWith(`${owner}/`)) &&
        SOURCE_EXTENSIONS.has(path.extname(file)) &&
        isGeneratedOrBuildOutput(file) === false
      )
    })
    .toSorted()

  const missing = files.filter((file) => existsSync(path.join(root, file)) === false)
  if (missing.length > 0) throw new Error(`Source inventory includes missing files: ${missing.join(', ')}`)
  if (files.length === 0) throw new Error('Source inventory is empty')
  return files
}

const effectiveLintConfig = (run, tools) => {
  const canonicalConfig = readJson(path.join(root, '.oxlintrc.json'))
  const { jsPlugins } = canonicalConfig
  if (Array.isArray(jsPlugins) === false || jsPlugins.length !== 1) {
    throw new Error('Effective Oxlint config must contain exactly one Genie JS plugin path')
  }
  const expectedPlugin = path.resolve(tools.profile, '.canonical-genie/oxc-config.js')
  const config = { ...canonicalConfig, jsPlugins: [expectedPlugin] }
  const configPath = path.join(run, 'oxlint-effective.json')
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`)

  const compareConfig = { ...config, jsPlugins: canonicalConfig.jsPlugins }
  if (isDeepStrictEqual(compareConfig, canonicalConfig) === false) {
    throw new Error('Effective Oxlint config changed outside its portable Genie plugin path')
  }
  if (existsSync(expectedPlugin) === false) throw new Error(`Prepared Oxlint plugin is missing: ${expectedPlugin}`)
  return configPath
}

const validateCompilerPolicy = () => {
  for (const project of PROJECTS) {
    const tsconfig = readJson(path.join(root, project, 'tsconfig.json'))
    const plugin = tsconfig.compilerOptions?.plugins?.find((item) => item.name === '@effect/language-service')
    if (plugin === undefined) throw new Error(`${project}/tsconfig.json is missing the Effect language-service plugin`)
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

const runGate = (run, name, command, args, cwd, env) => {
  const logPath = path.join(run, `${name}.log`)
  const logFd = openSync(logPath, 'w')
  let result
  try {
    result = spawnSync(command, args, { cwd, env, stdio: ['ignore', logFd, logFd] })
  } finally {
    closeSync(logFd)
  }
  if (result.error !== undefined || result.status !== 0) {
    const output = readFileSync(logPath, 'utf8')
    const commandSummary =
      args.length <= 8 ? args.join(' ') : `${args.slice(0, 5).join(' ')} … (${args.length} arguments)`
    console.error(`FAIL ${name}: ${command} ${commandSummary} (exit ${result.status ?? 'spawn error'})`)
    if (result.error !== undefined) console.error(result.error.message)
    if (output.length > 0) console.error(tail(output))
    console.error(`Full log: ${logPath}`)
    throw new Error(`${name} failed`)
  }
  const output = readFileSync(logPath, 'utf8')
  const lines = output.length === 0 ? 0 : output.trimEnd().split(/\r?\n/).length
  console.log(`PASS ${name}${lines === 0 ? '' : ` (${lines} log lines; ${logPath})`}`)
}

const verifyRuntimeTests = (reportFile) => {
  const report = JSON.parse(readFileSync(reportFile, 'utf8'))
  const suites = report.testResults
  if (Array.isArray(suites) === false) throw new Error('Vitest JSON report lacks runtime-discovered testResults')

  const assertions = []
  const collect = (value) => {
    if (Array.isArray(value) === true) {
      for (const entry of value) collect(entry)
      return
    }
    if (value === null || typeof value !== 'object') return
    if (typeof value.fullName === 'string' && typeof value.status === 'string') assertions.push(value)
    for (const entry of Object.values(value)) collect(entry)
  }
  collect(suites)

  const passed = assertions.filter((item) => item.status === 'passed').length
  const failed = assertions.filter((item) => item.status === 'failed').length
  const skipped = assertions.filter((item) => ['pending', 'skipped', 'todo'].includes(item.status)).length
  if (passed < 904 || failed !== 0 || skipped !== 3 || suites.length < 96) {
    throw new Error(
      `Runtime Vitest report did not meet the floor (passed=${passed}, failed=${failed}, skipped=${skipped}, files=${suites.length})`,
    )
  }

  const expectedSkippedCases = [
    'LeaderSyncProcessor clears databases on BackendIdMismatchError pull with reset',
    'StoreRegistry time-dependent (using TestClock) keeps the longest unusedCacheTime seen for a store when options vary across calls',
    'experimental useStore should load store with unusedCacheTime set to 0',
  ]
  const skippedCases = assertions
    .filter((item) => ['pending', 'skipped', 'todo'].includes(item.status))
    .map((item) => item.fullName)
  const byName = (left, right) => left.localeCompare(right)
  if (JSON.stringify(skippedCases.toSorted(byName)) !== JSON.stringify(expectedSkippedCases.toSorted(byName))) {
    throw new Error('Runtime skipped cases differ from the explicitly retained pre-existing gaps')
  }

  const suiteNames = suites.map((suite) => path.resolve(suite.name ?? ''))
  for (const project of PROJECT_TEST_ROOTS) {
    if (suiteNames.some((name) => name.startsWith(`${path.join(root, project)}${path.sep}`)) === false) {
      throw new Error(`Runtime Vitest discovery omitted project ${project}`)
    }
  }

  const crashCases = REQUIRED_CRASH_CASES.map((crashCase) => {
    const matches = assertions.filter((item) => item.fullName.includes(`eventlog COMMIT ${crashCase}`))
    if (matches.length !== 1 || matches[0].status !== 'passed') {
      throw new Error(`Required real SIGKILL case was not runtime-discovered and passed: ${crashCase}`)
    }
    return { name: crashCase, status: 'passed', executed: true }
  })

  return { passed, failed, skipped, files: suites.length, projects: PROJECT_TEST_ROOTS, crashCases }
}

const printHelp = () => {
  console.log('Usage: node scripts/fork-qualification/check.mjs [--check | --fix | --commit]')
  console.log('  --check   Run local qualification gates without changing source (default)')
  console.log('  --fix     Run canonical Genie generation and Oxfmt source formatting, then check')
  console.log('  --commit  Run local gates, then require approved policy and app acceptance receipts')
}

const main = () => {
  const { mode } = parseArgs(process.argv.slice(2))
  if (mode === 'help') return printHelp()

  const profile = JSON.parse(readFileSync(profilePath, 'utf8'))
  const tools = JSON.parse(readFileSync(toolsPath, 'utf8'))
  const temporary = path.join(root, 'temp_nocommit')
  const ignoreFile = path.join(temporary, '.gitignore')
  if (existsSync(ignoreFile) === false)
    throw new Error('temp_nocommit/.gitignore is required before writing qualification logs')
  const ignoreCheck = spawnSync('git', ['check-ignore', '--quiet', 'temp_nocommit/fork-qualification/probe.json'], {
    cwd: root,
    stdio: 'ignore',
  })
  if (ignoreCheck.status !== 0) throw new Error('temp_nocommit/fork-qualification is not ignored by Git')

  const env = {
    ...process.env,
    PATH: [path.join(tools.profile, 'node_modules/.bin'), path.dirname(process.execPath), process.env.PATH]
      .filter(Boolean)
      .join(path.delimiter),
    ...tools.environment,
  }
  const versions = validateToolchain(profile, tools, env)

  const run = path.join(temporary, 'fork-qualification', `run-${Date.now()}-${process.pid}`)
  mkdirSync(run, { recursive: true })
  const generator = tools.commands.genie
  const runGenie = (name, cwd, extraArgs = []) =>
    runGate(run, name, generator[0], [...generator.slice(1), '--check', '--cwd', cwd, ...extraArgs], root, env)
  const runGenieFix = (name, cwd, extraArgs = []) =>
    runGate(run, name, generator[0], [...generator.slice(1), '--cwd', cwd, ...extraArgs], root, env)

  console.log(
    `Toolchain ready: Node ${process.version}, pnpm ${profile.pnpm}, Bun ${versions.bunVersion}, Oxlint ${versions.lintVersion}, Oxfmt ${versions.formatVersion}, TS ${profile.packages.typescript}/tsgo ${profile.packages['@effect/tsgo']}`,
  )
  console.log(
    `Explicit TypeScript project inventory: ${PROJECTS.length} projects; no source-based test discovery is used.`,
  )

  if (mode === 'fix') {
    runGenieFix('genie-root-bootstrap', root, ['--phase', 'bootstrap'])
    for (const area of ['packages', 'tests', 'scripts', 'docs']) runGenieFix(`genie-${area}`, path.join(root, area))
    runGate(run, 'oxfmt-fix', tools.commands.format[0], sourceInventory(), root, env)
  }

  validateSourceInventory()
  validateCompilerPolicy()
  const sourceFiles = sourceInventory()
  const lintFiles = sourceFiles.filter((file) => SOURCE_EXTENSIONS.has(path.extname(file)))
  const lintConfig = effectiveLintConfig(run, tools)

  runGenie('genie-root-bootstrap', root, ['--phase', 'bootstrap'])
  for (const area of ['packages', 'tests', 'scripts', 'docs']) runGenie(`genie-${area}`, path.join(root, area))

  runGate(run, 'source-format', tools.commands.format[0], ['--check', ...sourceFiles], root, env)
  runGate(
    run,
    'source-lint-type-aware',
    tools.commands.lint[0],
    [
      ...tools.commands.lint.slice(1),
      '--type-aware',
      '--tsconfig',
      'tsconfig.dev.json',
      '--deny-warnings',
      '--config',
      lintConfig,
      ...lintFiles,
    ],
    root,
    env,
  )
  runGate(
    run,
    'typecheck-19-projects',
    tools.commands.compiler[0],
    [...tools.commands.compiler.slice(1), '--build', '--force', '--pretty', 'false', 'tsconfig.fork.json'],
    root,
    env,
  )

  const reportFile = path.join(run, 'vitest-runtime-report.json')
  runGate(
    run,
    'vitest-eight-project-runtime-suite',
    path.join(root, 'node_modules/.bin/vitest'),
    ['run', '--config', qualificationConfig, '--reporter=json', '--outputFile', reportFile],
    root,
    env,
  )
  const testSummary = verifyRuntimeTests(reportFile)
  console.log(
    `Runtime tests passed: ${testSummary.passed}; skipped ${testSummary.skipped}; ${testSummary.files} files; all four process-kill controls passed.`,
  )

  console.log(`Local checks passed. Full log directory: ${run}`)
  console.log('No SDK qualification or commit eligibility is implied without the approved scope and app receipts.')
  if (mode === 'commit') {
    throw new Error(
      'commit check blocked: approved policy/source identity and lead-owned web/iOS acceptance receipts are unavailable; no commit authority is active',
    )
  }
}

try {
  main()
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
