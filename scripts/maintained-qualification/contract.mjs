import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import {
  consumerGraph,
  digest,
  hash,
  sourceState,
  toolInputs,
} from '../fork-qualification/qualification-observations.mts'
import { fullSetupInput } from '../fork-qualification/qualification-source-policy.mts'
import { inheritedAncestorTree } from './inherited-source.mjs'
export { acceptedBaselineTreeSha256, canonicalAncestorPaths, canonicalAncestorTree } from './inherited-source.mjs'

export const proposalSha256 = '84516d5680afe98386f0d4fd62caf349b0bfd9d6c41b881bef671b76bcf8fc2b'
export const acceptedSdkSeal = '6efb8213be0dacada7f8f188a729f2c57e4800d671dba74bf471509d1f8450c8'
export const decisionPath =
  'context/03-delivery/01-composition/01-developer-environment/.decisions/0004-focused-fork-qualification.md'
export const demos = [
  'cloudflare-todomvc',
  'web-todomvc',
  'web-todomvc-script',
  'web-todomvc-sync-cf',
  'web-email-client',
  'tutorial-starter',
  'web-linearlite',
]
export const reuseIds = ['sdk', 'docs.browser', ...demos.map((name) => `demo.${name}`), 'expo.standalone']
const sharedInputs = [
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'pnpm-install-contract.json',
  'genie/external.ts',
  'packages/@livestore/',
]
const renderers = ['packages/@local/astro-tldraw/', 'packages/@local/astro-twoslash-code/']
const exactPaths = new Set([
  'AGENTS.md',
  '.oxfmtrc.json',
  '.oxlintrc.json',
  ...sharedInputs.filter((name) => !name.endsWith('/')),
  'genie/external.ts',
  'genie/repo.ts',
  'genie/maintained-effect-api-policy.ts',
  'scripts/src/shared/misc.ts',
  'scripts/src/shared/netlify.ts',
  decisionPath,
  'context/03-delivery/01-composition/01-developer-environment/spec.md',
  'context/02-system/02-state/01-sqlite/02-schema-management/spec.md',
  'context/02-system/04-runtime/01-web/01-persistence/spec.md',
  'context/04-docs/spec.md',
  'contributor-docs/docs/snippets.md',
  'scripts/src/commands/docs.ts',
  'scripts/src/commands/docs-export.ts',
  'scripts/src/generated/release-topology.json',
  'scripts/package.json',
])
const prefixes = [
  'docs/',
  ...renderers,
  ...demos.map((name) => `examples/${name}/`),
  'scripts/maintained-qualification/',
]
const frozenPrefixes = ['packages/@livestore/', 'scripts/fork-qualification/', 'scripts/standalone/', 'tests/']
const inheritedInputs = [
  ...frozenPrefixes,
  ...sharedInputs,
  '.oxfmtrc.json',
  '.oxlintrc.json',
  'scripts/src/generated/release-topology.json',
  'scripts/package.json',
  'context/02-system/02-state/01-sqlite/02-schema-management/spec.md',
  'context/02-system/04-runtime/01-web/01-persistence/spec.md',
  'context/04-docs/spec.md',
  'contributor-docs/docs/snippets.md',
]
const matches = (name, selections) =>
  selections.some((selection) => (selection.endsWith('/') === true ? name.startsWith(selection) : name === selection))
const projection = (tree, selections) => tree.filter((row) => matches(row.path, selections))

// Nested ownership never overrides the original Nix/release/infrastructure boundary.
export const assertNamedScope = (changed) => {
  for (const { path: name } of changed) {
    assert(
      !name.endsWith('.nix') &&
        !/(^|\/)(?:Dockerfile(?:\.[^/]*)?|compose\.ya?ml|flake\.lock|devenv\.lock)$/.test(name) &&
        !/(^|\/)(?:\.github|\.buildkite|infrastructure|release)\//.test(name) &&
        !/^scripts\/src\/commands\/(?:release|publish|deploy)(?:[./-]|$)/.test(name),
      `Outside maintained workflow boundary: ${name}`,
    )
    assert(
      exactPaths.has(name) || matches(name, [...prefixes, ...frozenPrefixes]),
      `Outside named maintained scope: ${name}`,
    )
  }
}

// Generated projections are checked by canonical Genie; their authored generator
// is formatted/linted here. Frozen SDK/support inputs keep their original proof.
export const authoredFiles = (root, tree) =>
  tree
    .filter(
      (row) =>
        row.kind === 'file' &&
        (matches(row.path, prefixes) ||
          [
            'AGENTS.md',
            decisionPath,
            'context/03-delivery/01-composition/01-developer-environment/spec.md',
            'genie/repo.ts',
            'genie/maintained-effect-api-policy.ts',
            'scripts/src/commands/docs.ts',
            'scripts/src/commands/docs-export.ts',
            'scripts/src/shared/misc.ts',
            'scripts/src/shared/netlify.ts',
            'scripts/src/shared/deploy-target.ts',
            'scripts/src/shared/workflow-report.ts',
          ].includes(row.path)),
    )
    .map((row) => row.path)
    .filter(
      (name) =>
        /\.(?:[cm]?[jt]sx?|json|md)$/.test(name) &&
        !/\.(?:gen|generated)\.[cm]?[jt]sx?$/.test(name) &&
        !fs.existsSync(path.join(root, name + '.genie.ts')),
    )

// Authority binds the exact plan. A receipt's English label cannot expand these owners.
export const binding = (plan) => digest(Object.fromEntries(Object.entries(plan).filter(([name]) => name !== 'review')))
export const readReference = (reference, directory, references) => {
  assert(
    reference && typeof reference.path === 'string' && /^[a-f0-9]{64}$/.test(reference.sha256),
    'Expected hashed reference',
  )
  const file = path.resolve(directory, reference.path),
    bytes = fs.readFileSync(file)
  assert.equal(hash(bytes), reference.sha256, `Stale evidence: ${file}`)
  references.set(file, reference.sha256)
  return bytes
}

export const inspectRendererRuntime = (runtime, directory, references) => {
  const root = fs.realpathSync(path.resolve(directory, runtime.root))
  const binary = fs.realpathSync(path.resolve(directory, runtime.binary.path))
  const relative = path.relative(root, binary)
  assert(
    relative !== '' && !relative.startsWith('../') && !path.isAbsolute(relative),
    'Renderer binary escapes runtime',
  )
  readReference({ ...runtime.binary, path: binary }, directory, references)
  const stat = fs.lstatSync(binary)
  assert(stat.isFile(), 'Renderer binary must be a regular file')
  assert.equal(stat.mode & 0o777, runtime.mode, 'Renderer runtime mode differs')
  return { root, binary }
}

export const verifyInheritedInputs = (tree, baseline, original, read) => {
  const ancestor = inheritedAncestorTree(baseline, original, read)
  assert.deepEqual(
    projection(tree, inheritedInputs),
    projection(ancestor, inheritedInputs),
    'Inherited SDK/checker/test/support baseline changed',
  )
}

export const verifyReuse = (tree, baseline, records, read) => {
  assert.equal(digest(baseline.sourceTree), baseline.sourceTreeSha256, 'Baseline source tree binding differs')
  assert.deepEqual(
    records.map((row) => row.id).sort(),
    [...reuseIds].sort(),
    'Missing, extra or duplicate maintained journey',
  )
  for (const record of records) {
    assert.equal(record.status, 'pass', `Unaccepted journey: ${record.id}`)
    assert(record.evidence.length > 0, 'Journey needs concrete evidence')
    const recorded = record.baseline === undefined ? baseline : JSON.parse(read(record.baseline))
    assert.equal(digest(recorded.sourceTree), recorded.sourceTreeSha256, 'Journey baseline binding differs')
    // SDK exports and the standalone consumer retain their own source/lock/artifact
    // proofs; broader workspace formatting is not one of their consumed inputs.
    const selections =
      record.id === 'sdk' || record.id === 'expo.standalone' ? ['packages/@livestore/'] : [...sharedInputs]
    if (record.id.startsWith('docs.') === true) selections.push('docs/', ...renderers)
    else if (record.id.startsWith('demo.') === true) selections.push(`examples/${record.id.slice(5)}/`)
    // Native inputs live in a separate ordinary consumer: their source/archive proofs
    // remain explicit evidence, rather than being relabeled as this checkout's files.
    // Browser evidence binds generated page/assets. The checker always rebuilds
    // production and compares every reviewed byte/mode before reusing that view.
    if (record.id !== 'docs.browser')
      assert.deepEqual(
        projection(tree, selections),
        projection(recorded.sourceTree, selections),
        `Changed inputs invalidate reuse: ${record.id}`,
      )
    for (const reference of record.evidence) read(reference)
  }
}

export const verifyStandaloneInputs = (spec, read) => {
  const inventory = JSON.parse(read(spec.sourceInventory))
  assert.equal(inventory.selectedSdkSeal, acceptedSdkSeal, 'Standalone SDK cohort differs')
  assert(Array.isArray(inventory.files) && inventory.files.length > 0)
  for (const required of ['package.json', 'pnpm-lock.yaml'])
    assert(
      inventory.files.some((row) => row.path === required),
      'Standalone source and lock must be explicit',
    )
  const root = fs.realpathSync(inventory.root)
  for (const row of inventory.files) {
    const file = path.resolve(root, row.path),
      relative = path.relative(root, file)
    assert(
      relative !== '' && !relative.startsWith('../') && !path.isAbsolute(relative),
      'Standalone source escapes root',
    )
    const stat = fs.lstatSync(file)
    assert(stat.isFile() && !stat.isSymbolicLink(), 'Standalone source must be a regular file')
    read({ path: file, sha256: row.sha256 })
    assert.equal(stat.mode & 0o777, row.mode, 'Standalone source mode differs')
  }
  read(spec.sourceArchive)
  read(spec.appArchive)
  return {
    sourceFiles: inventory.files.length,
    sourceInventory: spec.sourceInventory,
    sourceArchive: spec.sourceArchive,
    appArchive: spec.appArchive,
  }
}

export const verifyArtifact = (spec, read) => {
  const inventoryBytes = read(spec.inventory)
  const inventory = JSON.parse(inventoryBytes)
  const root = fs.realpathSync(spec.root)
  const sdk = inventory.contract === 'livestore-qualified-package-payload-v1'
  if (sdk === true) assert.equal(inventory.sourceSeal, acceptedSdkSeal, 'Accepted SDK seal differs')
  const rows =
    sdk === true
      ? inventory.packages.flatMap((pkg) =>
          pkg.files.map((row) => ({ ...row, path: `packages/${pkg.name}/${row.path}` })),
        )
      : inventory.files
  assert(Array.isArray(rows) && rows.length > 0, 'Empty artifact inventory')
  const expected = new Set()
  for (const row of rows) {
    const file = path.resolve(root, row.path),
      relative = path.relative(root, file)
    assert(relative && !relative.startsWith('../') && !path.isAbsolute(relative), 'Artifact path escapes root')
    assert(!expected.has(relative), 'Duplicate artifact member')
    expected.add(relative)
    const stat = fs.lstatSync(file)
    assert(stat.isFile() && !stat.isSymbolicLink(), 'Artifact must be an actual regular file')
    assert.equal(hash(fs.readFileSync(file)), row.sha256, `Artifact bytes differ: ${relative}`)
    assert.equal(stat.mode & 0o777, row.mode, `Artifact mode differs: ${relative}`)
    if (row.bytes !== undefined) assert.equal(stat.size, row.bytes, 'Artifact length differs')
  }
  if (sdk === true) {
    assert.equal(
      hash(fs.readFileSync(path.join(root, 'candidate-artifact-inventory.json'))),
      hash(inventoryBytes),
      'SDK completion inventory differs',
    )
    expected.add('candidate-artifact-inventory.json')
  }
  const actual = []
  const walk = (directory) => {
    for (const row of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, row.name)
      if (row.isDirectory() === true) walk(file)
      else {
        assert(row.isFile(), 'Unexpected artifact link')
        actual.push(path.relative(root, file))
      }
    }
  }
  walk(root)
  assert.deepEqual(
    actual.sort((a, b) => a.localeCompare(b, 'en')),
    [...expected].sort((a, b) => a.localeCompare(b, 'en')),
    'Artifact membership differs',
  )
  return { root, files: rows.length, inventory: spec.inventory }
}

export const inspect = (root, planFile, tools) => {
  const references = new Map(),
    directory = path.dirname(planFile)
  const read = (reference) => readReference(reference, directory, references)
  const plan = JSON.parse(fs.readFileSync(planFile))
  references.set(planFile, hash(fs.readFileSync(planFile)))
  assert.equal(plan.contract, 'livestore-maintained-qualification-v2')
  assert.equal(plan.proposalSha256, proposalSha256)
  const review = JSON.parse(read(plan.review))
  assert.equal(review.contract, 'livestore-maintained-qualification-review-v2')
  assert.equal(review.proposalSha256, proposalSha256)
  assert.equal(review.bindingSha256, binding(plan), 'Lead-reviewed source/matrix binding differs')
  assert.equal(plan.decision.sha256, hash(fs.readFileSync(path.join(root, decisionPath))), 'Decision changed')
  read(plan.decision)
  read(plan.inheritedFormatDiagnostics)
  for (const reference of Object.values(plan.canonicalTransition)) read(reference)
  const rendererRuntime = inspectRendererRuntime(plan.rendererRuntime, directory, references)
  assert.deepEqual(plan.tools, toolInputs(tools), 'Actual tool recipe differs')
  const state = sourceState(root, plan.source.base)
  assert.deepEqual(state.tree, plan.source.tree, 'Authored source differs')
  assert.deepEqual(state.changed, plan.source.changed, 'Changed scope differs')
  assert.equal(state.indexDigest, plan.source.indexDigest, 'Index differs')
  const baseline = JSON.parse(read(plan.baseline))
  const graph = consumerGraph(
    ['examples/web-email-client', 'docs'].map((name) => ({ root: path.join(root, name), includeDev: true })),
  )
  assert.equal(
    digest([...graph.values()]),
    baseline.consumerGraphSha256,
    'Installed dependency closure differs from accepted baseline',
  )
  // Keep the SDK-only lane frozen, including its existing broader-scope refusal.
  verifyInheritedInputs(state.tree, baseline, JSON.parse(read(baseline.originalBaseline)), read)
  assertNamedScope(state.changed)
  assert(
    fullSetupInput('docs/astro.config.ts') && fullSetupInput('packages/@local/astro-twoslash-code/src/renderer.ts'),
    'SDK-only boundary was weakened',
  )
  verifyReuse(state.tree, baseline, plan.reuse, read)
  const standalone = verifyStandaloneInputs(plan.standalone, read)
  const artifacts = plan.artifacts.map((spec) => verifyArtifact(spec, read))
  assert.deepEqual(
    plan.artifacts.map((row) => row.id).sort(),
    ['sdk', 'docs', ...demos.filter((name) => name !== 'cloudflare-todomvc')].sort(),
    'Bind each selected SDK/docs/web artifact exactly once',
  )
  return { plan, state, references, artifacts, rendererRuntime, standalone }
}
