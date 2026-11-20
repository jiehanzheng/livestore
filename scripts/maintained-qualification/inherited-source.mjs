import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

import { digest, hash } from '../fork-qualification/qualification-observations.mts'

export const originalBaselineTreeSha256 = '85acfde34269c3181ed53edbfc398460f681b31c44c331d60a34a35be3dc46c2'
export const canonicalBaselineTreeSha256 = '5f0c06c5f96a4fd312581511022950070db47eafdb6f87cd23d221bcbcd18d48'
export const acceptedBaselineTreeSha256 = 'e99cb8a33589d4710192cf5f625a38047f7acf95b8aa68e92f44516927c1d86a'
export const canonicalAncestorPaths = [
  '.oxfmtrc.json',
  '.oxlintrc.json',
  'pnpm-install-contract.json',
  'pnpm-workspace.yaml',
  'tests/integration/.oxlintrc.json',
  'tests/perf-eventlog/.oxlintrc.json',
  'tests/perf/.oxlintrc.json',
  'scripts/src/generated/release-topology.json',
  'docs/src/content/_assets/code/.oxlintrc.json',
]

export const trustedSupportCommit = '909bb3920451659911fab70e973decc956c0a73a'
export const trustedSupportChanges = [
  {
    path: 'scripts/fork-qualification/README.md',
    beforeSha256: '5f963ce1f84bea901a62ceb648c3b8e86aae3411260b08b1d80496261d6eda78',
    afterSha256: '284e59687e0a908141a187ae65bf5c350f42b05e2fc728b46f88672a7a3b9bfa',
    gitBlob: '05f0a352f681b5ca1302d3e2f2a7fffefcfe3350',
  },
  {
    path: 'scripts/fork-qualification/commit-source.mjs',
    beforeSha256: '664175558c02cc296ab7661acf4e7e9a8022a3c7490220add78ee75fa5de322e',
    afterSha256: '445ab4c22c2eced7fc15f3aea7338930fc2682590df8400b9dc76908f7b8c842',
    gitBlob: '7d0d686257ac0ce63ed3fe226994b0c05da51aef',
  },
  {
    path: 'scripts/fork-qualification/qualification-source-policy.mts',
    beforeSha256: '4f62b4e31b5277e82737b82c094c3e59d54aca6a812ef1b20e57f4a59f13d78c',
    afterSha256: '8843294a71dfeb74cdaf3d1a5ef7f94369ef703d720631d4d65e9d697f6bfb11',
    gitBlob: 'a2415efc862e2008027642ee51e45624b7190290',
  },
  {
    path: 'scripts/standalone/qualification-source-contract.ts',
    beforeSha256: 'a1a58ac0f781551a8de25d2b7eecd19816777fa769924fe4a53f601389e0560c',
    afterSha256: 'f9e63b4de4a21f9eb69c20037ca7f126bc695478eac03fdcffb12d12edd02031',
    gitBlob: '54f02aca66648f28cc795d9eb861918170ddf4ef',
  },
  {
    path: 'scripts/standalone/stage-source-directory.test.ts',
    beforeSha256: '0cefb66d5ee34a76543193522e49351086986762b491eae10d6896640a1b43c1',
    afterSha256: '718001e30c6ffc48afa36263960680e813f3e839c04da99f0f9221b7c68a0490',
    gitBlob: '3965e16c31bcd73167d00c9d68baf6d789881d41',
  },
]

// This transition changes only generated text from the original85 ancestor.
// Broader authored changes never become inherited inputs through this derivation.
export const canonicalAncestorTree = (original, delta) => {
  assert.deepEqual(
    delta.map((row) => row.path).sort(),
    [...canonicalAncestorPaths].sort(),
    'Canonical ancestor needs exactly nine generated paths',
  )
  const changes = new Map(delta.map((row) => [row.path, row]))
  const tree = original.map((row) => {
    const change = changes.get(row.path)
    if (change === undefined) return row
    assert.equal(row.kind, 'file', 'Canonical ancestor target must be a file')
    assert.equal(row.sha256, change.beforeSha256, 'Canonical ancestor preimage differs')
    assert.match(change.afterSha256, /^[a-f0-9]{64}$/)
    assert.notEqual(change.afterSha256, change.beforeSha256, 'Canonical ancestor delta is empty')
    changes.delete(row.path)
    return { ...row, sha256: change.afterSha256 }
  })
  assert.equal(changes.size, 0, 'Canonical ancestor target is absent')
  return tree
}

// Only these reviewed committed blobs can advance support authority. A private
// plan transports their bytes; it cannot select a different inherited snapshot.
export const supportAncestorTree = (canonical, transition) => {
  assert.equal(transition.commit, trustedSupportCommit, 'Trusted support commit differs')
  assert.deepEqual(
    transition.delta.map(({ preimage, postimage, ...change }) => change),
    trustedSupportChanges,
    'Expected exactly five trusted support changes',
  )
  const changes = new Map(transition.delta.map((change) => [change.path, change]))
  const tree = canonical.map((row) => {
    const change = changes.get(row.path)
    if (change === undefined) return row
    assert.deepEqual(
      row,
      { path: change.path, kind: 'file', executable: false, sha256: change.beforeSha256 },
      'Trusted support preimage or mode differs',
    )
    changes.delete(row.path)
    return { ...row, sha256: change.afterSha256 }
  })
  assert.equal(changes.size, 0, 'Trusted support target is absent')
  return tree
}

export const verifySupportReferences = (transition, read) => {
  for (const change of transition.delta) {
    assert.equal(change.preimage.sha256, change.beforeSha256)
    assert.equal(change.postimage.sha256, change.afterSha256)
    assert.equal(hash(read(change.preimage)), change.beforeSha256, 'Support preimage bytes differ')
    const bytes = Buffer.from(read(change.postimage))
    assert.equal(hash(bytes), change.afterSha256, 'Support postimage bytes differ')
    const blob = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')
    assert.equal(blob, change.gitBlob, 'Trusted support Git blob differs')
  }
}

export const inheritedAncestorTree = (baseline, original, read) => {
  assert.equal(baseline.sourceTreeSha256, acceptedBaselineTreeSha256, 'Accepted inherited baseline epoch differs')
  assert.equal(digest(baseline.sourceTree), acceptedBaselineTreeSha256, 'Inherited baseline content differs')
  assert.equal(baseline.contract, 'livestore-unified-inherited-ancestor-v2')
  assert.equal(baseline.originalSourceTreeSha256, originalBaselineTreeSha256)
  assert.equal(
    baseline.consumerGraphSha256,
    original.consumerGraphSha256,
    'Canonical formatting changed dependency closure',
  )
  assert.equal(original.sourceTreeSha256, originalBaselineTreeSha256, 'Original85 ancestor epoch differs')
  assert.equal(digest(original.sourceTree), originalBaselineTreeSha256, 'Original85 ancestor content differs')
  assert.equal(
    digest(canonicalAncestorTree(original.sourceTree, baseline.delta)),
    canonicalBaselineTreeSha256,
    'Canonical ancestor epoch differs',
  )
  assert.deepEqual(
    baseline.sourceTree,
    supportAncestorTree(canonicalAncestorTree(original.sourceTree, baseline.delta), baseline.supportTransition),
    'Broader changes entered inherited ancestor',
  )
  verifySupportReferences(baseline.supportTransition, read)
  for (const row of baseline.delta) {
    assert.equal(row.preimage.sha256, row.beforeSha256)
    assert.equal(row.postimage.sha256, row.afterSha256)
    read(row.preimage)
    read(row.postimage)
  }
  return baseline.sourceTree
}
