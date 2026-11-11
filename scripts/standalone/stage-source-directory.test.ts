import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { Schema } from '@livestore/utils/effect'

import {
  consumerGraph,
  digest,
  hash,
  packPayload,
  sourceState,
  toolInputs,
  sdkIdentity,
  sourceCompatibility,
} from '../fork-qualification/qualification-observations.mts'
import {
  REQUIRED_CRASH_CASES,
  requiredGates,
  producerChangePaths,
  sdkNames,
  supportPaths,
} from '../fork-qualification/qualification-recipe.mts'
import { expectedSkippedCases } from '../fork-qualification/qualification-runtime.mts'
import { assertQualificationSourceScope } from './qualification-source-contract.ts'
import {
  inspectQualification,
  producerPaths,
  stageQualification,
  type StageArguments,
} from './stage-source-directory.ts'

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const names = sdkNames
const changed = [
  'packages/@livestore/common/src/rematerialize-from-eventlog.ts',
  'packages/@livestore/adapter-cloudflare/src/hosted-replay-wasm.test.ts',
  'packages/@livestore/adapter-cloudflare/src/test-fixtures/hosted-replay.worker.ts',
  'tests/package-common/src/leader-thread/LeaderSyncProcessor.test.ts',
]

const workerPaths = [
  'packages/@livestore/adapter-web/src/single-tab/single-tab-adapter.ts',
  'packages/@livestore/adapter-web/src/single-tab/single-tab-handoff.test.ts',
  'packages/@livestore/adapter-web/src/web-worker/client-session/leader-election-handoff.test.ts',
  'packages/@livestore/adapter-web/src/web-worker/client-session/leader-election-lock.test.ts',
  'packages/@livestore/adapter-web/src/web-worker/client-session/worker-leadership.ts',
  'packages/@livestore/adapter-web/src/web-worker/common/physical-worker-lifetime.test.ts',
  'packages/@livestore/adapter-web/src/web-worker/common/physical-worker-lifetime.ts',
  'packages/@livestore/adapter-web/src/web-worker/common/worker-schema.ts',
  'packages/@livestore/adapter-web/src/web-worker/leader-worker/make-leader-worker.ts',
  'packages/@livestore/adapter-web/src/web-worker/leader-worker/worker-transport.test.ts',
]

const coordinatorPaths = [
  ...workerPaths,
  'packages/@livestore/adapter-web/src/web-worker/common/rpc-worker.ts',
  ...producerChangePaths,
  'scripts/fork-qualification/check.mjs',
  'scripts/standalone/tsconfig.json',
  'scripts/standalone/tsconfig.json.genie.ts',
  'packages/@livestore/adapter-web/src/index.ts',
  'packages/@livestore/adapter-web/src/single-tab/single-tab-adapter-options.ts',
  'packages/@livestore/adapter-web/src/web-worker/client-session/persisted-adapter-options.ts',
  'packages/@livestore/adapter-web/src/web-worker/client-session/persisted-adapter.ts',
  'packages/@livestore/adapter-web/src/web-worker/client-session/worker-shutdown.ts',
  'packages/@livestore/adapter-web/src/web-worker/shared-worker/leader-generations-rpc.test.ts',
  'packages/@livestore/adapter-web/src/web-worker/shared-worker/leader-generations.test.ts',
  'packages/@livestore/adapter-web/src/web-worker/shared-worker/leader-generations.ts',
  'packages/@livestore/adapter-web/src/web-worker/common/write-admission-errors.ts',
  'packages/@livestore/adapter-web/src/web-worker/shared-worker/make-shared-worker.ts',
  'packages/@livestore/adapter-web/src/web-worker/shared-worker/write-admission-wire.test.ts',
  'packages/@livestore/adapter-web/src/web-worker/shared-worker/write-admission.test.ts',
].sort()

// Synthetic receipts exercise the filesystem/receipt consumer, not SDK correctness.
// Selection still uses the real pinned pnpm command, and Git/source inspection is real.
const fixture = (absoluteLink = false, changedPaths = changed) => {
  const home = fs.mkdtempSync(path.join(repository, 'temp_nocommit/qualification-producer-test-'))
  try {
    const root = path.join(home, 'source')
    fs.mkdirSync(root)
    const write = (name: string, bytes: string | Uint8Array) => {
      const file = path.join(root, name)
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, bytes)
    }
    const git = (...args: string[]): string => {
      const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
      assert.equal(result.status, 0, result.stderr)
      return result.stdout.trim()
    }
    write('.gitignore', 'node_modules/\nrepos/\ntemp_nocommit/\n**/dist/\n')
    for (const name of supportPaths) write(name, '{}\n')
    write('package.json', '{"name":"producer-unit-fixture","private":true}\n')
    const toolsBytes = fs.readFileSync(path.join(repository, 'temp_nocommit/fork-qualification/tools.json'))
    write('temp_nocommit/fork-qualification/tools.json', toolsBytes)
    const tools = Schema.decodeUnknownSync(
      Schema.Struct({
        profile: Schema.String,
        commands: Schema.Record(Schema.String, Schema.Array(Schema.String)),
        environment: Schema.Record(Schema.String, Schema.String),
      }),
    )(JSON.parse(toolsBytes.toString()))
    for (const name of producerPaths) write(name, fs.readFileSync(path.join(repository, name)))
    for (const name of names) {
      write(
        `packages/${name}/package.json`,
        JSON.stringify({ name, version: '0.0.0', type: 'module', files: ['src', 'dist'] }),
      )
      write(`packages/${name}/src/index.ts`, 'export const fixture = 1\n')
      write(`packages/${name}/dist/index.js`, 'export const fixture = 1\n')
    }
    for (const name of changedPaths) write(name, 'export const fixture = 0\n')
    fs.symlinkSync(
      absoluteLink === true
        ? path.join(root, 'packages/@livestore/common/src/index.ts')
        : 'packages/@livestore/common/src/index.ts',
      path.join(root, 'source-link.ts'),
    )
    git('init', '--quiet')
    git('add', '.')
    git(
      '-c',
      'user.name=Qualification fixture',
      '-c',
      'user.email=fixture@localhost',
      'commit',
      '--quiet',
      '-m',
      'synthetic source base',
    )
    const base = git('rev-parse', 'HEAD')
    const before = sourceState(root, base)
    const baseSnapshot = before.tree.map((row) => ({
      path: row.path,
      kind: row.kind,
      mode: fs.lstatSync(path.join(root, row.path)).mode & 0o777,
      sha256: hash(fs.readFileSync(path.join(root, row.path))),
      ...(row.kind === 'symlink' ? { target: fs.readlinkSync(path.join(root, row.path)) } : {}),
    }))
    for (const name of changedPaths) {
      const bytes =
        producerPaths.includes(name) === true
          ? fs.readFileSync(path.join(repository, name))
          : 'export const fixture = 1\n'
      write(name, bytes)
    }
    const patch = path.join(home, 'source.patch')
    fs.writeFileSync(patch, git('diff', '--', ...changedPaths) + '\n')
    fs.mkdirSync(path.join(root, 'repos'))
    fs.symlinkSync(path.join(repository, 'repos/effect-utils'), path.join(root, 'repos/effect-utils'))
    const generatorBase = spawnSync('git', ['rev-parse', 'HEAD'], {
      cwd: path.join(root, 'repos/effect-utils'),
      encoding: 'utf8',
    })
    assert.equal(generatorBase.status, 0)
    const externalBase = generatorBase.stdout.trim()
    const state = sourceState(root, base)
    const external = sourceState(path.join(root, 'repos/effect-utils'), externalBase)
    assert.deepEqual(external.changed, [])
    const reference = (file: string) => ({ path: file, sha256: hash(fs.readFileSync(file)) })
    let serial = 0
    const json = (value: unknown) => {
      const file = path.join(home, `receipt-${serial++}.json`)
      fs.writeFileSync(file, JSON.stringify(value))
      return reference(file)
    }
    const log = path.join(home, 'synthetic.log')
    fs.writeFileSync(log, 'SYNTHETIC UNIT RECEIPT: does not qualify any SDK build\n')
    const step = { exitCode: 0, joined: true, log: reference(log) }
    const seal = digest(sdkIdentity(root, state.tree))
    const packages = names.map((name) => {
      const files = packPayload(path.join(root, 'packages', name), path.join(tools.profile, 'node_modules/.bin/pnpm'))
      return { name, files, sha256: hash(JSON.stringify(files)) }
    })
    const payload = {
      contract: 'livestore-qualified-package-payload-v1',
      sourceSeal: seal,
      files: packages.reduce((count, item) => count + item.files.length, 0),
      packages,
      directoryIdentity: hash(JSON.stringify(packages.map(({ name, sha256 }) => ({ name, sha256 })))),
    }
    const local = {
      contract: 'livestore-fork-local-qualification-v1',
      root,
      base,
      sourceTreeSha256: digest(state.tree),
      externalTreeSha256: digest(external.tree),
      sdkSourceSeal: seal,
      toolInputsSha256: digest(toolInputs(tools)),
      gates: requiredGates.map((name) => ({ name, ...step })),
      runtime: {
        passed: 904,
        failed: 0,
        skipped: 3,
        files: 96,
        skippedCases: expectedSkippedCases,
        crashCases: REQUIRED_CRASH_CASES.map((name) => ({
          name,
          status: 'passed',
          executed: true,
        })),
      },
    }
    const graph = consumerGraph(names.map((name) => ({ root: path.join(root, 'packages', name), includeDev: false })))
    const buildData = {
      contract: 'livestore-fork-clean-build-v1',
      bootstrap: step,
      install: { ...step, frozen: true, strictPeers: true },
      local: json(local),
      payload: json(payload),
      closureSha256: digest([...graph.values()]),
    }
    const build = json(buildData)
    const binding = {
      contract: 'livestore-fork-qualification-source-v1',
      base,
      tree: state.tree,
      changed: state.changed,
      patch: reference(patch),
      tools: reference(path.join(root, 'temp_nocommit/fork-qualification/tools.json')),
      build,
      external: { root: 'repos/effect-utils', base: externalBase, tree: external.tree },
      baseInventory: json({ snapshotFiles: baseSnapshot }),
      baseChanges: sourceCompatibility(root, state.tree, baseSnapshot),
      producerInputs: producerPaths.map((name) => ({
        path: name,
        sha256: hash(fs.readFileSync(path.join(root, name))),
      })),
      producerChecks: ['producer-typecheck', 'tests', 'source-format', 'type-aware-lint'].map((name) => ({
        name,
        ...step,
      })),
    }
    const review = json({ contract: 'livestore-fork-qualification-source-review-v1', bindingSha256: digest(binding) })
    let manifest = json({ ...binding, review })
    const args: StageArguments = {
      sourceRoot: root,
      sourceBase: base,
      sourcePatch: patch,
      sourceSnapshot: manifest.path,
      buildReceipt: build.path,
      output: path.join(home, seal),
      receipt: path.join(home, 'qualification.json'),
    }
    const rebindBuild = () => {
      binding.build = json(buildData)
      const freshReview = json({
        contract: 'livestore-fork-qualification-source-review-v1',
        bindingSha256: digest(binding),
      })
      manifest = json({ ...binding, review: freshReview })
      args.sourceSnapshot = manifest.path
      args.buildReceipt = binding.build.path
    }
    return {
      home,
      root,
      args,
      manifest,
      binding,
      patch,
      write,
      local,
      payload,
      buildData,
      json,
      rebindBuild,
      dispose: () => fs.rmSync(home, { recursive: true }),
    }
  } catch (error) {
    fs.rmSync(home, { recursive: true })
    throw error
  }
}

test('freezes normal-selected bytes and relocated source links, without claiming commit eligibility', () => {
  const f = fixture()
  try {
    const result = stageQualification(f.args)
    assert.equal(result.qualificationOnly, true)
    assert.equal(result.commitEligible, false)
    assert.equal(result.independentReproduction, false)
    assert.equal(fs.readlinkSync(path.join(f.args.output, 'source-link.ts')), 'packages/@livestore/common/src/index.ts')
    assert.equal(
      fs.readFileSync(path.join(f.args.output, 'packages/@livestore/common/dist/index.js'), 'utf8'),
      'export const fixture = 1\n',
    )
    assert.equal(fs.existsSync(path.join(f.args.output, 'node_modules')), false)
    assert.throws(() => stageQualification(f.args), /Never replace/)
  } finally {
    f.dispose()
  }
})

test('accepts only the exact regular worker source set', () => {
  const file = (path: string) => ({ path, kind: 'file' as const, sha256: hash(path), executable: false })
  const paths = workerPaths.map(file)
  const first = paths[0]!
  const rest = paths.slice(1)
  const scopeError = /exactly the reviewed worker source paths/
  assert.throws(() => assertQualificationSourceScope(rest), scopeError)
  for (const extra of [
    'docs/extra.ts',
    changed[0]!,
    producerPaths[0]!,
    'tests/sync-provider/src/sync-provider.test.ts',
  ]) {
    assert.throws(() => assertQualificationSourceScope([...paths, file(extra)]), scopeError)
  }
  assert.throws(
    () => assertQualificationSourceScope([{ path: first.path, kind: 'missing' }, ...rest]),
    /must remain regular files/,
  )
  assert.throws(
    () => assertQualificationSourceScope([{ ...first, kind: 'symlink', target: 'index.ts' }, ...rest]),
    /must remain regular files/,
  )
})

test('admits the coordinator successor only as its full regular-file set', () => {
  const file = (path: string) => ({ path, kind: 'file' as const, sha256: hash(path), executable: false })
  const paths = coordinatorPaths.map(file)
  assert.equal(paths.length, 39)
  assert.doesNotThrow(() => assertQualificationSourceScope(paths))
  const [first, ...rest] = paths
  assert.ok(first)
  for (const rows of [
    rest,
    paths.filter(({ path }) => !path.endsWith('/rpc-worker.ts') && !path.endsWith('/worker-schema.ts')),
    paths.filter(({ path }) => !path.includes('/write-admission')),
    [...rest, rest[0]!],
    [...paths, file('docs/extra.ts')],
    [...paths, file(workerPaths.find((name) => name.endsWith('/worker-schema.ts'))!)],
    [...paths, file(changed[0]!)],
  ]) {
    assert.throws(() => assertQualificationSourceScope(rows), /exactly the reviewed worker source paths/)
  }
  assert.throws(
    () => assertQualificationSourceScope([{ path: first.path, kind: 'missing' }, ...rest]),
    /must remain regular files/,
  )
  assert.throws(
    () => assertQualificationSourceScope([{ ...first, kind: 'symlink', target: 'index.ts' }, ...rest]),
    /must remain regular files/,
  )
})

test('binds the exact coordinator successor to a real Git source and its independent review', () => {
  const f = fixture(false, coordinatorPaths)
  try {
    assert.deepEqual(
      inspectQualification(f.args).state.changed.map((row) => row.path),
      coordinatorPaths,
    )
    const review = f.json({
      contract: 'livestore-fork-qualification-source-review-v1',
      bindingSha256: digest({}),
    })
    const stale = f.json({ ...f.binding, review })
    assert.throws(() => inspectQualification({ ...f.args, sourceSnapshot: stale.path }), /Root-reviewed/)
    const unexpectedFixture = {
      ...f.binding,
      fixtures: { review, inputs: [] },
    }
    const manifest = f.json({ ...unexpectedFixture, review })
    assert.throws(
      () => inspectQualification({ ...f.args, sourceSnapshot: manifest.path }),
      /Fixture review does not match source changes/,
    )
    assert.equal(fs.existsSync(f.args.output), false)
  } finally {
    f.dispose()
  }
})

test('requires an independently bound manifest for the exact worker source set', () => {
  const f = fixture(false, workerPaths)
  try {
    assert.deepEqual(
      inspectQualification(f.args).state.changed.map((row) => row.path),
      workerPaths,
    )
    const review = f.json({
      contract: 'livestore-fork-qualification-source-review-v1',
      bindingSha256: digest({}),
    })
    const stale = f.json({ ...f.binding, review })
    assert.throws(() => inspectQualification({ ...f.args, sourceSnapshot: stale.path }), /Root-reviewed/)
    const oldBinding = {
      ...f.binding,
      producerChecks: f.binding.producerChecks.map((step) =>
        step.name === 'producer-typecheck' ? { ...step, name: 'typecheck' } : step,
      ),
    }
    const oldReview = f.json({
      contract: 'livestore-fork-qualification-source-review-v1',
      bindingSha256: digest(oldBinding),
    })
    const oldManifest = f.json({ ...oldBinding, review: oldReview })
    assert.throws(
      () => inspectQualification({ ...f.args, sourceSnapshot: oldManifest.path }),
      /Missing checked producer gates/,
    )
    assert.equal(fs.existsSync(f.args.output), false)
  } finally {
    f.dispose()
  }
})

test('rejects changed source, source patch, producer recipe and stale emitted bytes before creating output', () => {
  const f = fixture()
  try {
    const source = 'packages/@livestore/common/src/rematerialize-from-eventlog.ts'
    f.write(source, 'export const fixture = 2\n')
    assert.throws(() => inspectQualification(f.args))
    f.write(source, 'export const fixture = 1\n')
    const original = fs.readFileSync(f.patch)
    fs.appendFileSync(f.patch, 'changed patch')
    assert.throws(() => inspectQualification(f.args), /Evidence changed/)
    fs.writeFileSync(f.patch, original)
    const producer = producerPaths[0]
    assert(producer !== undefined)
    const saved = fs.readFileSync(path.join(f.root, producer))
    f.write(producer, 'changed producer\n')
    assert.throws(() => inspectQualification(f.args), /Frozen authored/)
    f.write(producer, saved)
    const descriptor = path.join(f.root, 'temp_nocommit/fork-qualification/tools.json')
    const descriptorBytes = fs.readFileSync(descriptor)
    fs.appendFileSync(descriptor, '\n')
    assert.throws(() => inspectQualification(f.args), /Evidence changed/)
    fs.writeFileSync(descriptor, descriptorBytes)
    f.write('packages/@livestore/common/dist/index.js', 'stale or tampered output\n')
    assert.throws(() => stageQualification(f.args), /Normal-produced payload changed/)
    assert.equal(fs.existsSync(f.args.output), false)
    assert.equal(fs.existsSync(f.args.receipt), false)
  } finally {
    f.dispose()
  }
})

test('rejects aliased output paths into the source context and never replaces existing evidence', () => {
  const f = fixture()
  try {
    const alias = path.join(f.home, 'source-alias')
    fs.symlinkSync(f.root, alias)
    assert.throws(
      () => stageQualification({ ...f.args, output: path.join(alias, path.basename(f.args.output)) }),
      /outside source/,
    )
    fs.writeFileSync(f.args.receipt, 'previous evidence')
    assert.throws(() => stageQualification(f.args), /Never replace evidence/)
    assert.equal(fs.readFileSync(f.args.receipt, 'utf8'), 'previous evidence')
  } finally {
    f.dispose()
  }
})

test('fresh review cannot waive strict installation, normal gates, cohort or closure', () => {
  const f = fixture()
  try {
    f.buildData.install.strictPeers = false
    f.rebindBuild()
    assert.throws(() => inspectQualification(f.args))
    f.buildData.install.strictPeers = true
    const gate = f.local.gates.pop()
    assert(gate !== undefined)
    f.buildData.local = f.json(f.local)
    f.rebindBuild()
    assert.throws(() => inspectQualification(f.args), /Missing normal build gate/)
    f.local.gates.push(gate)
    f.buildData.local = f.json(f.local)
    f.payload.packages.reverse()
    f.buildData.payload = f.json(f.payload)
    f.rebindBuild()
    assert.throws(() => inspectQualification(f.args), /Changed SDK cohort/)
    f.payload.packages.reverse()
    f.buildData.payload = f.json(f.payload)
    f.buildData.closureSha256 = '0'.repeat(64)
    f.rebindBuild()
    assert.throws(() => inspectQualification(f.args), /Normal-installed closure changed/)
    assert.equal(fs.existsSync(f.args.output), false)
  } finally {
    f.dispose()
  }
})

test('rejects source-local absolute links before copying into an immutable output', () => {
  const f = fixture(true)
  try {
    assert.throws(() => stageQualification(f.args), /Qualification links must be relocatable/)
    assert.equal(fs.existsSync(f.args.output), false)
  } finally {
    f.dispose()
  }
})

test('removes its incomplete output and receipt when publication would mutate authored source', () => {
  const f = fixture()
  try {
    const receipt = path.join(f.root, 'unignored-receipt.json')
    assert.throws(() => stageQualification({ ...f.args, receipt }), /Receipt must not change authored source/)
    assert.equal(fs.existsSync(receipt), false)
    assert.equal(fs.existsSync(f.args.output), false)
  } finally {
    f.dispose()
  }
})

test('uncertain receipt close preserves the original error and owned artifacts', () => {
  const f = fixture()
  const closeFailure = new Error('controlled receipt close failure')
  let retainedDescriptor: number | undefined
  try {
    assert.throws(
      () =>
        stageQualification(f.args, {
          openSync: fs.openSync,
          writeFileSync: fs.writeFileSync,
          closeSync: (descriptor) => {
            retainedDescriptor = descriptor
            throw closeFailure
          },
        }),
      (error: unknown) => {
        assert(error instanceof AggregateError)
        assert.equal(error.cause, closeFailure)
        assert.deepEqual(error.errors, [closeFailure])
        assert.match(error.message, /retained output=/)
        return true
      },
    )
    assert.equal(fs.existsSync(f.args.output), true)
    assert.equal(fs.existsSync(f.args.receipt), true)
  } finally {
    // This controlled close threw before touching the FD; the test still owns it.
    if (retainedDescriptor !== undefined) fs.closeSync(retainedDescriptor)
    f.dispose()
  }
})
