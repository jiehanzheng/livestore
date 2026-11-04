import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'

import { consumerGraph, verifyConsumer } from './commit-consumer.mjs'
import { packPayload } from './commit-files.mjs'
import { makeFixture } from './commit-fixture.mjs'

const using = (run) => {
  const fixture = makeFixture()
  try {
    run(fixture)
  } finally {
    fixture.cleanup()
  }
}
const inspect = (f) => {
  const c = f.context()
  verifyConsumer(c, f.manifest.consumer)
  return c
}

test('live graph and every actual installed byte/mode are verified', () =>
  using((f) => {
    const c = inspect(f)
    assert.deepEqual(c.issues, [])
    assert.equal(c.consumer.instances.length, 12)
    assert.equal(c.consumer.payloadSha256, f.artifact.directoryIdentity)
  }))

test('a declared package sharing a Node builtin name retains its physical dependency edge', () =>
  using((f) => {
    const file = path.join(f.consumer, 'package.json')
    const pkg = JSON.parse(fs.readFileSync(file, 'utf8'))
    pkg.dependencies.punycode = '2.3.1'
    fs.writeFileSync(file, JSON.stringify(pkg))
    const owner = path.join(f.consumer, 'node_modules/punycode')
    fs.mkdirSync(owner)
    fs.writeFileSync(path.join(owner, 'package.json'), JSON.stringify({ name: 'punycode', version: '2.3.1' }))
    const graph = consumerGraph([{ root: f.consumer }])
    assert.equal(
      graph.get(fs.realpathSync(f.consumer)).edges.find((edge) => edge.name === 'punycode').root,
      fs.realpathSync(owner),
    )
    assert.equal(graph.get(fs.realpathSync(owner)).name, 'punycode')
    fs.rmSync(owner, { recursive: true })
    assert.throws(() => consumerGraph([{ root: f.consumer }]), /Unresolved required consumer dependency: punycode/)
  }))

test('historical ctime/inode changes are not portable identity: fresh content/resolution can still pass', () =>
  using((f) => {
    const before = inspect(f)
    const file = path.join(f.consumer, 'node_modules/@livestore/common/src/value.js')
    const bytes = fs.readFileSync(file)
    fs.linkSync(file, path.join(f.home, 'harmless-link'))
    fs.unlinkSync(file)
    fs.writeFileSync(file, bytes)
    fs.chmodSync(file, 0o644)
    const after = inspect(f)
    assert.deepEqual(after.issues, [])
    assert.deepEqual(after.consumer, before.consumer)
  }))

test('missing or extra actual installed file is rejected independently of a recorded fingerprint', () =>
  using((f) => {
    const root = path.join(f.consumer, 'node_modules/@livestore/common/src')
    fs.writeFileSync(path.join(root, 'unexpected.js'), 'extra')
    assert(inspect(f).issues.some((row) => row.code === 'consumer.live'))
    fs.unlinkSync(path.join(root, 'unexpected.js'))
    fs.unlinkSync(path.join(root, 'value.js'))
    assert(inspect(f).issues.some((row) => row.code === 'consumer.live'))
  }))

test('changed installed bytes or executable mode cannot pass content-only fingerprint checks', () =>
  using((f) => {
    const file = path.join(f.consumer, 'node_modules/@livestore/common/src/value.js')
    fs.chmodSync(file, 0o755)
    assert(inspect(f).issues.some((row) => row.code === 'consumer.live'))
    fs.chmodSync(file, 0o644)
    fs.appendFileSync(file, 'changed')
    assert(inspect(f).issues.some((row) => row.code === 'consumer.live'))
  }))

test('effective resolution replacement is recaptured and wrong SDK instance is rejected', () =>
  using((f) => {
    const selected = path.join(f.consumer, 'node_modules/@livestore/common')
    const alternate = path.join(f.home, 'wrong-common')
    fs.cpSync(selected, alternate, { recursive: true })
    fs.appendFileSync(path.join(alternate, 'src/value.js'), 'wrong incarnation')
    fs.rmSync(selected, { recursive: true })
    fs.symlinkSync(alternate, selected)
    assert(inspect(f).issues.some((row) => row.code === 'consumer.live'))
  }))

test('effective Effect content, version and duplicate core identity are not trusted from labels', () =>
  using((f) => {
    const core = path.join(f.consumer, 'node_modules/effect/index.js')
    const initial = fs.readFileSync(core)
    fs.appendFileSync(core, 'modified runtime')
    assert(inspect(f).issues.some((row) => row.code === 'consumer.live'))
    fs.writeFileSync(core, initial)
    const pkgFile = path.join(path.dirname(core), 'package.json')
    const initialManifest = fs.readFileSync(pkgFile)
    fs.writeFileSync(pkgFile, JSON.stringify({ name: 'effect', version: '4.1.0' }))
    assert(inspect(f).issues.some((row) => row.code === 'consumer.live'))
    fs.writeFileSync(pkgFile, initialManifest)
    const secondCore = path.join(f.consumer, 'node_modules/@livestore/common/node_modules/effect')
    fs.cpSync(path.dirname(core), secondCore, { recursive: true })
    assert(inspect(f).issues.some((row) => row.detail.includes('multiple Effect core')))
  }))

test('unresolved required edge and extra SDK owner cannot disappear from the complete traversal', () =>
  using((f) => {
    const file = path.join(f.consumer, 'package.json')
    const pkg = JSON.parse(fs.readFileSync(file, 'utf8'))
    pkg.dependencies['@livestore/unqualified'] = '*'
    fs.writeFileSync(file, JSON.stringify(pkg))
    f.manifest.consumer.inputs[0] = f.ref(file)
    assert(inspect(f).issues.some((row) => row.code === 'consumer.live'))
    const unqualified = path.join(f.consumer, 'node_modules/@livestore/unqualified')
    fs.mkdirSync(unqualified, { recursive: true })
    fs.writeFileSync(
      path.join(unqualified, 'package.json'),
      JSON.stringify({ name: '@livestore/unqualified', version: '0.0.0' }),
    )
    assert(inspect(f).issues.some((row) => row.detail.includes('Unqualified SDK family')))
  }))

test('fixed pack selection refuses lifecycle dispatch instead of executing receipt-provided code', () =>
  using((f) => {
    const root = path.join(f.manifest.artifact.root, 'packages/@livestore/common')
    const file = path.join(root, 'package.json')
    const pkg = JSON.parse(fs.readFileSync(file, 'utf8'))
    const sentinel = path.join(f.home, 'must-not-run')
    pkg.scripts = { prepack: `touch ${sentinel}` }
    fs.writeFileSync(file, JSON.stringify(pkg))
    assert.throws(() => packPayload(root, f.tools.commands.pnpm[0]), /never executes/)
    assert.equal(fs.existsSync(sentinel), false)
  }))
