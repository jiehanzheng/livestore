import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { Schema } from '@livestore/utils/effect'

import {
  consumerGraph,
  digest,
  hash,
  relative,
  packPayload,
  sourceState,
  type SourceChange,
  toolInputs,
  sourceCompatibility,
  sdkIdentity,
} from '../fork-qualification/qualification-observations.mts'
import {
  declaredCommands,
  requiredGates,
  sdkNames,
  recipePaths,
  producerChangePaths,
  qualificationFixturePaths,
} from '../fork-qualification/qualification-recipe.mts'
import { assertRuntimeSummary } from '../fork-qualification/qualification-runtime.mts'

const Ref = Schema.Struct({ path: Schema.String, sha256: Schema.String })
const SourceRow = Schema.Struct({
  path: Schema.String,
  kind: Schema.Literals(['file', 'symlink', 'missing']),
  executable: Schema.optional(Schema.Boolean),
  sha256: Schema.optional(Schema.String),
  target: Schema.optional(Schema.String),
})
const PayloadFile = Schema.Struct({ path: Schema.String, mode: Schema.Int, bytes: Schema.Int, sha256: Schema.String })
const Payload = Schema.Struct({
  contract: Schema.Literal('livestore-qualified-package-payload-v1'),
  sourceSeal: Schema.String,
  files: Schema.Int,
  directoryIdentity: Schema.String,
  packages: Schema.Array(
    Schema.Struct({ name: Schema.String, sha256: Schema.String, files: Schema.Array(PayloadFile) }),
  ),
})
const Step = Schema.Struct({ exitCode: Schema.Literal(0), joined: Schema.Literal(true), log: Ref })
const Tools = Schema.Struct({
  profile: Schema.String,
  specSha256: Schema.String,
  commands: Schema.Record(Schema.String, Schema.Array(Schema.String)),
  environment: Schema.Record(Schema.String, Schema.String),
})
const Runtime = Schema.Struct({
  passed: Schema.Int,
  failed: Schema.Literal(0),
  skipped: Schema.Literal(3),
  files: Schema.Int,
  skippedCases: Schema.Array(Schema.String),
  crashCases: Schema.Array(
    Schema.Struct({ name: Schema.String, status: Schema.Literal('passed'), executed: Schema.Literal(true) }),
  ),
})
const Local = Schema.Struct({
  contract: Schema.Literal('livestore-fork-local-qualification-v1'),
  root: Schema.String,
  base: Schema.String,
  sourceTreeSha256: Schema.String,
  externalTreeSha256: Schema.String,
  sdkSourceSeal: Schema.String,
  toolInputsSha256: Schema.String,
  gates: Schema.Array(Schema.Struct({ name: Schema.String, ...Step.fields })),
  runtime: Runtime,
})
const Build = Schema.Struct({
  contract: Schema.Literal('livestore-fork-clean-build-v1'),
  bootstrap: Step,
  install: Schema.Struct({ ...Step.fields, frozen: Schema.Literal(true), strictPeers: Schema.Literal(true) }),
  local: Ref,
  payload: Ref,
  closureSha256: Schema.String,
})
const Snapshot = Schema.Union([
  Schema.Struct({ path: Schema.String, kind: Schema.Literal('file'), mode: Schema.Int, sha256: Schema.String }),
  Schema.Struct({
    path: Schema.String,
    kind: Schema.Literal('symlink'),
    mode: Schema.Int,
    sha256: Schema.String,
    target: Schema.String,
  }),
])
const Descriptor = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('file'), executable: Schema.Boolean, sha256: Schema.String }),
  Schema.Struct({
    kind: Schema.Literal('symlink'),
    executable: Schema.Boolean,
    sha256: Schema.String,
    target: Schema.String,
  }),
])
const Delta = Schema.Struct({
  path: Schema.String,
  old: Schema.Union([Schema.Null, Descriptor]),
  current: Schema.Union([Schema.Null, Descriptor]),
})
const rawRecord = (value: unknown): Record<string, unknown> => {
  assert(value !== null && typeof value === 'object' && Array.isArray(value) === false, 'Missing receipt object')
  return Object.fromEntries(Object.entries(value))
}
const checkDelta = (value: unknown) => {
  const row = Schema.decodeUnknownSync(Delta, { onExcessProperty: 'error' })(value)
  relative(row.path)
  for (const descriptor of [row.old, row.current])
    if (descriptor !== null) assert.match(descriptor.sha256, /^[a-f0-9]{64}$/)
  return row
}
const readSnapshot = (bytes: Uint8Array) => {
  const rows = rawRecord(JSON.parse(Buffer.from(bytes).toString('utf8'))).snapshotFiles
  assert(Array.isArray(rows), 'Missing accepted source snapshot')
  return rows.map((value: unknown) => {
    const row = Schema.decodeUnknownSync(Snapshot, { onExcessProperty: 'error' })(value)
    relative(row.path)
    assert(row.mode >= 0 && row.mode <= 0o777, 'Invalid accepted source mode')
    assert.match(row.sha256, /^[a-f0-9]{64}$/)
    return row
  })
}
const Manifest = Schema.Struct({
  contract: Schema.Literal('livestore-fork-qualification-source-v1'),
  base: Schema.String,
  tree: Schema.Array(SourceRow),
  changed: Schema.Array(SourceRow),
  patch: Ref,
  build: Ref,
  review: Ref,
  tools: Ref,
  fixtures: Schema.optional(
    Schema.Struct({
      review: Ref,
      inputs: Schema.Array(Schema.Struct({ path: Schema.String, sha256: Schema.String })),
    }),
  ),
  external: Schema.Struct({
    root: Schema.Literal('repos/effect-utils'),
    base: Schema.String,
    tree: Schema.Array(SourceRow),
  }),
  baseInventory: Ref,
  baseChanges: Schema.Array(Delta),
  producerInputs: Schema.Array(Schema.Struct({ path: Schema.String, sha256: Schema.String })),
  producerChecks: Schema.Array(Schema.Struct({ name: Schema.String, ...Step.fields })),
})
const Review = Schema.Struct({
  contract: Schema.Literal('livestore-fork-qualification-source-review-v1'),
  bindingSha256: Schema.String,
})
const Profile = Schema.Struct({
  pnpm: Schema.String,
  effectUtilsRevision: Schema.String,
  packages: Schema.Struct({ typescript: Schema.String }),
})
const replayChanges = [
  'packages/@livestore/common/src/rematerialize-from-eventlog.ts',
  'packages/@livestore/adapter-cloudflare/src/hosted-replay-wasm.test.ts',
  'packages/@livestore/adapter-cloudflare/src/test-fixtures/hosted-replay.worker.ts',
  'tests/package-common/src/leader-thread/LeaderSyncProcessor.test.ts',
]
export const producerPaths = [
  'scripts/standalone/stage-source-directory.ts',
  'scripts/standalone/qualification-source-contract.ts',
  'scripts/standalone/stage-source-directory.test.ts',
  'scripts/standalone/tsconfig.json.genie.ts',
  'scripts/standalone/tsconfig.json',
  ...recipePaths,
]
const replayAllowed = new Set([...replayChanges, ...producerChangePaths, ...qualificationFixturePaths])
const workerChanges = new Set(
  [
    'single-tab/single-tab-adapter.ts',
    'single-tab/single-tab-handoff.test.ts',
    'web-worker/client-session/leader-election-handoff.test.ts',
    'web-worker/client-session/leader-election-lock.test.ts',
    'web-worker/client-session/worker-leadership.ts',
    'web-worker/common/physical-worker-lifetime.test.ts',
    'web-worker/common/physical-worker-lifetime.ts',
    'web-worker/common/worker-schema.ts',
    'web-worker/leader-worker/make-leader-worker.ts',
    'web-worker/leader-worker/worker-transport.test.ts',
  ].map((name) => `packages/@livestore/adapter-web/src/${name}`),
)

// This reviewed successor has a fixed source delta from f126. The earlier
// worker and replay scopes must keep their existing boundaries.
const coordinatorChanges = new Set([
  'packages/@livestore/adapter-web/src/index.ts',
  'packages/@livestore/adapter-web/src/single-tab/single-tab-adapter-options.ts',
  'packages/@livestore/adapter-web/src/single-tab/single-tab-adapter.ts',
  'packages/@livestore/adapter-web/src/single-tab/single-tab-handoff.test.ts',
  'packages/@livestore/adapter-web/src/web-worker/client-session/leader-election-handoff.test.ts',
  'packages/@livestore/adapter-web/src/web-worker/client-session/leader-election-lock.test.ts',
  'packages/@livestore/adapter-web/src/web-worker/client-session/persisted-adapter-options.ts',
  'packages/@livestore/adapter-web/src/web-worker/client-session/persisted-adapter.ts',
  'packages/@livestore/adapter-web/src/web-worker/client-session/worker-leadership.ts',
  'packages/@livestore/adapter-web/src/web-worker/client-session/worker-shutdown.ts',
  'packages/@livestore/adapter-web/src/web-worker/common/physical-worker-lifetime.test.ts',
  'packages/@livestore/adapter-web/src/web-worker/common/physical-worker-lifetime.ts',
  'packages/@livestore/adapter-web/src/web-worker/common/rpc-worker.ts',
  'packages/@livestore/adapter-web/src/web-worker/common/worker-schema.ts',
  'packages/@livestore/adapter-web/src/web-worker/common/write-admission-errors.ts',
  'packages/@livestore/adapter-web/src/web-worker/leader-worker/make-leader-worker.ts',
  'packages/@livestore/adapter-web/src/web-worker/leader-worker/worker-transport.test.ts',
  'packages/@livestore/adapter-web/src/web-worker/shared-worker/leader-generations-rpc.test.ts',
  'packages/@livestore/adapter-web/src/web-worker/shared-worker/leader-generations.test.ts',
  'packages/@livestore/adapter-web/src/web-worker/shared-worker/leader-generations.ts',
  'packages/@livestore/adapter-web/src/web-worker/shared-worker/make-shared-worker.ts',
  'packages/@livestore/adapter-web/src/web-worker/shared-worker/write-admission-wire.test.ts',
  'packages/@livestore/adapter-web/src/web-worker/shared-worker/write-admission.test.ts',
  'scripts/fork-qualification/README.md',
  'scripts/fork-qualification/bootstrap.test.mjs',
  'scripts/fork-qualification/check.mjs',
  'scripts/fork-qualification/commit-consumer.mjs',
  'scripts/fork-qualification/commit-files.mjs',
  'scripts/fork-qualification/commit-source.mjs',
  'scripts/fork-qualification/qualification-observations.mts',
  'scripts/fork-qualification/qualification-policy.mjs',
  'scripts/fork-qualification/qualification-recipe.mts',
  'scripts/fork-qualification/qualification-runtime.mjs',
  'scripts/fork-qualification/qualification-runtime.mts',
  'scripts/standalone/qualification-source-contract.ts',
  'scripts/standalone/stage-source-directory.test.ts',
  'scripts/standalone/stage-source-directory.ts',
  'scripts/standalone/tsconfig.json',
  'scripts/standalone/tsconfig.json.genie.ts',
])

export const assertQualificationSourceScope = (changed: readonly SourceChange[]) => {
  const paths = new Set(changed.map((row) => row.path))
  if (changed.length === coordinatorChanges.size && [...coordinatorChanges].every((name) => paths.has(name)) === true) {
    assert(
      changed.every((row) => row.kind === 'file'),
      'Coordinator qualification paths must remain regular files',
    )
    return
  }
  if (changed.some((row) => workerChanges.has(row.path)) === true) {
    // The worker patch is assembled on a tracked producer recipe, with no unrelated changes.
    assert(
      changed.length === workerChanges.size && [...workerChanges].every((name) => paths.has(name)),
      'Worker qualification requires exactly the reviewed worker source paths',
    )
    assert(
      changed.every((row) => row.kind === 'file'),
      'Worker qualification paths must remain regular files',
    )
    return
  }
  assert(
    changed.every((row) => replayAllowed.has(row.path)),
    'Undeclared source scope',
  )
  assert(
    replayChanges.every((name) => paths.has(name)),
    'Missing reviewed SDK change',
  )
}
const decode = <A>(schema: Schema.Codec<A>, bytes: Uint8Array): A =>
  Schema.decodeUnknownSync(schema)(JSON.parse(Buffer.from(bytes).toString('utf8')))
export const same = (actual: unknown, expected: unknown, message: string) =>
  assert.equal(digest(actual), digest(expected), message)

export interface StageArguments {
  sourceRoot: string
  sourceBase: string
  sourceSnapshot: string
  sourcePatch: string
  buildReceipt: string
  output: string
  receipt: string
}

/** This owner validates existing facts; no receipt may supply a command to execute. */
export const inspectQualification = (args: StageArguments) => {
  const root = fs.realpathSync(args.sourceRoot)
  const manifestFile = fs.realpathSync(args.sourceSnapshot)
  const evidence = path.dirname(manifestFile)
  const manifestBytes = fs.readFileSync(manifestFile)
  const rawManifest: unknown = JSON.parse(manifestBytes.toString('utf8'))
  const rawChanges = rawRecord(rawManifest).baseChanges
  assert(Array.isArray(rawChanges), 'Missing accepted-base deltas')
  rawChanges.forEach(checkDelta)
  const manifest = Schema.decodeUnknownSync(Manifest)(rawManifest)
  const references = new Map<string, string>([[manifestFile, hash(manifestBytes)]])
  const read = (directory: string, ref: typeof Ref.Type): Buffer => {
    assert.match(ref.sha256, /^[a-f0-9]{64}$/)
    const file = path.resolve(directory, ref.path)
    assert.equal(fs.lstatSync(file).isFile(), true, 'Evidence must be a regular file, not a link')
    const bytes = fs.readFileSync(file)
    assert.equal(hash(bytes), ref.sha256, `Evidence changed: ${file}`)
    references.set(fs.realpathSync(file), ref.sha256)
    return bytes
  }
  assert.match(args.sourceBase, /^[a-f0-9]{40}$/)
  assert.equal(manifest.base, args.sourceBase)
  const patch = read(evidence, manifest.patch)
  same(hash(fs.readFileSync(args.sourcePatch)), hash(patch), 'Source patch argument differs')
  const reverse = spawnSync('git', ['apply', '--reverse', '--check', '--', fs.realpathSync(args.sourcePatch)], {
    cwd: root,
    encoding: 'utf8',
  })
  assert.equal(reverse.status, 0, 'Reviewed source patch is not applied to this context')
  const state = sourceState(root, args.sourceBase)
  same(state.tree, manifest.tree, 'Frozen authored source differs')
  same(state.changed, manifest.changed, 'Frozen changed source differs')
  assertQualificationSourceScope(state.changed)
  const fixtureChanges = state.changed.filter((row) => qualificationFixturePaths.includes(row.path))
  if (fixtureChanges.length > 0) {
    assert(manifest.fixtures !== undefined, 'Missing distinct fixture review')
    same(
      fixtureChanges.map((row) => row.path).sort(),
      [...qualificationFixturePaths].sort(),
      'Incomplete fixture correction scope',
    )
    const inputs = fixtureChanges.map((row) => {
      assert(row.kind === 'file', 'Fixture correction must retain source file')
      return { path: row.path, sha256: row.sha256 }
    })
    same(manifest.fixtures.inputs, inputs, 'Reviewed fixture bytes differ')
    read(evidence, manifest.fixtures.review)
  } else assert.equal(manifest.fixtures, undefined, 'Fixture review does not match source changes')
  const producerRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
  same(
    manifest.producerInputs.map((row) => row.path),
    producerPaths,
    'Incomplete producer recipe',
  )
  for (const row of manifest.producerInputs) {
    const file = path.join(producerRoot, row.path)
    assert.equal(fs.lstatSync(file).isFile(), true, 'Running recipe must be regular source')
    assert.equal(hash(fs.readFileSync(file)), row.sha256, 'Running producer recipe differs')
    references.set(fs.realpathSync(file), row.sha256)
    assert.equal(hash(fs.readFileSync(path.join(root, row.path))), row.sha256, 'Producer omitted from frozen source')
  }
  same(
    manifest.producerChecks.map((row) => row.name),
    ['producer-typecheck', 'tests', 'source-format', 'type-aware-lint'],
    'Missing checked producer gates',
  )
  for (const step of manifest.producerChecks) read(evidence, step.log)
  const base = readSnapshot(read(evidence, manifest.baseInventory))
  same(sourceCompatibility(root, state.tree, base), manifest.baseChanges, 'Accepted-base provenance differs')
  const review = decode(Review, read(evidence, manifest.review))
  const { review: _review, ...binding } = manifest
  assert.equal(review.bindingSha256, digest(binding), 'Root-reviewed source/recipe/build binding differs')
  const toolsFile = path.join(root, 'temp_nocommit/fork-qualification/tools.json')
  assert.equal(
    fs.realpathSync(path.resolve(evidence, manifest.tools.path)),
    fs.realpathSync(toolsFile),
    'Tools reference is not the actual descriptor',
  )
  const tools = decode(Tools, read(evidence, manifest.tools))
  const profileFile = path.join(root, 'scripts/fork-qualification/tool-profile.json')
  const profile = decode(Profile, fs.readFileSync(profileFile))
  assert.equal(tools.specSha256, hash(fs.readFileSync(profileFile)))
  same(tools.commands, declaredCommands(tools.profile, profile.packages.typescript), 'Unrecognized tool commands')
  assert.equal(manifest.external.base, profile.effectUtilsRevision)
  const externalRoot = path.join(root, manifest.external.root)
  const external = sourceState(externalRoot, manifest.external.base)
  same(external.changed, [], 'Pinned generator source is dirty')
  same(external.tree, manifest.external.tree, 'Pinned generator source differs')
  const buildBytes = read(evidence, manifest.build)
  assert.equal(hash(fs.readFileSync(args.buildReceipt)), hash(buildBytes), 'Build argument differs')
  const buildDirectory = path.dirname(path.resolve(evidence, manifest.build.path))
  const build = decode(Build, buildBytes)
  read(buildDirectory, build.bootstrap.log)
  read(buildDirectory, build.install.log)
  const local = decode(Local, read(buildDirectory, build.local))
  assert.equal(fs.realpathSync(local.root), root, 'Build belongs to another context')
  assert.equal(local.base, manifest.base)
  assert.equal(local.sourceTreeSha256, digest(state.tree))
  assert.equal(local.externalTreeSha256, digest(external.tree))
  assert.equal(local.toolInputsSha256, digest(toolInputs(tools)))
  same(
    local.gates.map((row) => row.name),
    requiredGates,
    'Missing normal build gate',
  )
  for (const gate of local.gates) read(path.dirname(path.resolve(buildDirectory, build.local.path)), gate.log)
  assertRuntimeSummary(local.runtime)
  const identity = sdkIdentity(root, state.tree)
  const seal: string = digest(identity)
  assert.equal(local.sdkSourceSeal, seal)
  const payload = decode(Payload, read(buildDirectory, build.payload))
  assert.equal(payload.sourceSeal, seal)
  same(
    payload.packages.map((pkg) => pkg.name),
    sdkNames,
    'Changed SDK cohort',
  )
  for (const pkg of payload.packages) {
    const selected = packPayload(
      path.join(root, 'packages', pkg.name),
      path.join(tools.profile, 'node_modules/.bin/pnpm'),
    )
    same(selected, pkg.files, `Normal-produced payload changed: ${pkg.name}`)
    assert.equal(pkg.sha256, hash(JSON.stringify(pkg.files)))
  }
  assert.equal(
    payload.files,
    payload.packages.reduce((count, pkg) => count + pkg.files.length, 0),
  )
  assert.equal(
    payload.directoryIdentity,
    hash(JSON.stringify(payload.packages.map(({ name, sha256 }) => ({ name, sha256 })))),
  )
  const graph = consumerGraph(
    sdkNames.map((name: string) => ({ root: path.join(root, 'packages', name), includeDev: false })),
  )
  const nodes = [...graph.values()]
  for (const node of nodes)
    if (node.name.startsWith('@livestore/') === true) {
      assert.equal(sdkNames.includes(node.name), true, 'Unqualified SDK family member in installation')
      assert.equal(
        node.root,
        fs.realpathSync(path.join(root, 'packages', node.name)),
        'SDK dependency resolves outside frozen context',
      )
    }
  const closure: unknown = [...graph.values()]
  assert.equal(digest(closure), build.closureSha256, 'Normal-installed closure changed')
  return {
    root,
    manifest,
    state,
    externalRoot,
    external,
    identity,
    seal,
    payload,
    closure,
    references,
    tools,
    toolInputsSha256: local.toolInputsSha256,
    manifestSha256: hash(manifestBytes),
  }
}
