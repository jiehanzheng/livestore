import fs from 'node:fs'
import path from 'node:path'

import { verifyApplication, verifyCandidate, verifyConsumer } from './commit-consumer.mjs'
import {
  array,
  capture,
  digest,
  ensure,
  equal,
  hash,
  object,
  packPayload,
  readRef,
  sourceState,
  toolInputs,
} from './commit-files.mjs'
import { requiredGates, verifyArtifact, verifyBuilds, verifyScope } from './commit-source.mjs'
import { assertRuntimeSummary } from './qualification-runtime.mjs'

const commonCases = [
  'web.local-persistence',
  'ios.local-persistence',
  'web.multicontext-offline-recovery',
  'web.physical-close-exclusive-handle',
  'ios.native-close-authority',
]
export const requiredCases = (strategy) => [
  ...commonCases,
  ...(strategy === 'fresh-preserve-old' ? ['compatibility.old-files-web', 'compatibility.old-files-ios'] : []),
  ...(strategy === 'continuous' ? ['web.old-pending-continuity', 'ios.old-pending-continuity'] : []),
]
const keys = (value, names, message) => {
  object(value, message)
  ensure(
    Object.keys(value).every((key) => names.includes(key)),
    `${message}: unknown field`,
  )
  ensure(
    names.every((key) => key in value),
    `${message}: missing field`,
  )
}
const validateShape = (manifest) => {
  keys(
    manifest,
    ['contract', 'authority', 'source', 'tools', 'artifact', 'consumer', 'application'],
    'Evidence manifest',
  )
  ensure(manifest.contract === 'livestore-fork-commit-evidence-v1', 'Unsupported evidence contract')
  keys(manifest.authority, ['proposalSha256', 'review'], 'Authority')
  keys(manifest.source, ['base', 'tree', 'changed', 'excluded', 'shared', 'external', 'builds'], 'Source scope')
  keys(manifest.tools, ['specSha256', 'inputs'], 'Tools')
  keys(manifest.artifact, ['root', 'sourceInventory', 'payloadInventory', 'compatibility'], 'Artifact')
  keys(manifest.consumer, ['entries', 'inputs', 'cohort'], 'Consumer')
  keys(manifest.application, ['strategy', 'strategyEvidence', 'review', 'artifacts', 'cases', 'limits'], 'Application')
  ensure(
    ['fresh-preserve-old', 'continuous'].includes(manifest.application.strategy),
    'Explicit supported compatibility strategy required',
  )
  for (const name of ['tree', 'changed', 'excluded', 'shared', 'builds'])
    array(manifest.source[name], `Source ${name} must be an array`)
  array(manifest.application.limits, 'Application limits must remain explicit')
  for (const row of manifest.application.cases) {
    keys(row, ['id', 'status', 'evidence', 'artifacts'], 'Acceptance case')
    ensure(['pass', 'pending', 'fail'].includes(row.status), 'Ambiguous acceptance status')
  }
}
export const inspectCommitEvidence = ({ root, tools, evidenceFile }) => {
  const context = {
    root,
    tools,
    evidenceDirectory: evidenceFile !== undefined ? path.dirname(path.resolve(evidenceFile)) : root,
    issues: [],
    references: new Map(),
    manifest: undefined,
  }
  const manifest = capture(context, 'evidence.schema', () => {
    ensure(
      typeof evidenceFile === 'string' && evidenceFile.length > 0,
      'A root-reviewed --evidence manifest is required',
    )
    const bytes = fs.readFileSync(evidenceFile)
    context.references.set(path.resolve(evidenceFile), hash(bytes))
    const value = JSON.parse(bytes)
    validateShape(value)
    return value
  })
  if (manifest === undefined) {
    for (const id of commonCases)
      context.issues.push({ code: `acceptance.${id}`, detail: 'Required typed, source-matched proof unavailable' })
    return context
  }
  context.manifest = manifest
  verifyScope(context, manifest)
  verifyArtifact(context, manifest)
  verifyCandidate(context, manifest.artifact)
  verifyBuilds(context, manifest, (root) => packPayload(root, tools.commands.pnpm[0]))
  verifyConsumer(context, manifest.consumer)
  verifyApplication(context, manifest.application, requiredCases(manifest.application.strategy))
  context.initialConsumer = context.consumer
  return context
}
export const finishCommitEvidence = (context, local) => {
  if (context.manifest === undefined || context.issues.length > 0) return commitVerdict(context)
  const { manifest } = context
  capture(context, 'local.current-gates', () => {
    ensure(
      local.contract === 'livestore-fork-local-qualification-v1' && local.root === context.root,
      'Current local qualification required',
    )
    equal(
      local.gates.map((row) => row.name),
      requiredGates,
      'Missing current local gate',
    )
    for (const gate of local.gates) {
      ensure(gate.exitCode === 0 && gate.joined === true, 'Failed or unjoined local gate')
      readRef(context, gate.log)
    }
    ensure(local.sourceTreeSha256 === digest(manifest.source.tree), 'Current gates tested another recipe')
    ensure(
      local.externalTreeSha256 === digest(manifest.source.external.tree),
      'Current gates used another generator source',
    )
    ensure(local.toolInputsSha256 === digest(manifest.tools.inputs), 'Current gates used different tools')
    ensure(local.sdkSourceSeal === context.sdkSourceSeal, 'Current gates used another SDK')
    assertRuntimeSummary(local.runtime)
  })
  capture(context, 'source.changed-during-check', () => {
    const current = sourceState(context.root, manifest.source.base)
    equal(current.tree, context.source.tree, 'Source changed while gates ran')
    ensure(current.indexDigest === context.source.indexDigest, 'Index changed while gates ran')
    ensure(current.physicalDigest === context.source.physicalDigest, 'Source mutated while gates consumed it')
    equal(toolInputs(context.tools), manifest.tools.inputs, 'Tool bytes/modes changed while gates ran')
    const external = sourceState(path.join(context.root, manifest.source.external.root), manifest.source.external.base)
    equal(external.tree, manifest.source.external.tree, 'Generator source changed during checks')
  })
  verifyConsumer(context, manifest.consumer)
  capture(context, 'consumer.changed-during-check', () =>
    equal(context.consumer, context.initialConsumer, 'Consumer content or effective resolution changed during checks'),
  )
  for (const [file, expected] of context.references)
    capture(context, 'evidence.changed-during-check', () => {
      ensure(hash(fs.readFileSync(file)) === expected, `Referenced evidence changed: ${file}`)
    })
  context.completed = context.issues.length === 0
  return commitVerdict(context)
}
export const commitVerdict = (context) => ({
  contract: 'livestore-fork-commit-decision-v1',
  eligible: context.completed === true && context.issues.length === 0,
  blocking: context.issues,
  sdkSourceSeal: context.sdkSourceSeal ?? null,
  payloadSha256: context.artifact?.directoryIdentity ?? null,
  candidateClosure: context.candidateClosure ?? null,
  liveConsumer: context.consumer ?? null,
  meaning:
    'Conditional scoped eligibility only. No staging, commit, publication, full V1 or app mutation is performed.',
})
