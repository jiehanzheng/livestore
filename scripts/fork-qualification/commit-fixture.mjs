import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { consumerGraph, runtimeEffects } from './commit-consumer.mjs'
import { requiredCases } from './commit-evidence.mjs'
import { digest, hash, sourceState, toolInputs, walkPayload } from './commit-files.mjs'
import {
  decisionPath,
  decisionSha,
  fullSetupInput,
  proposalSha,
  requiredGates,
  scopeBinding,
  sdkIdentity,
  sdkNames,
  supportPaths,
} from './commit-source.mjs'
import { REQUIRED_CRASH_CASES } from './qualification-policy.mjs'
import { expectedSkippedCases } from './qualification-runtime.mjs'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const prepared = JSON.parse(fs.readFileSync(path.join(repo, 'temp_nocommit/fork-qualification/tools.json'), 'utf8'))
const write = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, typeof value === 'string' ? value : `${JSON.stringify(value)}\n`)
}
const fixtureGit = (root, args) => {
  // Disposable fixture histories have no global hooks, credentials or signing configuration.
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: os.devNull,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Fixture',
    GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Fixture',
    GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
  }
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete env[key]
  const result = spawnSync('git', args, { cwd: root, env, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`Fixture git failed: ${result.stderr}`)
  return result.stdout.trim()
}
const initialize = (root) => {
  fs.mkdirSync(root, { recursive: true })
  fixtureGit(root, ['init', '--quiet'])
  fixtureGit(root, ['add', '.'])
  fixtureGit(root, ['commit', '--quiet', '-m', 'fixture baseline'])
  return fixtureGit(root, ['rev-parse', 'HEAD'])
}
export const makeFixture = () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'livestore-commit-evidence-'))
  const root = path.join(home, 'source')
  const externalRoot = path.join(root, 'repos/effect-utils')
  write(path.join(externalRoot, 'value.ts'), 'export const pin = true\n')
  const pin = initialize(externalRoot)
  write(path.join(root, '.gitignore'), 'repos/\nnode_modules/\ntemp_nocommit/\n')
  write(path.join(root, decisionPath), fs.readFileSync(path.join(repo, decisionPath), 'utf8'))
  write(path.join(root, 'flake.nix'), 'frozen fixture full-setup input\n')
  const catalog = 'packages/@local/astro-twoslash-code/src/cli/test-fixtures/catalog/'
  write(path.join(root, catalog, 'tsconfig.json'), '{"compilerOptions":{"strict":true}}\n')
  write(
    path.join(root, catalog, 'tsconfig.json.genie.ts'),
    fs.readFileSync(path.join(repo, catalog, 'tsconfig.json.genie.ts'), 'utf8'),
  )
  for (const name of supportPaths) write(path.join(root, name), '{}\n')
  write(path.join(root, 'package.json'), { name: 'fixture-sdk', private: true, devDependencies: { effect: '4.1.2' } })
  write(path.join(root, 'scripts/fork-qualification/tool-profile.json'), { effectUtilsRevision: pin })
  for (const name of sdkNames) {
    write(path.join(root, 'packages', name, 'package.json'), {
      name,
      version: '0.0.0',
      files: ['src', 'package.json'],
      dependencies: { effect: '4.1.2' },
    })
    write(path.join(root, 'packages', name, 'src/value.js'), 'export const value = 0\n')
  }
  const base = initialize(root)
  write(path.join(root, 'packages/@livestore/common/src/value.js'), 'export const value = 1\n')
  fixtureGit(root, ['add', 'packages/@livestore/common/src/value.js'])
  const state = sourceState(root, base)
  const external = sourceState(externalRoot, pin)
  const toolsFile = path.join(home, 'mock-tool')
  write(toolsFile, 'fixture tool bytes\n')
  const tools = { commands: { pnpm: prepared.commands.pnpm, compiler: [toolsFile] }, environment: {} }
  const ref = (file) => ({ path: file, sha256: hash(fs.readFileSync(file)) })
  let counter = 0
  const json = (body) => {
    const file = path.join(home, 'evidence', `${counter++}.json`)
    write(file, body)
    return ref(file)
  }
  const identity = sdkIdentity(root, state.tree)
  const seal = digest(identity)
  const candidate = path.join(home, 'candidates', seal)
  for (const name of sdkNames)
    fs.cpSync(path.join(root, 'packages', name), path.join(candidate, 'packages', name), { recursive: true })
  const packages = sdkNames.map((name) => ({ name, files: walkPayload(path.join(candidate, 'packages', name)) }))
  for (const pkg of packages) pkg.sha256 = hash(JSON.stringify(pkg.files))
  const payload = hash(JSON.stringify(packages.map(({ name, sha256 }) => ({ name, sha256 }))))
  const artifact = {
    contract: 'livestore-qualified-package-payload-v1',
    sourceSeal: seal,
    packages,
    files: packages.reduce((sum, value) => sum + value.files.length, 0),
    directoryIdentity: payload,
  }
  const snapshotFiles = [
    ...state.tree.map((row) => ({
      path: row.path,
      sha256: hash(fs.readFileSync(path.join(root, row.path))),
      kind: 'file',
      mode: fs.statSync(path.join(root, row.path)).mode & 0o777,
    })),
    ...external.tree.map((row) => ({
      path: `repos/effect-utils/${row.path}`,
      sha256: hash(fs.readFileSync(path.join(externalRoot, row.path))),
      kind: 'file',
      mode: fs.statSync(path.join(externalRoot, row.path)).mode & 0o777,
    })),
  ]
  for (const row of snapshotFiles)
    write(path.join(candidate, row.path), fs.readFileSync(path.join(root, row.path), 'utf8'))
  const sourceInventory = json({
    sourceInventorySha256: seal,
    identity,
    snapshotFiles,
    snapshotInventorySha256: digest(snapshotFiles),
    baseCommit: base,
  })
  const payloadInventory = json(artifact)
  const consumer = path.join(home, 'consumer')
  write(path.join(consumer, 'package.json'), {
    name: 'fixture-consumer',
    dependencies: Object.fromEntries(sdkNames.map((name) => [name, '*'])),
  })
  write(path.join(consumer, 'lock.json'), 'fixture frozen consumer lock\n')
  for (const name of sdkNames)
    fs.cpSync(path.join(candidate, 'packages', name), path.join(consumer, 'node_modules', name), { recursive: true })
  write(path.join(consumer, 'node_modules/effect/package.json'), { name: 'effect', version: '4.1.2' })
  write(path.join(consumer, 'node_modules/effect/index.js'), 'export const core = true\n')
  const graph = consumerGraph([{ root: consumer, includeDev: false }])
  const effect = [
    ...runtimeEffects(
      graph,
      [...graph.values()].filter((node) => sdkNames.includes(node.name)).map((node) => node.root),
    ).values(),
  ]
  const cohort = effect.map((node) => ({ name: node.name, version: '4.1.2', files: walkPayload(node.root) }))
  const gateLog = json({ synthetic: 'unit fixture only, never a real qualification' })
  const runtime = {
    passed: 904,
    failed: 0,
    skipped: 3,
    skippedCases: expectedSkippedCases,
    files: 96,
    crashCases: REQUIRED_CRASH_CASES.map((name) => ({ name, status: 'passed', executed: true })),
  }
  const localFor = (at) => ({
    contract: 'livestore-fork-local-qualification-v1',
    root: at,
    sourceTreeSha256: digest(state.tree),
    externalTreeSha256: digest(external.tree),
    sdkSourceSeal: seal,
    toolInputsSha256: digest(toolInputs(tools)),
    gates: requiredGates.map((name) => ({ name, exitCode: 0, joined: true, log: gateLog })),
    runtime,
  })
  const builds = []
  for (const name of ['clean-a', 'clean-b']) {
    const build = path.join(home, name)
    fixtureGit(home, ['clone', '--quiet', '--no-hardlinks', root, build])
    for (const row of state.tree) write(path.join(build, row.path), fs.readFileSync(path.join(root, row.path), 'utf8'))
    fixtureGit(build, ['clone', '--quiet', '--no-hardlinks', externalRoot, 'repos/effect-utils'])
    builds.push(
      json({
        contract: 'livestore-fork-clean-build-v1',
        local: json(localFor(build)),
        bootstrap: { exitCode: 0, joined: true, log: gateLog },
        install: { exitCode: 0, joined: true, frozen: true, strictPeers: true, log: gateLog },
      }),
    )
  }
  const appFile = path.join(home, 'accepted-app.js')
  write(appFile, 'reviewed actual fixture source\n')
  const appSource = json({ contract: 'livestore-application-source-v1', files: [ref(appFile)] })
  const artifactFor = (platform) => ({
    id: platform,
    platform,
    sdkSourceSeal: seal,
    payloadSha256: payload,
    files: [ref(appFile)],
    source: appSource,
    sourceTreeSha256: digest([ref(appFile)]),
  })
  const app = {
    strategy: 'fresh-preserve-old',
    strategyEvidence: json({ decision: 'synthetic approved strategy' }),
    artifacts: [artifactFor('web'), artifactFor('ios')],
    cases: requiredCases('fresh-preserve-old').map((id) => ({
      id,
      status: 'pass',
      evidence: [gateLog],
      artifacts: [id.includes('ios') === true ? 'ios' : 'web'],
    })),
    limits: ['Fixture only; never real app acceptance'],
  }
  app.review = json({ contract: 'livestore-fork-application-v1', bindingSha256: digest(app) })
  const manifest = {
    contract: 'livestore-fork-commit-evidence-v1',
    authority: { proposalSha256: proposalSha, review: undefined },
    source: {
      base,
      tree: state.tree,
      changed: state.changed,
      excluded: state.tree.filter((row) => fullSetupInput(row.path)),
      shared: [],
      external: { root: 'repos/effect-utils', base: pin, tree: external.tree },
      builds,
    },
    tools: {
      specSha256: hash(fs.readFileSync(path.join(root, 'scripts/fork-qualification/tool-profile.json'))),
      inputs: toolInputs(tools),
    },
    artifact: {
      root: candidate,
      sourceInventory,
      payloadInventory,
      compatibility: json({
        contract: 'livestore-fork-candidate-compatibility-v1',
        sourceSnapshotSha256: digest(snapshotFiles),
        currentSourceTreeSha256: digest(state.tree),
        changes: [],
      }),
    },
    consumer: {
      entries: [{ root: consumer, includeDev: false }],
      inputs: [ref(path.join(consumer, 'package.json')), ref(path.join(consumer, 'lock.json'))],
      cohort,
    },
    application: app,
  }
  const rebind = () => {
    const { review, ...body } = manifest.application
    manifest.application.review = json({ contract: 'livestore-fork-application-v1', bindingSha256: digest(body) })
    manifest.authority.review = json({
      contract: 'livestore-fork-scope-v1',
      decisionSha256: decisionSha,
      bindingSha256: scopeBinding(manifest),
    })
    write(path.join(home, 'manifest.json'), manifest)
  }
  rebind()
  return {
    home,
    root,
    tools,
    manifest,
    artifact,
    consumer,
    ref,
    json,
    rebind,
    gateLog,
    local: localFor(root),
    evidenceFile: path.join(home, 'manifest.json'),
    git: (args) => fixtureGit(root, args),
    cleanup: () => fs.rmSync(home, { recursive: true, force: true }),
    context: () => ({
      root,
      tools,
      evidenceDirectory: home,
      references: new Map(),
      issues: [],
      artifact,
      sdkSourceSeal: seal,
    }),
  }
}
