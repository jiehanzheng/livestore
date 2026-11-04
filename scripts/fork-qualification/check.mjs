import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'

import { inspectCommitEvidence, finishCommitEvidence, commitVerdict } from './commit-evidence.mjs'
import { digest, git, sourceState, toolInputs } from './commit-files.mjs'
import { sdkIdentity } from './commit-source.mjs'
import { declaredCommands, createSourcePolicy, PROJECTS, SOURCE_EXTENSIONS } from './qualification-policy.mjs'
import { verifyRuntimeTests } from './qualification-runtime.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const profilePath = path.join(root, 'scripts/fork-qualification/tool-profile.json')
const toolsPath = path.join(root, 'temp_nocommit/fork-qualification/tools.json')
const qualificationConfig = path.join(root, 'scripts/fork-qualification/vitest.config.ts')
const { validateSourceInventory, sourceInventory, authoredSourceInventory, validateCompilerPolicy } =
  createSourcePolicy(root)

const parseArgs = (args) => {
  if (args.length === 0 || (args.length === 1 && args[0] === '--check')) return { mode: 'check' }
  if (args.length === 1 && args[0] === '--fix') return { mode: 'fix' }
  if (args[0] === '--commit') {
    const rest = args[1] === '--' ? args.slice(2) : args.slice(1)
    if (rest.length === 0) return { mode: 'commit' }
    if (rest.length === 2 && rest[0] === '--evidence') return { mode: 'commit', evidenceFile: rest[1] }
  }
  if (args.length === 1 && ['--help', '-h'].includes(args[0]) === true) return { mode: 'help' }
  throw new Error(
    'Usage: node scripts/fork-qualification/check.mjs [--check | --fix | --commit --evidence <manifest.json>]',
  )
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

  if (isDeepStrictEqual(tools.commands, declaredCommands(tools.profile, profile.packages.typescript)) === false)
    throw new Error('Prepared tool commands differ from the declared recipe')
  const pnpm = path.join(tools.profile, 'node_modules/.bin/pnpm')
  if (captured(pnpm, ['--version'], root, env) !== profile.pnpm) throw new Error(`pnpm ${profile.pnpm} is required`)

  const expectedEnvironment = {
    GENIE_EXPORT_TYPE_PROOF_COMPILER: captured(tools.commands.compiler[0], ['get-exe-path'], tools.profile, env),
    GENIE_TYPESCRIPT_API_SERVER: path.join(
      tools.profile,
      '.canonical-genie/typescript-api-server/bin/typescript-api-server',
    ),
  }
  if (isDeepStrictEqual(tools.environment, expectedEnvironment) === false)
    throw new Error('Prepared generator/consumer tool paths differ')
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
  return {
    name,
    command: [command, ...args],
    exitCode: 0,
    joined: true,
    log: { path: logPath, sha256: sha256(readFileSync(logPath)) },
  }
}

const printHelp = () => {
  console.log(
    'Usage: node scripts/fork-qualification/check.mjs [--check | --fix | --commit --evidence <manifest.json>]',
  )
  console.log('  --check   Run local qualification gates without changing source (default)')
  console.log('  --fix     Run canonical Genie generation and Oxfmt source formatting, then check')
  console.log('  --commit  Require reviewed evidence, run local gates, then recheck conditional eligibility')
}

const main = () => {
  const { mode, evidenceFile } = parseArgs(process.argv.slice(2))
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
  const gateRecords = []
  const gate = (...args) => gateRecords.push(runGate(...args))
  const decide = (decision) => {
    const file = path.join(run, 'commit-decision.json')
    writeFileSync(file, `${JSON.stringify(decision, null, 2)}\n`)
    for (const issue of decision.blocking) console.error(`BLOCK ${issue.code}: ${issue.detail}`)
    if (decision.eligible === false) throw new Error(`Commit eligibility blocked. Decision: ${file}`)
    console.log(`Conditional scoped eligibility verified. No commit performed. Decision: ${file}`)
  }
  const commit = mode === 'commit' ? inspectCommitEvidence({ root, tools, evidenceFile }) : undefined
  if (commit?.issues.length > 0) decide(commitVerdict(commit))
  const generator = tools.commands.genie
  const runGenie = (name, cwd, extraArgs = []) =>
    gate(run, name, generator[0], [...generator.slice(1), '--check', '--cwd', cwd, ...extraArgs], root, env)
  const runGenieFix = (name, cwd, extraArgs = []) =>
    gate(run, name, generator[0], [...generator.slice(1), '--cwd', cwd, ...extraArgs], root, env)

  console.log(
    `Toolchain ready: Node ${process.version}, pnpm ${profile.pnpm}, Bun ${versions.bunVersion}, Oxlint ${versions.lintVersion}, Oxfmt ${versions.formatVersion}, TS ${profile.packages.typescript}/tsgo ${profile.packages['@effect/tsgo']}`,
  )
  console.log(
    `Explicit TypeScript project inventory: ${PROJECTS.length} projects; no source-based test discovery is used.`,
  )

  if (mode === 'fix') {
    runGenieFix('genie-root-bootstrap', root, ['--phase', 'bootstrap'])
    for (const area of ['packages', 'tests', 'scripts', 'docs']) runGenieFix(`genie-${area}`, path.join(root, area))
    gate(run, 'oxfmt-fix', tools.commands.format[0], authoredSourceInventory(), root, env)
  }

  gateRecords.length = 0
  const base = git(root, ['rev-parse', 'HEAD']).trim()
  const before = sourceState(root, base)
  const external = sourceState(path.join(root, 'repos/effect-utils'), profile.effectUtilsRevision)
  if (external.changed.length > 0) throw new Error('Pinned generator source changed')
  validateSourceInventory()
  validateCompilerPolicy()
  sourceInventory()
  const authoredFiles = authoredSourceInventory()
  const lintFiles = authoredFiles.filter((file) => SOURCE_EXTENSIONS.has(path.extname(file)))
  const lintConfig = effectiveLintConfig(run, tools)

  runGenie('genie-root-bootstrap', root, ['--phase', 'bootstrap'])
  for (const area of ['packages', 'tests', 'scripts', 'docs']) runGenie(`genie-${area}`, path.join(root, area))

  gate(run, 'source-format', tools.commands.format[0], ['--check', ...authoredFiles], root, env)
  gate(
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
  gate(
    run,
    'package-files-policy',
    process.execPath,
    ['--test', path.join(root, 'scripts/fork-qualification/package-files.test.mjs')],
    root,
    env,
  )
  gate(
    run,
    'commit-evidence-tests',
    process.execPath,
    [
      '--test',
      path.join(root, 'scripts/fork-qualification/bootstrap.test.mjs'),
      path.join(root, 'scripts/fork-qualification/upstream-source-inputs.test.mjs'),
      path.join(root, 'scripts/fork-qualification/commit-evidence.test.mjs'),
      path.join(root, 'scripts/fork-qualification/commit-consumer.test.mjs'),
    ],
    root,
    env,
  )
  gate(
    run,
    'typecheck-19-projects',
    tools.commands.compiler[0],
    [...tools.commands.compiler.slice(1), '--build', '--force', '--pretty', 'false', 'tsconfig.fork.json'],
    root,
    env,
  )

  const reportFile = path.join(run, 'vitest-runtime-report.json')
  gate(
    run,
    'vitest-eight-project-runtime-suite',
    path.join(root, 'node_modules/.bin/vitest'),
    ['run', '--config', qualificationConfig, '--reporter=json', '--outputFile', reportFile],
    root,
    env,
  )
  const testSummary = verifyRuntimeTests(root, reportFile)
  console.log(
    `Runtime tests passed: ${testSummary.passed}; skipped ${testSummary.skipped}; ${testSummary.files} files; all four process-kill controls passed.`,
  )

  // The full inventory retains upstream bytes and modes even though authored style excludes their exact paths.
  sourceInventory()
  const after = sourceState(root, base)
  if (
    digest(after.tree) !== digest(before.tree) ||
    after.indexDigest !== before.indexDigest ||
    after.physicalDigest !== before.physicalDigest
  )
    throw new Error('Authored source or index changed while qualification ran')
  const local = {
    contract: 'livestore-fork-local-qualification-v1',
    root,
    base,
    sourceTreeSha256: digest(before.tree),
    externalTreeSha256: digest(external.tree),
    sdkSourceSeal: digest(sdkIdentity(root, before.tree)),
    toolInputsSha256: digest(toolInputs(tools)),
    gates: gateRecords,
    runtime: testSummary,
  }
  writeFileSync(path.join(run, 'local-qualification.json'), `${JSON.stringify(local, null, 2)}\n`)
  console.log(`Local checks passed. Full log directory: ${run}`)
  console.log('No SDK qualification or commit eligibility is implied without the approved scope and app receipts.')
  if (commit !== undefined) decide(finishCommitEvidence(commit, local))
}

try {
  main()
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
