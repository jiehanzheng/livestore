import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { digest, hash, sourceState } from '../fork-qualification/qualification-observations.mts'
import { fullSetupInput } from '../fork-qualification/qualification-source-policy.mts'
import {
  acceptedBaselineTreeSha256,
  acceptedSdkSeal,
  assertNamedScope,
  binding,
  canonicalAncestorPaths,
  canonicalAncestorTree,
  inspectRendererRuntime,
  readReference,
  reuseIds,
  verifyArtifact,
  verifyInheritedInputs,
  verifyReuse,
  verifyStandaloneInputs,
} from './contract.mjs'
import { toolEnvironment } from './environment.mjs'
import {
  supportAncestorTree,
  trustedSupportChanges,
  trustedSupportCommit,
  verifySupportReferences,
} from './inherited-source.mjs'

const row = (name, sha256 = 'a'.repeat(64)) => ({ path: name, kind: 'file', executable: false, sha256 })
const baseline = {
  sourceTree: [
    row('docs/astro.config.ts'),
    row('examples/web-email-client/src/components/ThreadView.tsx'),
    row('pnpm-lock.yaml'),
    row('packages/@livestore/common/src/mod.ts'),
  ],
}
baseline.sourceTreeSha256 = digest(baseline.sourceTree)
const records = () =>
  reuseIds.map((id) => ({ id, status: 'pass', evidence: [{ path: 'actual-receipt', sha256: 'b'.repeat(64) }] }))
test('normal generation exposes the declared formatter independently of ambient PATH', () => {
  const tools = {
    commands: {
      pnpm: ['/declared/package-bin/pnpm'],
      format: ['/declared/format-bin/oxfmt'],
      genie: ['/declared/bun-bin/bun'],
    },
    environment: {},
  }
  const env = toolEnvironment('/workspace', tools)
  assert(env.PATH.split(path.delimiter).includes('/declared/format-bin'))
  assert.equal(env.WORKSPACE_ROOT, '/workspace')
})

test('named owners cannot admit nested Nix, release or infrastructure inputs', () => {
  for (const name of [
    'docs/new-owner.nix',
    'examples/web-todomvc/devenv.nix',
    'docs/Dockerfile',
    'examples/web-email-client/.github/workflows/ci.yml',
    'docs/release/publish.ts',
    'scripts/src/commands/release.ts',
  ])
    assert.throws(() => assertNamedScope([{ path: name }]), /workflow boundary/)
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  const state = sourceState(process.cwd(), head)
  assert.doesNotThrow(() => assertNamedScope(state.changed))
})

test('relative renderer references use the plan directory for both bytes and mode', () => {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'maintained-runtime-proof-')))
  try {
    assert.notEqual(process.cwd(), directory)
    fs.mkdirSync(path.join(directory, 'runtime'))
    const binary = path.join(directory, 'runtime/renderer')
    fs.writeFileSync(binary, 'renderer')
    fs.chmodSync(binary, 0o755)
    const runtime = { root: 'runtime', binary: { path: 'runtime/renderer', sha256: hash('renderer') }, mode: 0o755 }
    assert.equal(inspectRendererRuntime(runtime, directory, new Map()).binary, binary)
    fs.chmodSync(binary, 0o644)
    assert.throws(() => inspectRendererRuntime(runtime, directory, new Map()), /mode differs/)
    fs.chmodSync(binary, 0o755)
    fs.writeFileSync(binary, 'changed')
    assert.throws(() => inspectRendererRuntime(runtime, directory, new Map()), /Stale evidence/)
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('inherited source cannot be replaced by a new self-consistent baseline', () => {
  const changed = [row('pnpm-install-contract.json', 'c'.repeat(64))]
  assert.throws(
    () => verifyInheritedInputs(changed, { sourceTree: changed, sourceTreeSha256: digest(changed) }),
    /epoch differs/,
  )
  assert.throws(
    () => verifyInheritedInputs(changed, { sourceTree: changed, sourceTreeSha256: acceptedBaselineTreeSha256 }),
    /content differs/,
  )
})

test('canonical ancestor permits exactly nine generated hashes and preserves authored inputs', () => {
  const original = [...canonicalAncestorPaths.map((name) => row(name)), row('packages/@livestore/common/src/mod.ts')]
  const delta = canonicalAncestorPaths.map((name) => ({
    path: name,
    beforeSha256: 'a'.repeat(64),
    afterSha256: 'b'.repeat(64),
  }))
  const derived = canonicalAncestorTree(original, delta)
  assert.equal(derived.at(-1), original.at(-1))
  assert.equal(original[0].sha256, 'a'.repeat(64))
  assert.throws(() => canonicalAncestorTree(original, delta.slice(1)), /exactly nine/)
  assert.throws(
    () => canonicalAncestorTree(original, [...delta, { ...delta[0], path: 'docs/owner.nix' }]),
    /exactly nine/,
  )
  assert.throws(
    () => canonicalAncestorTree(original, [{ ...delta[0], beforeSha256: 'c'.repeat(64) }, ...delta.slice(1)]),
    /preimage differs/,
  )
})

test('standalone reuse binds its own source, lock and archived app', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'maintained-standalone-proof-')))
  try {
    const files = ['package.json', 'pnpm-lock.yaml'].map((name) => {
      const file = path.join(root, name)
      fs.writeFileSync(file, name)
      fs.chmodSync(file, 0o644)
      return { path: name, sha256: hash(name), mode: 0o644 }
    })
    const inventory = { root, selectedSdkSeal: acceptedSdkSeal, files }
    const inventoryFile = path.join(root, 'inventory.json')
    fs.writeFileSync(inventoryFile, JSON.stringify(inventory))
    const archive = path.join(root, 'archive.zip')
    fs.writeFileSync(archive, 'archived app/source')
    const archiveRef = { path: archive, sha256: hash(fs.readFileSync(archive)) }
    const spec = {
      sourceInventory: { path: inventoryFile, sha256: hash(fs.readFileSync(inventoryFile)) },
      sourceArchive: archiveRef,
      appArchive: archiveRef,
    }
    const read = (reference) => readReference(reference, root, new Map())
    assert.equal(verifyStandaloneInputs(spec, read).sourceFiles, 2)
    fs.writeFileSync(path.join(root, 'pnpm-lock.yaml'), 'changed dependency')
    assert.throws(() => verifyStandaloneInputs(spec, read), /Stale evidence/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('reuse refuses changed runtime/dependency inputs and incomplete journeys', () => {
  assert.doesNotThrow(() => verifyReuse(baseline.sourceTree, baseline, records(), () => {}))
  for (const name of [
    'examples/web-email-client/src/components/ThreadView.tsx',
    'pnpm-lock.yaml',
    'packages/@livestore/common/src/mod.ts',
  ]) {
    const changed = baseline.sourceTree.map((value) => (value.path === name ? row(name, 'c'.repeat(64)) : value))
    assert.throws(() => verifyReuse(changed, baseline, records(), () => {}), /Changed inputs/)
  }
  assert.throws(() => verifyReuse(baseline.sourceTree, baseline, records().slice(1), () => {}), /journey/)
  assert.throws(() => verifyReuse(baseline.sourceTree, baseline, [...records(), records()[0]], () => {}), /journey/)
  const pending = records()
  pending[0].status = 'pending'
  assert.throws(() => verifyReuse(baseline.sourceTree, baseline, pending, () => {}), /Unaccepted/)
})
test('artifact and reference checks reject changed bytes, modes, extra members and escape paths', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'maintained-proof-')))
  try {
    const file = path.join(root, 'page.html')
    fs.writeFileSync(file, 'reviewed')
    fs.chmodSync(file, 0o644)
    const inventory = { files: [{ path: file, sha256: hash('reviewed'), mode: 0o644, bytes: 8 }] }
    const read = () => JSON.stringify(inventory)
    const spec = { root, inventory: {} }
    assert.equal(verifyArtifact(spec, read).files, 1)
    fs.writeFileSync(file, 'changed')
    assert.throws(() => verifyArtifact(spec, read), /bytes/)
    fs.writeFileSync(file, 'reviewed')
    fs.chmodSync(file, 0o600)
    assert.throws(() => verifyArtifact(spec, read), /mode/)
    fs.chmodSync(file, 0o644)
    fs.writeFileSync(path.join(root, 'extra'), 'extra')
    assert.throws(() => verifyArtifact(spec, read), /membership/)
    fs.rmSync(path.join(root, 'extra'))
    inventory.files[0].path = '../outside'
    assert.throws(() => verifyArtifact(spec, read), /escapes/)
    assert.throws(() => readReference({ path: file, sha256: '0'.repeat(64) }, root, new Map()), /Stale/)
    assert.notEqual(binding({ source: 'before' }), binding({ source: 'after' }))
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('SDK completion inventory must match the reviewed payload inventory', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'maintained-sdk-proof-')))
  try {
    fs.mkdirSync(path.join(root, 'packages/example'), { recursive: true })
    fs.writeFileSync(path.join(root, 'packages/example/index.js'), 'payload')
    fs.chmodSync(path.join(root, 'packages/example/index.js'), 0o644)
    const inventory = JSON.stringify({
      contract: 'livestore-qualified-package-payload-v1',
      sourceSeal: acceptedSdkSeal,
      packages: [{ name: 'example', files: [{ path: 'index.js', sha256: hash('payload'), mode: 0o644 }] }],
    })
    const marker = path.join(root, 'candidate-artifact-inventory.json')
    fs.writeFileSync(marker, inventory)
    assert.equal(verifyArtifact({ root, inventory: {} }, () => inventory).files, 1)
    fs.writeFileSync(marker, '{}')
    assert.throws(() => verifyArtifact({ root, inventory: {} }, () => inventory), /completion inventory/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

// These are source-policy regressions: broad/default admission would conceal
// the strict diagnostics that distinguish this workflow from an errors-only gate.
test('generated named-owner policies retain strict diagnostics and test-only capabilities', () => {
  for (const owner of [
    'packages/@local/astro-twoslash-code',
    'packages/@local/astro-tldraw',
    'scripts/maintained-qualification',
  ]) {
    const generated = fs.readFileSync(path.resolve(owner, 'tsconfig.json'), 'utf8')
    const config = JSON.parse(generated.slice(generated.indexOf('{')))
    const plugin = config.compilerOptions.plugins.find((value) => value.name === '@effect/language-service')
    assert.equal(plugin.ignoreEffectWarningsInTscExitCode, false)
    assert.equal(plugin.ignoreEffectSuggestionsInTscExitCode, false)
    assert.equal(plugin.ignoreEffectErrorsInTscExitCode, false)
    assert(plugin.allowedUnstableApis.length > 0)
    assert(
      plugin.allowedUnstableApis.every((value) => !value.includes('*') && !value.startsWith('@effect/vitest')) === true,
    )
    for (const override of plugin.overrides ?? []) {
      if (override.options.allowedUnstableApis?.some((value) => value.startsWith('@effect/vitest')) === true)
        assert(override.include.every((value) => value.includes('.test.') || value.includes('.spec.')))
    }
  }
})

const supportFixture = () => ({
  tree: trustedSupportChanges.map((change) => row(change.path, change.beforeSha256)),
  transition: { commit: trustedSupportCommit, delta: structuredClone(trustedSupportChanges) },
})
const rejectsSupport = (mutate, pattern) => {
  const fixture = supportFixture()
  mutate(fixture)
  assert.throws(() => supportAncestorTree(fixture.tree, fixture.transition), pattern)
}

test('trusted support advances exactly five preimages and matches every live909 postimage', () => {
  const { tree, transition } = supportFixture()
  const derived = supportAncestorTree(tree, transition)
  assert.deepEqual(
    derived,
    trustedSupportChanges.map((change) => row(change.path, change.afterSha256)),
  )
  for (const change of trustedSupportChanges) {
    const file = path.resolve(change.path)
    assert.equal(hash(fs.readFileSync(file)), change.afterSha256)
    assert(fs.lstatSync(file).isFile() && !fs.lstatSync(file).isSymbolicLink())
    assert.equal(fs.statSync(file).mode & 0o111, 0)
  }
  assert.deepEqual(tree, supportFixture().tree)
})
for (const { name, mutate } of [
  { name: 'missing path', mutate: ({ transition }) => transition.delta.pop() },
  {
    name: 'extra sixth path',
    mutate: ({ transition }) => transition.delta.push({ ...transition.delta[0], path: 'extra' }),
  },
  { name: 'duplicate path', mutate: ({ transition }) => transition.delta.push(transition.delta[0]) },
  {
    name: 'different commit',
    mutate: ({ transition }) => {
      transition.commit = '0'.repeat(40)
    },
  },
  {
    name: 'different committed postimage',
    mutate: ({ transition }) => {
      transition.delta[0].afterSha256 = '0'.repeat(64)
    },
  },
  {
    name: 'different preimage',
    mutate: ({ tree }) => {
      tree[0].sha256 = '0'.repeat(64)
    },
  },
  {
    name: 'executable preimage',
    mutate: ({ tree }) => {
      tree[0].executable = true
    },
  },
  {
    name: 'symlink preimage',
    mutate: ({ tree }) => {
      tree[0].kind = 'symlink'
    },
  },
  { name: 'absent inherited target', mutate: ({ tree }) => tree.pop() },
])
  test(`trusted support rejects ${name}`, () => rejectsSupport(mutate, /support/))

test('support authority cannot promote a self-consistent whole current snapshot', () => {
  const current = sourceState(
    process.cwd(),
    execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  ).tree
  assert.throws(
    () => verifyInheritedInputs(current, { sourceTree: current, sourceTreeSha256: digest(current) }),
    /epoch differs/,
  )
})

test('support derivation preserves unrelated SDK bytes instead of inheriting a changed package', () => {
  const { tree, transition } = supportFixture()
  const sdk = row('packages/@livestore/common/src/mod.ts')
  const derived = supportAncestorTree([...tree, sdk], transition)
  assert.equal(derived.at(-1), sdk)
  const changed = [...derived.slice(0, -1), { ...sdk, sha256: 'b'.repeat(64) }]
  // The whole-ancestor pin is checked before projection admission, even for a
  // self-consistent tree that includes all five trusted support replacements.
  assert.throws(
    () => verifyInheritedInputs(changed, { sourceTree: changed, sourceTreeSha256: digest(changed) }),
    /epoch differs/,
  )
})

test('trusted support does not admit nested infrastructure or SDK Full Setup owners', () => {
  for (const name of ['docs/owner.nix', 'docs/release/publish.ts', 'docs/.github/workflows/new.yml'])
    assert.throws(() => assertNamedScope([{ path: name }]), /workflow boundary/)
  for (const name of ['docs/astro.config.ts', 'packages/@local/astro-twoslash-code/src/renderer.ts'])
    assert.equal(fullSetupInput(name), true)
})

test('support references reject stale bytes independently of their English authority', () => {
  const change = trustedSupportChanges[0]
  const reference = { path: 'untrusted-receipt', sha256: change.beforeSha256 }
  const transition = {
    delta: [{ ...change, preimage: reference, postimage: { ...reference, sha256: change.afterSha256 } }],
  }
  assert.throws(
    () => verifySupportReferences(transition, () => Buffer.from('untrusted bytes')),
    /preimage bytes differ/,
  )
})
