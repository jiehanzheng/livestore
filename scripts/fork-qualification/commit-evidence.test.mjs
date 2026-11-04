import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { verifyApplication, verifyCandidate } from './commit-consumer.mjs'
import { commitVerdict, finishCommitEvidence, inspectCommitEvidence, requiredCases } from './commit-evidence.mjs'
import { capture, digest, hash, indexed, jsonRef, readRef, sourceState } from './commit-files.mjs'
import { makeFixture } from './commit-fixture.mjs'
import { fullSetupInput, sourceCompatibility, verifyArtifact, verifyBuilds, verifyScope } from './commit-source.mjs'

const using = async (run) => {
  const fixture = makeFixture()
  try {
    await run(fixture)
  } finally {
    fixture.cleanup()
  }
}
const codes = (context) => context.issues.map((row) => row.code)
const catalogConfig = 'packages/@local/astro-twoslash-code/src/cli/test-fixtures/catalog/tsconfig.json'
const reviewCurrentScope = (f) => {
  f.git(['add', '.'])
  const state = sourceState(f.root, f.manifest.source.base)
  Object.assign(f.manifest.source, {
    tree: state.tree,
    changed: state.changed,
    excluded: state.tree.filter((row) => fullSetupInput(row.path)),
    shared: state.changed
      .filter((row) => /\/(package|tsconfig)\.json(?:\.genie\.ts)?$/.test(row.path))
      .map((row) => ({
        path: row.path,
        review: f.json({
          contract: 'livestore-fork-shared-input-v1',
          inputs: [{ path: row.path, sha256: row.sha256 }],
          affectedOwners: ['packages/@local/astro-twoslash-code'],
          unqualifiedOwners: ['packages/@local/astro-twoslash-code'],
          finiteSdkOnly: true,
          fullSetupRetained: true,
        }),
      })),
  })
  f.rebind()
}

test('exact generated catalog metadata requires current shared proof and does not grant eligibility', () =>
  using((f) => {
    fs.writeFileSync(path.join(f.root, catalogConfig), '{"compilerOptions":{"strict":false}}\n')
    reviewCurrentScope(f)
    const accepted = f.context()
    verifyScope(accepted, f.manifest)
    assert.deepEqual(accepted.issues, [])
    assert.equal(commitVerdict(accepted).eligible, false)
    const proof = f.manifest.source.shared
    f.manifest.source.shared = []
    f.rebind()
    const missing = f.context()
    verifyScope(missing, f.manifest)
    assert(missing.issues.some((row) => row.detail === 'Missing shared/direct-transitive input review'))
    f.manifest.source.shared = proof
    const staleProof = JSON.parse(fs.readFileSync(proof[0].review.path, 'utf8'))
    staleProof.inputs[0].sha256 = '0'.repeat(64)
    proof[0].review = f.json(staleProof)
    f.rebind()
    const stale = f.context()
    verifyScope(stale, f.manifest)
    assert(stale.issues.some((row) => row.detail === 'Stale or deleted shared input'))
  }))

test('fresh metadata proof cannot admit adjacent generators, fixture or renderer source, or other configs', () =>
  using((f) => {
    const blocked = [
      `${catalogConfig}.genie.ts`,
      catalogConfig.replace('catalog/tsconfig.json', 'catalog/nearby/tsconfig.json'),
      catalogConfig.replace('catalog/tsconfig.json', 'catalog/schema.ts'),
      'packages/@local/astro-twoslash-code/src/cli/snippets.ts',
      'packages/@local/astro-tldraw/src/tsconfig.json',
      'docs/astro.config.ts',
    ]
    for (const name of blocked) {
      assert.equal(fullSetupInput(name), true)
      const file = path.join(f.root, name)
      const previous = fs.existsSync(file) === true ? fs.readFileSync(file) : undefined
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, 'changed excluded owner\n')
      // Even newly regenerated output and fresh shared proof cannot admit the generator change.
      fs.writeFileSync(path.join(f.root, catalogConfig), JSON.stringify({ regeneratedFor: name }))
      reviewCurrentScope(f)
      const context = f.context()
      verifyScope(context, f.manifest)
      assert(context.issues.some((row) => row.detail === 'Full Setup domain changed; finite lane cannot qualify it'))
      if (previous === undefined) fs.unlinkSync(file)
      else fs.writeFileSync(file, previous)
    }
  }))

test('canonical Genie rejects hand-mutated catalog output and severity despite fresh shared proof', () =>
  using((f) => {
    const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
    const tools = JSON.parse(fs.readFileSync(path.join(repo, 'temp_nocommit/fork-qualification/tools.json'), 'utf8'))
    // Canonical discovery excludes temp_nocommit itself, so this disposable repository must be outside that tree.
    const root = path.join(f.home, 'canonical-genie')
    fs.mkdirSync(root)
    try {
      fs.cpSync(path.join(repo, 'genie'), path.join(root, 'genie'), { recursive: true })
      for (const name of [
        'package.json',
        '.oxfmtrc.json',
        'megarepo.kdl',
        'megarepo.lock',
        'release/version.json',
        'scripts/fork-qualification/tool-profile.json',
      ]) {
        fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true })
        fs.copyFileSync(path.join(repo, name), path.join(root, name))
      }
      fs.cpSync(path.dirname(path.join(repo, catalogConfig)), path.dirname(path.join(root, catalogConfig)), {
        recursive: true,
      })
      fs.symlinkSync(path.join(repo, 'node_modules'), path.join(root, 'node_modules'))
      fs.mkdirSync(path.join(root, 'repos'))
      fs.symlinkSync(path.join(repo, 'repos/effect-utils'), path.join(root, 'repos/effect-utils'))
      const check = () =>
        spawnSync(
          tools.commands.genie[0],
          [...tools.commands.genie.slice(1), '--check', '--cwd', path.dirname(path.join(root, catalogConfig))],
          {
            cwd: root,
            env: { ...process.env, ...tools.environment },
            encoding: 'utf8',
          },
        )
      const baseline = check()
      assert.equal(baseline.status, 0, baseline.stdout + baseline.stderr)
      assert.match(baseline.stdout + baseline.stderr, /tsconfig\.json/)
      const output = path.join(root, catalogConfig)
      const original = fs.readFileSync(output, 'utf8')
      fs.chmodSync(output, 0o644)
      for (const changed of [
        original.replace('"noEmit": true', '"noEmit": false'),
        original.replace('"globalJsonInEffect": "warning"', '"globalJsonInEffect": "off"'),
      ]) {
        assert.notEqual(changed, original)
        fs.writeFileSync(output, changed)
        const proof = { path: output, sha256: hash(fs.readFileSync(output)) }
        const context = { evidenceDirectory: root, references: new Map() }
        readRef(context, proof)
        fs.writeFileSync(path.join(f.root, catalogConfig), changed)
        reviewCurrentScope(f)
        const scope = f.context()
        verifyScope(scope, f.manifest)
        assert.deepEqual(scope.issues, [])
        const result = check()
        assert.equal(result.status, 1, result.stdout + result.stderr)
        assert.match(result.stdout + result.stderr, /tsconfig\.json/)
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  }))

test('index verification reads large binary blobs and rejects a same-size working mutation', () =>
  using((f) => {
    const name = 'large.wasm'
    const bytes = Buffer.alloc(1261904, 0xa5)
    fs.writeFileSync(path.join(f.root, name), bytes)
    f.git(['add', name])
    const row = sourceState(f.root, f.manifest.source.base).changed.find((entry) => entry.path === name)
    assert.equal(indexed(f.root, row), true)
    bytes[bytes.length - 1] ^= 1
    fs.writeFileSync(path.join(f.root, name), bytes)
    const changed = sourceState(f.root, f.manifest.source.base).changed.find((entry) => entry.path === name)
    assert.equal(indexed(f.root, changed), false)
  }))

test('complete synthetic filesystem-bound proof can finish, while preflight alone is never eligible', () =>
  using((f) => {
    const context = inspectCommitEvidence(f)
    assert.deepEqual(context.issues, [])
    assert.equal(commitVerdict(context).eligible, false)
    assert.equal(finishCommitEvidence(context, f.local).eligible, true)
  }))

test('missing or wrong schema is blocked and lists mandatory acceptance cases', () =>
  using((f) => {
    const context = inspectCommitEvidence({ ...f, evidenceFile: undefined })
    assert(codes(context).includes('evidence.schema'))
    assert(codes(context).includes('acceptance.web.multicontext-offline-recovery'))
    f.manifest.command = ['not executed']
    f.rebind()
    assert(codes(inspectCommitEvidence(f)).includes('evidence.schema'))
  }))

test('ordinary local passes do not replace missing, failed or pending required scope', () =>
  using((f) => {
    for (const status of ['pending', 'fail']) {
      f.manifest.application.cases.find((row) => row.id === 'web.multicontext-offline-recovery').status = status
      f.rebind()
      const c = f.context()
      verifyApplication(c, f.manifest.application, requiredCases('fresh-preserve-old'))
      assert(codes(c).includes('acceptance.web.multicontext-offline-recovery'))
    }
    f.manifest.application.cases = f.manifest.application.cases.filter((row) => row.id !== 'ios.native-close-authority')
    f.rebind()
    const c = f.context()
    verifyApplication(c, f.manifest.application, requiredCases('fresh-preserve-old'))
    assert(codes(c).includes('acceptance.ios.native-close-authority'))
  }))

test('strategy, duplicate cases and wrong-platform artifact cannot shorten the reviewed policy', () =>
  using((f) => {
    f.manifest.application.cases.push({ ...f.manifest.application.cases[0] })
    f.manifest.application.cases.find((row) => row.id === 'ios.local-persistence').artifacts = ['web']
    f.rebind()
    const c = f.context()
    verifyApplication(c, f.manifest.application, requiredCases('fresh-preserve-old'))
    assert(codes(c).includes('application.case-schema'))
    assert(codes(c).includes('acceptance.ios.local-persistence'))
    assert(requiredCases('continuous').includes('web.old-pending-continuity'))
    assert(!requiredCases('fresh-preserve-old').includes('web.old-pending-continuity'))
  }))

test('staged/index, source and excluded input mutations reject rather than approving by SDK label', () =>
  using((f) => {
    f.git(['reset', '--quiet'])
    const unstaged = f.context()
    verifyScope(unstaged, f.manifest)
    assert(codes(unstaged).includes('scope.binding'))
    f.git(['add', '.'])
    fs.writeFileSync(path.join(f.root, 'flake.nix'), 'changed excluded closure')
    const excluded = f.context()
    verifyScope(excluded, f.manifest)
    assert(codes(excluded).includes('scope.binding'))
    fs.appendFileSync(path.join(f.root, 'packages/@livestore/common/src/value.js'), 'changed')
    const source = f.context()
    verifyArtifact(source, f.manifest)
    assert(codes(source).includes('artifact.binding'))
  }))

test('reviewed scope, original decision, concrete tool and pinned generator cannot be substituted', () =>
  using((f) => {
    f.manifest.authority.proposalSha256 = '0'.repeat(64)
    const original = f.context()
    verifyScope(original, f.manifest)
    assert(codes(original).includes('scope.binding'))
    f.manifest.authority.proposalSha256 = 'ebda1cec985838b43ecd1db6338f5a1445c549ae016420de64af083b6b525d69'
    fs.appendFileSync(f.tools.commands.compiler[0], 'modified tool')
    const tool = f.context()
    verifyScope(tool, f.manifest)
    assert(codes(tool).includes('scope.binding'))
    fs.appendFileSync(path.join(f.root, 'repos/effect-utils/value.ts'), 'changed pin')
    const pin = f.context()
    verifyScope(pin, f.manifest)
    assert(codes(pin).includes('scope.binding'))
  }))

test('immutable old receipt hash fails after amendment; a distinct successor is not silently substituted', () =>
  using((f) => {
    const old = f.json({ accepted: 'initial' })
    const c = f.context()
    assert.deepEqual(jsonRef(c, old), { accepted: 'initial' })
    fs.writeFileSync(old.path, JSON.stringify({ accepted: 'amended' }))
    const next = f.json({ accepted: 'sealed successor' })
    capture(c, 'old.mismatch', () => readRef(c, old))
    assert(codes(c).includes('old.mismatch'))
    assert.deepEqual(jsonRef(c, next), { accepted: 'sealed successor' })
    assert(codes(c).includes('old.mismatch'))
  }))

test('evidence, app source and actual artifact mutations reject even if all receipt labels stay the same', () =>
  using((f) => {
    const caseRef = f.manifest.application.cases[0].evidence[0]
    fs.writeFileSync(caseRef.path, 'different bytes')
    fs.appendFileSync(path.join(f.home, 'accepted-app.js'), 'different source')
    const c = f.context()
    verifyApplication(c, f.manifest.application, requiredCases('fresh-preserve-old'))
    assert(codes(c).includes('application.artifacts'))
    assert(codes(c).includes('acceptance.web.local-persistence'))
  }))

test('candidate actual membership and executable modes are not inferred from source fixture stats', () =>
  using((f) => {
    const root = path.join(f.manifest.artifact.root, 'packages/@livestore/common')
    fs.writeFileSync(path.join(root, 'src/unexpected.js'), 'not in qualified payload')
    const c = f.context()
    verifyCandidate(c, f.manifest.artifact)
    assert(codes(c).includes('artifact.actual-payload'))
    fs.unlinkSync(path.join(root, 'src/unexpected.js'))
    fs.chmodSync(path.join(root, 'src/value.js'), 0o755)
    const mode = f.context()
    verifyCandidate(mode, f.manifest.artifact)
    assert(codes(mode).includes('artifact.actual-payload'))
  }))

test('a source-only candidate preserves sealed unpublished inputs and refuses extra or changed authored files', () =>
  using((f) => {
    const relative = 'packages/@livestore/common/private-build-input.ts'
    const original = 'export const value = 1\n'
    fs.writeFileSync(path.join(f.root, relative), original)
    const link = 'packages/@livestore/common/private-build-link.ts'
    const target = 'private-build-input.ts'
    fs.symlinkSync(target, path.join(f.root, link))
    const source = JSON.parse(fs.readFileSync(f.manifest.artifact.sourceInventory.path, 'utf8'))
    source.identity.sdkFiles.push({ path: relative, sha256: hash(original) })
    source.snapshotFiles.push({ path: relative, sha256: hash(original), mode: 0o644, kind: 'file' })
    source.identity.sdkFiles.push({ path: link, sha256: hash(original) })
    source.snapshotFiles.push({
      path: link,
      sha256: hash(original),
      mode: fs.lstatSync(path.join(f.root, link)).mode & 0o777,
      kind: 'symlink',
      target,
    })
    source.snapshotInventorySha256 = digest(source.snapshotFiles)
    source.sourceInventorySha256 = digest(source.identity)
    const root = path.join(path.dirname(f.manifest.artifact.root), source.sourceInventorySha256)
    fs.renameSync(f.manifest.artifact.root, root)
    fs.writeFileSync(path.join(root, relative), original)
    fs.symlinkSync(target, path.join(root, link))
    const spec = {
      ...f.manifest.artifact,
      root,
      sourceInventory: f.json(source),
      compatibility: f.json({
        contract: 'livestore-fork-candidate-compatibility-v1',
        sourceSnapshotSha256: source.snapshotInventorySha256,
        currentSourceTreeSha256: digest(sourceState(f.root, f.manifest.source.base).tree),
        changes: [],
      }),
    }
    const inspect = () => {
      const c = { ...f.context(), sdkSourceSeal: source.sourceInventorySha256 }
      verifyCandidate(c, spec)
      return c
    }
    assert.deepEqual(inspect().issues, [])
    assert.equal(fs.existsSync(path.join(root, 'node_modules')), false)
    fs.unlinkSync(path.join(root, link))
    fs.symlinkSync('src/value.js', path.join(root, link))
    assert(inspect().issues.some((row) => row.detail.includes('link target differs')))
    fs.unlinkSync(path.join(root, link))
    fs.symlinkSync(target, path.join(root, link))
    fs.chmodSync(path.join(root, relative), 0o755)
    assert(codes(inspect()).includes('artifact.actual-payload'))
    fs.chmodSync(path.join(root, relative), 0o644)
    fs.appendFileSync(path.join(root, relative), 'changed')
    assert(codes(inspect()).includes('artifact.actual-payload'))
    fs.writeFileSync(path.join(root, relative), original)
    const extra = path.join(root, 'packages/@livestore/common/unpublished-extra.ts')
    fs.writeFileSync(extra, original)
    assert(codes(inspect()).includes('artifact.actual-payload'))
    fs.unlinkSync(extra)
    fs.unlinkSync(path.join(root, relative))
    assert(codes(inspect()).includes('artifact.actual-payload'))
  }))

test('duplicate clean roots, failed gates and stale clean recipe cannot supply reconstruction evidence', () =>
  using((f) => {
    f.manifest.source.builds[1] = f.manifest.source.builds[0]
    const c = f.context()
    verifyBuilds(c, f.manifest, (root) => f.artifact.packages.find((pkg) => root.endsWith(pkg.name)).files)
    assert(codes(c).includes('source.clean-builds'))
  }))

test('mid-run mutation and unexecuted crash control remain blocking after initially valid proof', () =>
  using((f) => {
    const context = inspectCommitEvidence(f)
    assert.deepEqual(context.issues, [])
    const local = structuredClone(f.local)
    local.runtime.crashCases[0].executed = false
    fs.appendFileSync(path.join(f.root, 'packages/@livestore/common/src/value.js'), 'mid-run mutation')
    const verdict = finishCommitEvidence(context, local)
    assert.equal(verdict.eligible, false)
    assert(verdict.blocking.some((row) => row.code === 'local.current-gates'))
    assert(verdict.blocking.some((row) => row.code === 'source.changed-during-check'))
  }))

test('a passed-local flag cannot replace directly produced current gate records', () =>
  using((f) => {
    const context = inspectCommitEvidence(f)
    assert.deepEqual(context.issues, [])
    const local = { ...f.local, gates: [], passed: true, sourceTreeSha256: digest([]) }
    assert.equal(finishCommitEvidence(context, local).eligible, false)
  }))

test('reviewed shared metadata needs direct/transitive scope; Full Setup cannot be waived', () =>
  using((f) => {
    const file = path.join(f.root, 'package.json')
    const pkg = JSON.parse(fs.readFileSync(file, 'utf8'))
    fs.writeFileSync(file, JSON.stringify({ ...pkg, description: 'reviewed shared change' }))
    f.git(['add', '.'])
    const next = sourceState(f.root, f.manifest.source.base)
    f.manifest.source.tree = next.tree
    f.manifest.source.changed = next.changed
    f.rebind()
    const missing = f.context()
    verifyScope(missing, f.manifest)
    assert(missing.issues.some((row) => row.detail.includes('shared/direct-transitive')))
    const review = f.json({
      contract: 'livestore-fork-shared-input-v1',
      inputs: [next.tree.find((row) => row.path === 'package.json')],
      finiteSdkOnly: true,
      fullSetupRetained: true,
      affectedOwners: ['sdk', 'docs'],
      unqualifiedOwners: ['docs'],
    })
    f.manifest.source.shared = [{ path: 'package.json', review }]
    f.rebind()
    const explicit = f.context()
    verifyScope(explicit, f.manifest)
    assert.deepEqual(explicit.issues, [])
    fs.writeFileSync(path.join(f.root, 'flake.nix'), 'cannot qualify through finite lane')
    f.git(['add', '.'])
    const full = sourceState(f.root, f.manifest.source.base)
    f.manifest.source.tree = full.tree
    f.manifest.source.changed = full.changed
    f.manifest.source.excluded = full.tree.filter((row) =>
      f.manifest.source.excluded.some((old) => old.path === row.path),
    )
    f.rebind()
    const forbidden = f.context()
    verifyScope(forbidden, f.manifest)
    assert(forbidden.issues.some((row) => row.detail.includes('Full Setup domain')))
  }))

test('full candidate closure refuses root extras, support changes and a newly invented checker exemption', () =>
  using((f) => {
    const inspect = (spec = f.manifest.artifact) => {
      const c = f.context()
      verifyCandidate(c, spec)
      return c
    }
    assert.deepEqual(inspect().issues, [])
    const extra = path.join(f.manifest.artifact.root, 'unexpected-root-input.json')
    fs.writeFileSync(extra, '{}')
    assert(codes(inspect()).includes('artifact.actual-payload'))
    fs.unlinkSync(extra)
    const support = path.join(f.manifest.artifact.root, 'pnpm-workspace.yaml'),
      original = fs.readFileSync(support)
    fs.appendFileSync(support, 'changed')
    assert(codes(inspect()).includes('artifact.actual-payload'))
    fs.writeFileSync(support, original)
    const invented = path.join(f.root, 'scripts/fork-qualification/unreviewed.mjs')
    fs.writeFileSync(invented, 'export const unreviewed = true')
    const source = JSON.parse(fs.readFileSync(f.manifest.artifact.sourceInventory.path, 'utf8'))
    const state = sourceState(f.root, f.manifest.source.base)
    const spec = {
      ...f.manifest.artifact,
      compatibility: f.json({
        contract: 'livestore-fork-candidate-compatibility-v1',
        sourceSnapshotSha256: source.snapshotInventorySha256,
        currentSourceTreeSha256: digest(state.tree),
        changes: sourceCompatibility(f.root, state.tree, source.snapshotFiles),
      }),
    }
    assert(inspect(spec).issues.some((row) => row.detail.includes('Unreviewed producer/candidate context change')))
    fs.unlinkSync(invented)
    fs.appendFileSync(path.join(f.root, '.gitignore'), 'different ignore context')
    assert(codes(inspect()).includes('artifact.actual-payload'))
  }))
