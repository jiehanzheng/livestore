import nativeFs from 'node:fs'
import fs from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import os from 'node:os'
import path from 'node:path'

import { expect, test, vi } from 'vitest'

import { SqliteDbHelper } from '@livestore/common'
import { SystemTables } from '@livestore/common/schema'
import { fromSyncSource, initializeSource } from '@livestore/common/source-db'
import {
  captureSource,
  SourceMaintenanceError,
  type ApplicationBinding,
  type CaptureChunk,
  type CaptureSink,
  type ClosedCaptureReceipt,
  type SourceMaintenanceLocationOwner,
  type SourceRecoveryRow,
} from '@livestore/common/source-maintenance'
import { loadSqlite3Wasm } from '@livestore/sqlite-wasm/load-wasm'
import {
  reserveNodeSource,
  sqliteDbFactory,
  type MakeNodeSqliteDb,
  type NodeDatabaseInput,
  type NodeDatabaseMetadata,
} from '@livestore/sqlite-wasm/node'
import { Effect, Exit } from '@livestore/utils/effect'
import { PlatformNode } from '@livestore/utils/node'

import { makeNodeSourceMaintenanceOpener } from './source-maintenance.ts'

const binding: ApplicationBinding = {
  operationId: 'closed-capture',
  context: { installation: 'private-fixture', replica: 'graph' },
}
const limits = { maxRows: 100, maxBytes: 100_000, maxRowBytes: 10_000, pageSize: 1 }
type Failure = 'none' | 'sink' | 'commit' | 'close' | 'release'
const rows = (): SourceRecoveryRow[] => {
  const row = (global: number, client: number, generation: number, argsJson: string): SourceRecoveryRow => ({
    seqNumGlobal: global,
    seqNumClient: client,
    seqNumRebaseGeneration: generation,
    parentSeqNumGlobal: global - 1,
    parentSeqNumClient: 0,
    parentSeqNumRebaseGeneration: 0,
    name: client === 0 ? 'unknown-shared-event-v1' : 'unknown-local-event-v3',
    argsJson,
    clientId: 'original-client',
    sessionId: 'original-session',
    schemaHash: 17,
    syncMetadataJson: ` ${SystemTables.encodedSyncMetadataNone()} `,
  })
  return [
    row(1, 0, 0, ' { "actionId" : "reused", "value" : 1 } '),
    row(1, 0, 2, '{"value":1,"actionId":"reused"}'),
    row(2, 0, 0, '{"actionId":"reused","value":2}'),
    row(2, 1, 0, '[1,{"opaque":true}]'),
  ]
}
const withFixture = async (
  failure: Failure,
  head: number,
  run: (fixture: Awaited<ReturnType<typeof setup>>) => Promise<void>,
) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'node-capture-'))
  let cleanup: (() => void) | undefined
  try {
    const fixture = await setup(directory, failure, head)
    cleanup = fixture.cleanup
    await run(fixture)
  } finally {
    cleanup?.()
    vi.restoreAllMocks()
    syncBuiltinESMExports()
    await fs.rm(directory, { recursive: true, force: true })
  }
}
const setup = async (directory: string, failure: Failure, head: number) => {
  const sqlite3 = await loadSqlite3Wasm()
  const make = await Effect.runPromise(
    sqliteDbFactory({ sqlite3 }).pipe(Effect.provide(PlatformNode.NodeFileSystem.layer)),
  )
  const fileName = 'eventlog.db',
    file = path.join(directory, fileName)
  const native = await Effect.runPromise(
    make({ _tag: 'fs', directory, fileName, sourceCreation: reserveNodeSource(file) }),
  )
  const source = await Effect.runPromise(fromSyncSource(native, native.metadata.sourceCreation))
  const expected = rows()
  try {
    await Effect.runPromise(initializeSource(source))
    await Effect.runPromise(
      source.write((tx) =>
        Effect.gen(function* () {
          for (const row of expected) {
            const columns = Object.keys(row)
            yield* tx.execute(
              `INSERT INTO eventlog (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`,
              Object.values(row),
            )
          }
          yield* tx.execute('UPDATE __livestore_sync_status SET head = ?, backendId = ?', [head, 'old-backend'])
        }),
      ),
    )
  } finally {
    await Effect.runPromise(source.close)
  }
  const before = await fs.readFile(file)
  const events: string[] = [],
    chunks: CaptureChunk[] = [],
    seals: ClosedCaptureReceipt[] = []
  let held = false,
    joined = false,
    released = false,
    opens = 0
  let retainedFd: number | undefined, failedFd: number | undefined
  const openSync = nativeFs.openSync,
    closeSync = nativeFs.closeSync
  if (failure === 'close') {
    vi.spyOn(nativeFs, 'openSync').mockImplementation((name, flags, mode) => {
      const fd = openSync(name, flags, mode)
      if (name === file) retainedFd = fd
      return fd
    })
    vi.spyOn(nativeFs, 'closeSync').mockImplementation((fd) => {
      if (fd === retainedFd && failedFd === undefined) {
        failedFd = fd
        throw new Error('injected actual NodeFS descriptor close failure')
      }
      closeSync(fd)
    })
    // NodeFS uses named ESM bindings; synchronize the controlled native fault into those builtin exports.
    syncBuiltinESMExports()
  }
  // The test application owns a unique location. These observations are not an OS-lock claim or an opener bool.
  const locationOwner: SourceMaintenanceLocationOwner = {
    run: (context, effect) =>
      Effect.gen(function* () {
        expect(context).toEqual({ purpose: 'capture', binding })
        held = true
        events.push('location-enter')
        const result = yield* Effect.exit(effect)
        if (joined === true && failure !== 'release') {
          held = false
          released = true
          events.push('location-released')
        } else events.push('location-retained')
        if (failure === 'release')
          return yield* Effect.fail(new SourceMaintenanceError('location-release', 'release failed'))
        if (Exit.isFailure(result) === true) return yield* Effect.failCause(result.cause)
        return result.value
      }),
  }
  const makeSqliteDb: MakeNodeSqliteDb = <
    TInput extends NodeDatabaseInput,
    TMetadata extends NodeDatabaseMetadata & { _tag: TInput['_tag'] } = NodeDatabaseMetadata & { _tag: TInput['_tag'] },
  >(
    input: TInput,
  ) => {
    expect(held).toBe(true)
    expect(input).toMatchObject({ _tag: 'fs', fileName, create: false })
    expect(input).not.toHaveProperty('sourceCreation')
    opens++
    return make<TInput, TMetadata>(input).pipe(
      Effect.map((db) => ({
        ...db,
        execute: SqliteDbHelper.makeExecute((...args) => {
          const result = db.execute(...args)
          if (failure === 'commit' && args[0] === 'COMMIT') throw new Error('actual COMMIT acknowledgement failed')
          return result
        }),
        close: () => {
          expect(held).toBe(true)
          events.push('source-close-start')
          db.close()
          joined = true
          events.push('source-close-joined')
        },
      })),
    )
  }
  const opener = makeNodeSourceMaintenanceOpener({ binding, locationOwner, directory, fileName, makeSqliteDb })
  const sink: CaptureSink = {
    begin: (header) =>
      Effect.sync(() => {
        expect(held).toBe(true)
        expect(joined).toBe(false)
        expect(header.backendId).toBe('old-backend')
        expect(header.acknowledgedHead).toBe(head)
        events.push('begin')
      }),
    chunk: (chunk) =>
      Effect.suspend(() => {
        expect(held).toBe(true)
        expect(joined).toBe(false)
        events.push(`chunk-${chunk.index}`)
        if (failure === 'sink') return Effect.fail(new SourceMaintenanceError('staging-sink', 'chunk refused'))
        chunks.push({ ...chunk, rows: chunk.rows.map((row) => ({ ...row })) })
        return Effect.void
      }),
    seal: (receipt) =>
      Effect.sync(() => {
        expect(joined).toBe(true)
        expect(released).toBe(true)
        expect(held).toBe(false)
        events.push('seal')
        seals.push(receipt)
      }),
  }
  return {
    request: { opener, binding, limits, provenance: { cohort: 'opaque-definitions' }, sink },
    expected,
    events,
    chunks,
    seals,
    file,
    before,
    directory,
    state: () => ({ held, joined, released, opens }),
    failedClose: () => failedFd !== undefined,
    cleanup: () => {
      if (failedFd !== undefined) closeSync(failedFd)
    },
  }
}

test('capture stages every raw occurrence and seals after joined SOURCE close and location release', async () =>
  withFixture('none', 1, async (f) => {
    const receipt = await Effect.runPromise(captureSource(f.request))
    expect(f.chunks.flatMap((chunk) => chunk.rows)).toEqual(f.expected)
    expect(f.chunks.map((chunk) => chunk.index)).toEqual([0, 1, 2, 3])
    expect(receipt.snapshot.rows).toBe(4)
    expect(receipt.coverage).toMatchObject({ acknowledgedHead: 1, provenThrough: 1, status: 'complete' })
    expect(receipt.captureDigest).toMatch(/^[a-f0-9]{64}$/)
    expect(f.events).toEqual([
      'location-enter',
      'begin',
      'chunk-0',
      'chunk-1',
      'chunk-2',
      'chunk-3',
      'source-close-start',
      'source-close-joined',
      'location-released',
      'seal',
    ])
    expect(f.seals).toEqual([receipt])
    expect(f.state().opens).toBe(1)
    expect(await fs.readdir(f.directory)).toEqual(['eventlog.db'])
    expect(await fs.readFile(f.file)).toEqual(f.before)
  }))

test('incomplete prefix reports its limit while retaining every uncertain and local occurrence', async () =>
  withFixture('none', 3, async (f) => {
    const receipt = await Effect.runPromise(captureSource(f.request))
    expect(receipt.coverage).toMatchObject({ acknowledgedHead: 3, provenThrough: 2, status: 'incomplete' })
    expect(receipt.coverage.reason).toContain('3')
    expect(f.chunks.flatMap((chunk) => chunk.rows)).toEqual(f.expected)
    expect(f.seals).toHaveLength(1)
    expect(await fs.readFile(f.file)).toEqual(f.before)
  }))

for (const failure of ['sink', 'commit', 'close', 'release'] as const)
  test(`${failure} failure never seals staged capture`, async () =>
    withFixture(failure, 1, async (f) => {
      const result = await Effect.runPromiseExit(captureSource(f.request))
      if (failure === 'close') expect(f.failedClose()).toBe(true)
      expect(Exit.isFailure(result)).toBe(true)
      expect(f.seals).toEqual([])
      expect(f.events).not.toContain('seal')
      if (failure !== 'sink') expect(f.chunks.flatMap((chunk) => chunk.rows)).toEqual(f.expected)
      if (failure === 'close') {
        expect(f.failedClose()).toBe(true)
        expect(f.state()).toMatchObject({ joined: false, released: false, held: true })
      }
      if (failure === 'release') expect(f.state()).toMatchObject({ joined: true, released: false, held: true })
      expect(f.state().opens).toBe(1)
      expect(await fs.readFile(f.file)).toEqual(f.before)
      expect(await fs.readdir(f.directory)).toEqual(['eventlog.db'])
    }))
