import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

import {
  array,
  compare,
  capture,
  digest,
  ensure,
  equal,
  fileVector,
  hash,
  jsonRef,
  readRef,
  resolve,
  relative,
  sourceState,
  unique,
  walkPayload,
} from './commit-files.mjs'
import { candidateCompatibilityPaths, sourceCompatibility, sdkNames } from './commit-source.mjs'

const manifest = (root) => JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
export const resolvePackage = (from, name) => {
  ensure(typeof name === 'string' && /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(name), 'Invalid dependency name')
  // A declared npm package can share a builtin name (punycode); inventory its package, not Node's builtin shortcut.
  const locations = createRequire(path.join(from, 'package.json')).resolve.paths(`${name}/`) ?? []
  for (const location of locations) {
    const candidate = path.join(location, name)
    if (fs.existsSync(path.join(candidate, 'package.json')) === true) return fs.realpathSync(candidate)
  }
  return undefined
}
const dependencies = (pkg, includeDev) => {
  const optional = { ...pkg.optionalDependencies }
  const required = { ...pkg.dependencies, ...pkg.peerDependencies, ...(includeDev === true ? pkg.devDependencies : {}) }
  for (const name of Object.keys(pkg.peerDependencies ?? {}))
    if (pkg.peerDependenciesMeta?.[name]?.optional === true) optional[name] = required[name]
  return Object.keys({ ...required, ...optional })
    .sort(compare)
    .map((name) => ({ name, optional: name in optional }))
}
export const consumerGraph = (entries) => {
  unique(entries, (row) => fs.realpathSync(row.root), 'Duplicate consumer entry root')
  const queue = entries.map((entry) => ({ root: fs.realpathSync(entry.root), dev: entry.includeDev === true }))
  const nodes = new Map()
  while (queue.length > 0) {
    const { root, dev } = queue.shift()
    const existing = nodes.get(root)
    if (existing !== undefined && (existing.dev === true || dev === false)) continue
    const pkg = manifest(root)
    ensure(typeof pkg.name === 'string', 'Consumer node lacks package identity')
    const node = {
      root,
      name: pkg.name,
      dev,
      manifestSha256: hash(fs.readFileSync(path.join(root, 'package.json'))),
      edges: [],
    }
    nodes.set(root, node)
    for (const dependency of dependencies(pkg, dev)) {
      const target = resolvePackage(root, dependency.name)
      ensure(
        target !== undefined || dependency.optional === true,
        `Unresolved required consumer dependency: ${dependency.name} from ${pkg.name} (${root})`,
      )
      node.edges.push({ name: dependency.name, root: target ?? null })
      if (target !== undefined) queue.push({ root: target, dev: false })
    }
  }
  return nodes
}
export const runtimeEffects = (graph, sdkRoots) => {
  const seen = new Set()
  const effects = new Map()
  const queue = [...sdkRoots]
  while (queue.length > 0) {
    const root = queue.shift()
    if (seen.has(root) === true) continue
    seen.add(root)
    const node = graph.get(root)
    ensure(node !== undefined, 'Incomplete consumer dependency closure')
    if (node.name === 'effect' || node.name.startsWith('@effect/') === true) effects.set(root, node)
    for (const edge of node.edges) if (edge.root !== null) queue.push(edge.root)
  }
  return effects
}
export const verifyCandidate = (context, spec) =>
  capture(context, 'artifact.actual-payload', () => {
    ensure(context.artifact !== undefined, 'No verified artifact inventory')
    const root = fs.realpathSync(resolve(context.evidenceDirectory, spec.root))
    ensure(path.basename(root) === context.sdkSourceSeal, 'Candidate is not source-addressed')
    const source = jsonRef(context, spec.sourceInventory)
    ensure(
      source.sourceInventorySha256 === context.sdkSourceSeal && digest(source.identity) === context.sdkSourceSeal,
      'Candidate authored source seal differs',
    )
    const snapshot = source.snapshotFiles
    unique(snapshot, (row) => row.path, 'Missing or duplicate complete candidate source snapshot')
    ensure(source.snapshotInventorySha256 === digest(snapshot), 'Candidate source snapshot hash differs')
    const sources = new Map(snapshot.map((row) => [relative(row.path), row]))
    const current = context.source ?? sourceState(context.root, source.baseCommit)
    const compatibility = jsonRef(context, spec.compatibility)
    ensure(
      compatibility.contract === 'livestore-fork-candidate-compatibility-v1' &&
        compatibility.sourceSnapshotSha256 === source.snapshotInventorySha256 &&
        compatibility.currentSourceTreeSha256 === digest(current.tree),
      'Candidate compatibility recipe binding differs',
    )
    const changes = sourceCompatibility(context.root, current.tree, snapshot)
    equal(changes, compatibility.changes, 'Reviewed candidate compatibility path/hash changes differ')
    ensure(
      changes.every((row) => candidateCompatibilityPaths.includes(row.path)),
      'Unreviewed producer/candidate context change',
    )
    const exceptions = new Set(changes.map((row) => row.path))
    for (const row of [...source.identity.sdkFiles, ...source.identity.supportFiles])
      ensure(sources.get(row.path)?.sha256 === row.sha256, 'SDK/support source omitted from full candidate snapshot')
    for (const row of snapshot) {
      const file = path.join(root, row.path),
        stat = fs.lstatSync(file)
      ensure(fs.realpathSync(file).startsWith(`${root}${path.sep}`), 'Candidate source escapes root')
      ensure((stat.mode & 0o777) === row.mode, 'Candidate source mode differs')
      ensure(
        (stat.isSymbolicLink() === true ? 'symlink' : stat.isFile() === true ? 'file' : 'unsupported') === row.kind,
        'Candidate source kind differs',
      )
      if (row.kind === 'symlink') ensure(fs.readlinkSync(file) === row.target, 'Candidate source link target differs')
      ensure(hash(fs.readFileSync(file)) === row.sha256, 'Candidate source bytes differ')
      if (exceptions.has(row.path) === false) {
        const producer = path.join(context.root, row.path),
          expected = fs.lstatSync(producer)
        ensure(
          expected.isSymbolicLink() === stat.isSymbolicLink() && (expected.mode & 0o111) === (stat.mode & 0o111),
          'Producer source kind/executable bits differ',
        )
        if (row.kind === 'symlink')
          ensure(fs.readlinkSync(producer) === row.target, 'Producer source link target differs')
        ensure(hash(fs.readFileSync(producer)) === row.sha256, 'Producer selection-context source bytes differ')
      }
    }
    const allowed = new Set(sources.keys())
    for (const pkg of context.artifact.packages) {
      for (const row of pkg.files) {
        const name = `packages/${pkg.name}/${relative(row.path)}`,
          authored = sources.get(name)
        if (authored !== undefined)
          ensure(
            authored.kind === 'file' && authored.sha256 === row.sha256 && authored.mode === row.mode,
            'Authored/produced candidate overlap disagrees',
          )
        allowed.add(name)
      }
      equal(
        fileVector(
          path.join(root, 'packages', pkg.name),
          pkg.files.map((row) => row.path),
        ),
        pkg.files,
        `Actual candidate selected bytes/modes differ: ${pkg.name}`,
      )
    }
    for (const ref of [spec.sourceInventory, spec.payloadInventory]) {
      const file = fs.realpathSync(resolve(context.evidenceDirectory, ref.path))
      readRef(context, ref)
      if (file.startsWith(`${root}${path.sep}`) === true) allowed.add(path.relative(root, file))
    }
    const actual = []
    const visit = (directory) => {
      for (const entry of fs.readdirSync(path.join(root, directory), { withFileTypes: true })) {
        const name = directory === '' ? entry.name : `${directory}/${entry.name}`
        if (entry.isDirectory() === true) visit(name)
        else actual.push(name)
      }
    }
    visit('')
    equal(
      actual.sort(compare),
      [...allowed].sort(compare),
      'Full candidate authored/produced union has missing or extra files',
    )
    context.candidateClosure = {
      root,
      sourceFiles: snapshot.length,
      sourceSnapshotSha256: source.snapshotInventorySha256,
      actualFiles: actual.length,
      payloadFiles: context.artifact.files,
      compatibilityChanges: changes,
    }
  })
export const verifyConsumer = (context, spec) =>
  capture(context, 'consumer.live', () => {
    ensure(context.artifact !== undefined, 'No verified SDK artifact')
    array(spec.inputs, 'Missing consumer manifest/lock bindings')
    ensure(spec.inputs.length > 0, 'Empty consumer input binding')
    for (const ref of spec.inputs) readRef(context, ref)
    array(spec.entries, 'Missing consumer entry points')
    ensure(spec.entries.length > 0, 'Empty consumer entry points')
    const entries = spec.entries.map((row) => ({ ...row, root: resolve(context.evidenceDirectory, row.root) }))
    for (const entry of entries) {
      ensure(
        spec.inputs.some(
          (ref) => resolve(context.evidenceDirectory, ref.path) === path.join(entry.root, 'package.json'),
        ),
        'Entry manifest is not bound',
      )
    }
    const graph = consumerGraph(entries)
    ensure(
      [...graph.values()].every((node) => !node.name.startsWith('@livestore/') || sdkNames.includes(node.name)),
      'Unqualified SDK family member in live graph',
    )
    const sdk = [...graph.values()].filter((node) => sdkNames.includes(node.name))
    equal(
      [...new Set(sdk.map((node) => node.name))].sort(compare),
      [...sdkNames].sort(compare),
      'Live SDK graph omits a family member',
    )
    const instances = []
    // Historical inode/ctime observations are hints, not portable identity. Always reread current content and resolution.
    for (const node of sdk) {
      const expected = context.artifact.packages.find((pkg) => pkg.name === node.name)
      equal(walkPayload(node.root), expected.files, `Installed bytes/modes/no-extra membership differ: ${node.name}`)
      instances.push({ name: node.name, root: node.root, sha256: expected.sha256 })
    }
    const effects = runtimeEffects(
      graph,
      sdk.map((node) => node.root),
    )
    unique(spec.cohort, (row) => row.name, 'Duplicate expected Effect member')
    equal(
      [...new Set([...effects.values()].map((node) => node.name))].sort(compare),
      spec.cohort.map((row) => row.name).sort(compare),
      'Effective Effect runtime closure differs',
    )
    const expectedVersion = manifest(context.root).devDependencies.effect
    ensure(
      typeof expectedVersion === 'string' && /^\d+\.\d+\.\d+$/.test(expectedVersion),
      'Root must declare the exact effective Effect version',
    )
    const coreRoots = new Set()
    for (const node of effects.values()) {
      const pkg = manifest(node.root)
      const expected = spec.cohort.find((row) => row.name === node.name)
      ensure(
        pkg.version === expectedVersion && expected.version === expectedVersion,
        'Effective runtime Effect version differs',
      )
      equal(walkPayload(node.root), expected.files, `Actual Effect member bytes/modes changed: ${node.name}`)
      const core = resolvePackage(node.root, 'effect')
      ensure(core !== undefined, 'Effect runtime lacks its core resolution')
      coreRoots.add(core)
    }
    ensure(coreRoots.size === 1, 'Runtime resolves multiple Effect core instances')
    const graphRows = [...graph.values()].sort((a, b) => a.root.localeCompare(b.root, 'en'))
    context.consumer = {
      payloadSha256: context.artifact.directoryIdentity,
      instances,
      graphDigest: digest(graphRows),
      effectCore: [...coreRoots][0],
    }
    return context.consumer
  })
export const verifyApplication = (context, application, requiredCases) => {
  capture(context, 'application.review', () => {
    const review = jsonRef(context, application.review)
    const { review: ignored, ...body } = application
    ensure(
      review.contract === 'livestore-fork-application-v1' && review.bindingSha256 === digest(body),
      'Lead acceptance review differs',
    )
    jsonRef(context, application.strategyEvidence)
  })
  const artifacts = capture(context, 'application.artifacts', () => {
    ensure(context.artifact !== undefined, 'No valid SDK artifact')
    unique(application.artifacts, (row) => row.id, 'Duplicate application artifact ID')
    for (const artifact of application.artifacts) {
      ensure(['web', 'ios'].includes(artifact.platform), 'Unknown app platform')
      ensure(
        artifact.sdkSourceSeal === context.sdkSourceSeal &&
          artifact.payloadSha256 === context.artifact.directoryIdentity,
        'Application used another SDK payload/source',
      )
      array(artifact.files, 'Missing application artifact bytes')
      ensure(artifact.files.length > 0, 'Empty application artifact')
      for (const ref of artifact.files) readRef(context, ref)
      const source = jsonRef(context, artifact.source)
      ensure(source.contract === 'livestore-application-source-v1', 'Unknown application source vector')
      unique(source.files, (row) => row.path, 'Duplicate application source entry')
      ensure(source.files.length > 0, 'Empty application source vector')
      ensure(artifact.sourceTreeSha256 === digest(source.files), 'Application source vector binding differs')
      for (const ref of source.files) readRef(context, ref)
    }
    ensure(
      ['web', 'ios'].every((platform) => application.artifacts.some((row) => row.platform === platform)),
      'Both native and web artifacts are required',
    )
    return application.artifacts
  })
  const cases = application.cases ?? []
  capture(context, 'application.case-schema', () => {
    unique(cases, (row) => row.id, 'Duplicate platform case')
    ensure(
      cases.every((row) => requiredCases.includes(row.id)),
      'Unknown or wrong-strategy platform case',
    )
  })
  for (const id of requiredCases)
    capture(context, `acceptance.${id}`, () => {
      const row = cases.find((value) => value.id === id)
      ensure(row?.status === 'pass', `Required case is absent, pending or failed: ${id}`)
      ensure(Array.isArray(row.evidence) && row.evidence.length > 0, `No actual case evidence: ${id}`)
      for (const ref of row.evidence) readRef(context, ref)
      ensure(Array.isArray(row.artifacts) && row.artifacts.length > 0, 'Case has no artifact binding')
      const platform = id.includes('ios') === true ? 'ios' : 'web'
      ensure(
        row.artifacts.every((name) =>
          artifacts?.some((artifact) => artifact.id === name && artifact.platform === platform),
        ),
        'Case artifact/platform mismatch',
      )
    })
}
