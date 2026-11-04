import fs from 'node:fs'
import path from 'node:path'

import {
  array,
  compare,
  capture,
  digest,
  ensure,
  equal,
  hash,
  indexed,
  jsonRef,
  relative,
  sourceState,
  toolInputs,
  unique,
  readRef,
} from './commit-files.mjs'
import { assertRuntimeSummary } from './qualification-runtime.mjs'

export const decisionPath =
  'context/03-delivery/01-composition/01-developer-environment/.decisions/0004-focused-fork-qualification.md'
export const decisionSha = '879a3eacd0212d2187dd9e28762351f7a52694d9986880c549975181bf2e4e0c'
export const proposalSha = 'ebda1cec985838b43ecd1db6338f5a1445c549ae016420de64af083b6b525d69'
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
export const candidateCompatibilityPaths = [
  'context/03-delivery/01-composition/01-developer-environment/spec.md',
  'scripts/fork-qualification/README.md',
  'scripts/fork-qualification/bootstrap.mjs',
  'scripts/fork-qualification/check.mjs',
  'scripts/fork-qualification/commit-consumer.mjs',
  'scripts/fork-qualification/commit-consumer.test.mjs',
  'scripts/fork-qualification/commit-evidence.mjs',
  'scripts/fork-qualification/commit-evidence.test.mjs',
  'scripts/fork-qualification/commit-files.mjs',
  'scripts/fork-qualification/commit-fixture.mjs',
  'scripts/fork-qualification/commit-source.mjs',
  'scripts/fork-qualification/qualification-policy.mjs',
  'scripts/fork-qualification/qualification-runtime.mjs',
]
export const sourceCompatibility = (root, tree, snapshot) => {
  const before = new Map(
    snapshot.filter((row) => !row.path.startsWith('repos/effect-utils/')).map((row) => [row.path, row]),
  )
  const after = new Map(tree.map((row) => [row.path, row]))
  const descriptor = (row, current) => {
    if (row === undefined) return null
    const stat = current === true ? fs.lstatSync(path.join(root, row.path)) : undefined
    return {
      kind: row.kind,
      executable: current === true ? (stat.mode & 0o111) !== 0 : (row.mode & 0o111) !== 0,
      sha256: current === true ? hash(fs.readFileSync(path.join(root, row.path))) : row.sha256,
      ...(row.kind === 'symlink' ? { target: row.target } : {}),
    }
  }
  return [...new Set([...before.keys(), ...after.keys()])].sort(compare).flatMap((name) => {
    const old = descriptor(before.get(name), false),
      current = descriptor(after.get(name), true)
    return digest(old) === digest(current) ? [] : [{ path: name, old, current }]
  })
}
export const supportPaths = [
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'pnpm-install-contract.json',
  'tsconfig.fork.json',
  'scripts/fork-qualification/tool-profile.json',
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
const generatedCatalogFixtureConfig = 'packages/@local/astro-twoslash-code/src/cli/test-fixtures/catalog/tsconfig.json'
export const fullSetupInput = (name) =>
  name.endsWith('.nix') ||
  /^(Dockerfile|compose\.yaml|\.github\/)/.test(name) ||
  /^packages\/@livestore\/wa-sqlite\/(src\/|dist\/|Makefile|build)/.test(name) ||
  // This exact canonical compiler projection is shared metadata; its generator and renderer remain excluded.
  (/^packages\/@local\/astro-(tldraw|twoslash-code)\/src\//.test(name) && name !== generatedCatalogFixtureConfig) ||
  name === 'docs/astro.config.ts'
const shared = (name) =>
  /^(genie\/|pnpm-|package\.json|tsconfig\.|\.ox)/.test(name) ||
  /\/(package|tsconfig)\.json(?:\.genie\.ts)?$/.test(name)

export const sdkIdentity = (root, tree) => {
  const prefixes = sdkNames.map((name) => `packages/${name}/`)
  const row = (name) => ({ path: name, sha256: hash(fs.readFileSync(path.join(root, name))) })
  return {
    contract: 'livestore-local-core-candidate-inventory-v1',
    sdkFiles: tree
      .filter((entry) => prefixes.some((prefix) => entry.path.startsWith(prefix)))
      .map((entry) => row(entry.path)),
    supportFiles: supportPaths.map(row),
  }
}
export const scopeBinding = (manifest) =>
  digest({
    source: manifest.source,
    tools: manifest.tools,
    artifact: manifest.artifact,
    consumer: manifest.consumer,
    strategy: manifest.application?.strategy,
    strategyEvidence: manifest.application?.strategyEvidence,
  })
export const verifyScope = (context, manifest) =>
  capture(context, 'scope.binding', () => {
    ensure(
      hash(fs.readFileSync(path.join(context.root, decisionPath))) === decisionSha,
      'Original decision 0004 changed',
    )
    ensure(manifest.authority.proposalSha256 === proposalSha, 'Original human proposal differs')
    const review = jsonRef(context, manifest.authority.review)
    ensure(
      review.contract === 'livestore-fork-scope-v1' && review.decisionSha256 === decisionSha,
      'Missing original conditional scope authority',
    )
    ensure(review.bindingSha256 === scopeBinding(manifest), 'Reviewed scope binding differs')
    const expected = manifest.source
    const state = sourceState(context.root, expected.base)
    const pin = JSON.parse(
      fs.readFileSync(path.join(context.root, 'scripts/fork-qualification/tool-profile.json'), 'utf8'),
    ).effectUtilsRevision
    ensure(
      expected.external.base === pin && expected.external.root === 'repos/effect-utils',
      'Wrong pinned generator source',
    )
    const external = sourceState(path.join(context.root, expected.external.root), pin)
    ensure(external.changed.length === 0, 'Pinned generator has local source changes')
    equal(external.tree, expected.external.tree, 'Pinned generator source vector differs')
    context.external = external
    equal(state.tree, expected.tree, 'Current authored source vector differs')
    equal(state.changed, expected.changed, 'Reviewed changed path/hash/mode set differs')
    ensure(state.changed.length > 0, 'Nothing proposed for commit')
    equal(
      state.staged,
      state.changed.map((row) => row.path),
      'Index path set differs from reviewed changes',
    )
    ensure(
      state.changed.every((row) => indexed(context.root, row)),
      'Index bytes or executable bits differ from working source',
    )
    equal(
      expected.excluded,
      state.tree.filter((row) => fullSetupInput(row.path)),
      'Excluded input inventory differs',
    )
    ensure(
      state.changed.every((row) => !fullSetupInput(row.path)),
      'Full Setup domain changed; finite lane cannot qualify it',
    )
    const changedShared = state.changed.filter((row) => shared(row.path)).map((row) => row.path)
    unique(expected.shared, (row) => row.path, 'Duplicate shared-input review')
    equal(
      expected.shared.map((row) => row.path).sort(compare),
      changedShared.sort(compare),
      'Missing shared/direct-transitive input review',
    )
    for (const row of expected.shared) {
      const proof = jsonRef(context, row.review)
      ensure(proof.contract === 'livestore-fork-shared-input-v1', 'Wrong shared-input review')
      ensure(
        state.tree.some(
          (entry) =>
            entry.path === row.path &&
            proof.inputs?.some((input) => input.path === row.path && input.sha256 === entry.sha256),
        ),
        'Stale or deleted shared input',
      )
      ensure(
        proof.finiteSdkOnly === true && proof.fullSetupRetained === true,
        'Excluded owners cannot be qualified implicitly',
      )
      array(proof.affectedOwners, 'Shared review needs direct/transitive affected owners')
      array(proof.unqualifiedOwners, 'Shared review must record excluded owner limits')
      ensure(proof.affectedOwners.length > 0, 'Empty shared closure review')
    }
    ensure(
      manifest.tools.specSha256 ===
        hash(fs.readFileSync(path.join(context.root, 'scripts/fork-qualification/tool-profile.json'))),
      'Tool specification differs',
    )
    equal(manifest.tools.inputs, toolInputs(context.tools), 'Concrete tool bytes/modes differ')
    context.source = state
    return state
  })
export const verifyArtifact = (context, manifest) =>
  capture(context, 'artifact.binding', () => {
    const source = jsonRef(context, manifest.artifact.sourceInventory)
    const artifact = jsonRef(context, manifest.artifact.payloadInventory)
    ensure(source.identity?.contract === 'livestore-local-core-candidate-inventory-v1', 'Unknown SDK source contract')
    const state = context.source ?? sourceState(context.root, manifest.source.base)
    equal(
      source.identity,
      sdkIdentity(context.root, state.tree),
      'Actual SDK/support source differs from accepted artifact',
    )
    ensure(source.sourceInventorySha256 === digest(source.identity), 'SDK source seal does not match actual inventory')
    ensure(
      artifact.contract === 'livestore-qualified-package-payload-v1' &&
        artifact.sourceSeal === source.sourceInventorySha256,
      'Payload/source binding differs',
    )
    equal(
      artifact.packages.map((row) => row.name),
      sdkNames,
      'Incomplete SDK family',
    )
    for (const pkg of artifact.packages) {
      unique(pkg.files, (row) => row.path, 'Duplicate payload entry')
      for (const row of pkg.files) {
        relative(row.path)
        ensure(Number.isInteger(row.mode) && row.mode >= 0 && row.mode <= 0o777, 'Invalid payload mode')
        ensure(Number.isInteger(row.bytes) && row.bytes >= 0, 'Invalid payload length')
        ensure(/^[a-f0-9]{64}$/.test(row.sha256), 'Invalid payload hash')
      }
      ensure(pkg.sha256 === hash(JSON.stringify(pkg.files)), 'Package vector hash differs')
    }
    ensure(
      artifact.files === artifact.packages.reduce((sum, pkg) => sum + pkg.files.length, 0),
      'Payload count differs',
    )
    ensure(
      artifact.directoryIdentity ===
        hash(JSON.stringify(artifact.packages.map(({ name, sha256 }) => ({ name, sha256 })))),
      'Family vector hash differs',
    )
    context.artifact = artifact
    context.sdkSourceSeal = source.sourceInventorySha256
    return artifact
  })
export const verifyBuilds = (context, manifest, selectPayload) =>
  capture(context, 'source.clean-builds', () => {
    ensure(context.artifact !== undefined, 'No valid package artifact')
    const builds = manifest.source.builds
    ensure(Array.isArray(builds) && builds.length === 2, 'Two final-recipe clean reconstructions required')
    const roots = []
    for (const ref of builds) {
      const recipe = jsonRef(context, ref)
      ensure(recipe.contract === 'livestore-fork-clean-build-v1', 'Unknown clean reconstruction receipt')
      for (const name of ['bootstrap', 'install']) {
        const step = recipe[name]
        ensure(step.exitCode === 0 && step.joined === true, 'Failed or unjoined clean preparation')
        readRef(context, step.log)
      }
      ensure(
        recipe.install.frozen === true && recipe.install.strictPeers === true,
        'Normal strict frozen installation required',
      )
      const build = jsonRef(context, recipe.local)
      ensure(build.contract === 'livestore-fork-local-qualification-v1', 'Unknown clean qualification receipt')
      const root = fs.realpathSync(build.root)
      roots.push(root)
      const state = sourceState(root, manifest.source.base)
      equal(state.tree, manifest.source.tree, 'Clean build uses another complete source recipe')
      ensure(!fs.existsSync(path.join(root, '.git/objects/info/alternates')), 'Borrowed Git object store')
      const external = sourceState(path.join(root, manifest.source.external.root), manifest.source.external.base)
      ensure(external.changed.length === 0, 'Clean pinned source changed')
      equal(external.tree, manifest.source.external.tree, 'Clean generator recipe differs')
      ensure(build.externalTreeSha256 === digest(external.tree), 'Stale clean generator binding')
      ensure(build.sourceTreeSha256 === digest(state.tree), 'Stale clean source binding')
      ensure(
        build.sdkSourceSeal === context.sdkSourceSeal && build.toolInputsSha256 === digest(manifest.tools.inputs),
        'Clean SDK/tool binding differs',
      )
      unique(build.gates, (row) => row.name, 'Duplicate clean gate')
      equal(
        build.gates.map((row) => row.name),
        requiredGates,
        'Missing clean qualification gate',
      )
      for (const gate of build.gates) {
        ensure(gate.exitCode === 0 && gate.joined === true, 'Unjoined or failed clean gate')
        jsonOrBytes(context, gate.log)
      }
      assertRuntimeSummary(build.runtime)
      for (const pkg of context.artifact.packages)
        equal(
          selectPayload(path.join(root, 'packages', pkg.name)),
          pkg.files,
          'Clean produced payload bytes/modes differ',
        )
    }
    ensure(
      new Set(roots).size === 2 && roots.every((root) => root !== fs.realpathSync(context.root)),
      'Builds must be separate independent source roots',
    )
  })
const jsonOrBytes = (context, ref) => {
  // Gate output is opaque text: integrity, not a caller-supplied passed label, is checked here.
  readRef(context, ref)
}
