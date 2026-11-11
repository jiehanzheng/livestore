import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

import { Schema } from '@livestore/utils/effect'

import {
  digest,
  fileVector,
  hash,
  relative,
  sourceState,
  toolInputs,
} from '../fork-qualification/qualification-observations.mts'
import { inspectQualification, same, type StageArguments } from './qualification-source-contract.ts'

export { inspectQualification, producerPaths, type StageArguments } from './qualification-source-contract.ts'

const contains = (parent: string, child: string): boolean => {
  const name = path.relative(parent, child)
  return name === '' || (name !== '..' && name.startsWith(`..${path.sep}`) === false && path.isAbsolute(name) === false)
}
type ReceiptOperations = Pick<typeof fs, 'openSync' | 'writeFileSync' | 'closeSync'>

export const stageQualification = (args: StageArguments, receiptOperations: ReceiptOperations = fs) => {
  const output = path.join(fs.realpathSync(path.dirname(args.output)), path.basename(args.output))
  const receipt = path.join(fs.realpathSync(path.dirname(args.receipt)), path.basename(args.receipt))
  assert.equal(fs.lstatSync(output, { throwIfNoEntry: false }), undefined, 'Never replace an immutable output')
  assert.equal(fs.lstatSync(receipt, { throwIfNoEntry: false }), undefined, 'Never replace evidence')
  const plan = inspectQualification(args)
  assert.equal(path.basename(output), plan.seal, 'Output must be source-addressed')
  assert.equal(contains(plan.root, output), false, 'Output must be outside source context')
  assert.equal(contains(output, receipt), false, 'Receipt must remain outside immutable union')
  const sourceRows = [
    ...plan.state.tree,
    ...plan.external.tree.map((row) => ({ ...row, path: `${plan.manifest.external.root}/${row.path}` })),
  ]
  assert.equal(new Set(sourceRows.map((row) => row.path)).size, sourceRows.length, 'Duplicate authored source path')
  const sources = sourceRows.map((row) => {
    const source = path.join(plan.root, relative(row.path))
    return {
      path: row.path,
      kind: row.kind,
      mode: fs.lstatSync(source).mode & 0o777,
      sha256: hash(fs.readFileSync(source)),
      ...(row.kind === 'symlink' ? { target: fs.readlinkSync(source) } : {}),
    }
  })
  const union = new Map(sources.map((row) => [row.path, row]))
  for (const pkg of plan.payload.packages)
    for (const row of pkg.files) {
      const name = `packages/${pkg.name}/${relative(row.path)}`
      const produced: (typeof sources)[number] = { path: name, kind: 'file', mode: row.mode, sha256: row.sha256 }
      const previous = union.get(name)
      if (previous !== undefined) same(previous, produced, 'Source/output overlap differs')
      else union.set(name, produced)
    }
  for (const reserved of ['candidate-source-inventory.json', 'candidate-artifact-inventory.json']) {
    assert.equal(union.has(reserved), false, 'Source uses reserved inventory path')
  }
  for (const row of union.values())
    if (row.kind === 'symlink') {
      assert(row.target !== undefined)
      // Absolute source-local links would point back into mutable source after copying.
      assert.equal(path.isAbsolute(row.target), false, 'Qualification links must be relocatable')
      assert.equal(
        contains(output, path.resolve(output, path.dirname(row.path), row.target)),
        true,
        'Qualification link escapes union',
      )
    }
  fs.mkdirSync(output)
  let descriptor: number | undefined
  let closeAttempted = false
  let createdReceipt = false
  const retain = (primary: unknown, secondary: unknown[] = []): never => {
    throw new AggregateError(
      [primary, ...secondary],
      `Qualification cleanup unsettled; retained output=${output}, receipt=${receipt}, descriptor=${descriptor}`,
      { cause: primary },
    )
  }
  try {
    for (const row of union.values()) {
      const destination = path.join(output, relative(row.path))
      fs.mkdirSync(path.dirname(destination), { recursive: true })
      if (row.kind === 'symlink') {
        assert(row.target !== undefined)
        fs.symlinkSync(row.target, destination)
      } else {
        fs.copyFileSync(path.join(plan.root, row.path), destination)
        fs.chmodSync(destination, row.mode)
      }
    }
    for (const row of union.values()) {
      const destination = path.join(output, row.path)
      assert.equal(contains(output, fs.realpathSync(destination)), true, 'Source link escapes output')
      assert.equal(fs.lstatSync(destination).mode & 0o777, row.mode, 'Copied mode differs')
      assert.equal(hash(fs.readFileSync(destination)), row.sha256, 'Copied bytes differ')
    }
    for (const pkg of plan.payload.packages) {
      same(
        fileVector(
          path.join(output, 'packages', pkg.name),
          pkg.files.map((row) => row.path),
        ),
        pkg.files,
        'Actual output vector differs',
      )
    }
    const snapshotHash: string = digest(sources)
    const sourceInventory = {
      identity: plan.identity,
      sourceInventorySha256: plan.seal,
      baseCommit: args.sourceBase,
      snapshotFiles: sources,
      snapshotInventorySha256: snapshotHash,
      qualificationOnly: true,
    }
    fs.writeFileSync(
      path.join(output, 'candidate-source-inventory.json'),
      `${JSON.stringify(sourceInventory, null, 2)}\n`,
    )
    fs.writeFileSync(
      path.join(output, 'candidate-artifact-inventory.json'),
      `${JSON.stringify(plan.payload, null, 2)}\n`,
    )
    const actualNames: string[] = []
    const visit = (directory: string) => {
      for (const entry of fs.readdirSync(path.join(output, directory), { withFileTypes: true })) {
        const name = directory === '' ? entry.name : `${directory}/${entry.name}`
        if (entry.isDirectory() === true) visit(name)
        else actualNames.push(name)
      }
    }
    visit('')
    same(
      actualNames.sort(),
      [...union.keys(), 'candidate-source-inventory.json', 'candidate-artifact-inventory.json'].sort(),
      'Immutable union membership differs',
    )
    same(sourceState(plan.root, args.sourceBase).tree, plan.state.tree, 'Source changed during materialization')
    same(
      sourceState(plan.externalRoot, plan.manifest.external.base).tree,
      plan.external.tree,
      'Generator changed during materialization',
    )
    const result = {
      contract: 'livestore-fork-local-qualification-directory-v1',
      qualificationOnly: true,
      commitEligible: false,
      independentReproduction: false,
      root: output,
      sourceSeal: plan.seal,
      sourceSnapshotSha256: snapshotHash,
      inputManifestSha256: plan.manifestSha256,
      payloadDirectoryIdentity: plan.payload.directoryIdentity,
      closure: plan.closure,
    }
    descriptor = receiptOperations.openSync(receipt, 'wx')
    createdReceipt = true
    receiptOperations.writeFileSync(descriptor, `${JSON.stringify(result, null, 2)}\n`)
    closeAttempted = true
    receiptOperations.closeSync(descriptor)
    descriptor = undefined
    for (const [file, expected] of plan.references) {
      assert.equal(hash(fs.readFileSync(file)), expected, 'Qualification input changed during materialization')
    }
    assert.equal(digest(toolInputs(plan.tools)), plan.toolInputsSha256, 'Actual tool inputs changed before publication')
    same(sourceState(plan.root, args.sourceBase).tree, plan.state.tree, 'Receipt must not change authored source')
    return result
  } catch (primary) {
    // A failed close may already have closed/reused the FD. Never retry it or remove
    // its artifacts while ownership is uncertain; the caller must observe settlement.
    if (descriptor !== undefined) {
      if (closeAttempted === true) retain(primary)
      try {
        closeAttempted = true
        receiptOperations.closeSync(descriptor)
        descriptor = undefined
      } catch (closeError) {
        retain(primary, [closeError])
      }
    }
    if (createdReceipt === true) {
      try {
        fs.unlinkSync(receipt)
      } catch (cleanupError) {
        retain(primary, [cleanupError])
      }
    }
    try {
      fs.rmSync(output, { recursive: true })
    } catch (cleanupError) {
      retain(primary, [cleanupError])
    }
    throw primary
  }
}

if (process.argv[1] !== undefined && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const { values } = parseArgs({
    options: {
      'source-root': { type: 'string' },
      'source-base': { type: 'string' },
      'source-snapshot': { type: 'string' },
      'source-patch': { type: 'string' },
      'build-receipt': { type: 'string' },
      output: { type: 'string' },
      receipt: { type: 'string' },
    },
  })
  const get = (value: unknown, name: string): string => {
    assert.equal(typeof value, 'string', `Missing --${name}`)
    return Schema.decodeUnknownSync(Schema.String)(value)
  }
  console.log(
    JSON.stringify(
      stageQualification({
        sourceRoot: get(values['source-root'], 'source-root'),
        sourceBase: get(values['source-base'], 'source-base'),
        sourceSnapshot: get(values['source-snapshot'], 'source-snapshot'),
        sourcePatch: get(values['source-patch'], 'source-patch'),
        buildReceipt: get(values['build-receipt'], 'build-receipt'),
        output: get(values.output, 'output'),
        receipt: get(values.receipt, 'receipt'),
      }),
    ),
  )
}
