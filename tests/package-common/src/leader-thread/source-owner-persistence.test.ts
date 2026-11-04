import * as fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { describe, expect, test } from 'vitest'

import {
  MaterializationJournal,
  migrateDb,
  SqliteDbHelper,
  StateHead,
  StateSnapshot,
  StateSqliteDb,
  type SqliteDb,
  type SqliteTransactionHost,
  SqliteError,
  SyncState,
} from '@livestore/common'
import { Eventlog, LeaderPersistence, makeMaterializeEvent } from '@livestore/common/leader-thread'
import { EventSequenceNumber, LiveStoreEvent, SystemTables } from '@livestore/common/schema'
import {
  fromSyncSource,
  initializeSource,
  makeHostedSource,
  SourceContext,
  SourceEvents,
  type SourceDbError,
} from '@livestore/common/source-db'
import { loadSqlite3Wasm } from '@livestore/sqlite-wasm/load-wasm'
import { reserveNodeSource, sqliteDbFactory } from '@livestore/sqlite-wasm/node'
import { Context, Effect, Exit, Layer, Option, Semaphore } from '@livestore/utils/effect'
import { PlatformNode } from '@livestore/utils/node'

import { events, schema, tables } from './fixture.ts'

const event = LiveStoreEvent.Client.Encoded.make({
  name: events.todoCreated.name,
  args: { id: 'one', text: 'One' },
  seqNum: EventSequenceNumber.Client.Composite.make({ global: 1, client: 0, rebaseGeneration: 0 }),
  parentSeqNum: EventSequenceNumber.Client.ROOT,
  clientId: 'test',
  sessionId: 'session',
})

class NativeFrame extends Context.Service<NativeFrame, { fiberId: number; tainted: boolean }>()(
  'source-owner-persistence/NativeFrame',
) {}

const withFixture = async (
  run: (fixture: {
    persistence: LeaderPersistence.Service
    state: SqliteDb
    host: SqliteTransactionHost
    rawSourceRows: () => readonly unknown[]
    sourceRows: ReturnType<typeof SourceEvents.readPage>
    sourceHead: ReturnType<typeof Eventlog.getClientHeadFromDb>
    log: string[]
    reimport: Effect.Effect<void, SourceDbError>
    monitorReset: () => void
    frameWrites: Array<{ role: string; sql: string; insideHost: boolean }>
    failCommit: (role: 'state' | 'source' | 'host') => void
  }) => Promise<void>,
  native = false,
) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'leader-source-role-'))
  let close: Effect.Effect<void, SourceDbError> | undefined
  try {
    const fixture = await Effect.runPromise(
      Effect.gen(function* () {
        const sqlite3 = yield* Effect.promise(() => loadSqlite3Wasm())
        const makeDb = yield* sqliteDbFactory({ sqlite3 })
        const creation = reserveNodeSource(path.join(directory, 'eventlog.db'))
        const rawSource = yield* makeDb({ _tag: 'fs', directory, fileName: 'eventlog.db', sourceCreation: creation })
        const rawState = yield* makeDb({ _tag: 'in-memory' })
        const log: string[] = []
        const frameWrites: Array<{ role: string; sql: string; insideHost: boolean }> = []
        let hostActive = false
        let monitor = false
        let failRole: 'state' | 'source' | 'host' | undefined
        const observe = (db: SqliteDb, role: 'state' | 'source'): SqliteDb => ({
          ...db,
          execute: SqliteDbHelper.makeExecute((...args) => {
            if (monitor === true) frameWrites.push({ role, sql: args[0], insideHost: hostActive })
            if (args[0] === 'COMMIT') {
              log.push(`${role}-commit`)
              if (failRole === role) throw new Error(`${role} commit failed`)
            }
            if (args[0] === 'ROLLBACK') log.push(`${role}-rollback`)
            if (args[0].startsWith(`INSERT OR REPLACE INTO ${SystemTables.REBUILD_META_TABLE}`) === true)
              log.push('completion')
            return db.execute(...args)
          }),
        })
        const gate = Semaphore.makeUnsafe(1)
        const host: SqliteTransactionHost = {
          sourceNamespace: 'durable-object',
          inTransaction: Effect.gen(function* () {
            const frame = yield* Effect.serviceOption(NativeFrame)
            return Option.isSome(frame) === true && frame.value.fiberId === (yield* Effect.fiberId)
          }),
          runTransaction: (effect) =>
            Effect.gen(function* () {
              if ((yield* host.inTransaction) === true) {
                const frame = Option.getOrThrow(yield* Effect.serviceOption(NativeFrame))
                return yield* effect.pipe(
                  Effect.onExit((exit) =>
                    Effect.sync(() => {
                      if (Exit.isFailure(exit) === true) frame.tainted = true
                    }),
                  ),
                )
              }
              const fiber = yield* Effect.fiberId
              const frame = { fiberId: fiber, tainted: false }
              return yield* gate.withPermit(
                Effect.gen(function* () {
                  log.push('host-enter')
                  hostActive = true
                  const result = yield* effect.pipe(Effect.provideService(NativeFrame, frame))
                  if (frame.tainted === true) return yield* new SqliteError({ cause: 'Nested frame failed' })
                  log.push('host-commit')
                  if (failRole === 'host') throw new Error('host commit outcome unknown')
                  return result
                }).pipe(
                  Effect.ensuring(
                    Effect.sync(() => {
                      hostActive = false
                    }),
                  ),
                ),
              )
            }),
        }
        const state: SqliteDb =
          native === true ? { ...observe(rawState, 'state'), transactionHost: host } : observe(rawState, 'state')
        const source =
          native === true
            ? yield* makeHostedSource(observe(rawSource, 'source'), { host, storageName: 'native-test-source' })
            : yield* fromSyncSource(observe(rawSource, 'source'), rawSource.metadata.sourceCreation)
        const initialized = yield* initializeSource(source)
        yield* migrateDb({ db: state, schema })
        StateSnapshot.writeProvenance(state, {
          proofVersion: StateSnapshot.PROOF_VERSION,
          ownerId: 'initial',
          transitionId: 'initial',
          sourceIncarnation: initialized.identity.incarnation,
          projection: StateSnapshot.getProjectionIdentity(schema),
        })
        const base = Layer.mergeAll(StateSqliteDb.layer(state), Layer.succeed(SourceContext, source))
        const services = Layer.mergeAll(
          base,
          Layer.mergeAll(StateHead.layer, MaterializationJournal.layer).pipe(Layer.provide(base)),
        )
        const materializeEvent = yield* makeMaterializeEvent({ schema }).pipe(Effect.provide(services))
        const persistence = yield* LeaderPersistence.make({ materializeEvent, schema }).pipe(Effect.provide(services))
        log.length = 0
        close = Effect.gen(function* () {
          failRole = undefined
          yield* source.close
          rawState.close()
        })

        return {
          persistence,
          state,
          host,
          rawSourceRows: () =>
            rawSource.select(
              'SELECT seqNumGlobal,seqNumRebaseGeneration FROM eventlog ORDER BY seqNumGlobal,seqNumClient,seqNumRebaseGeneration',
            ),
          sourceRows: SourceEvents.readPage(source.handle, { includeClientOnly: true }),
          sourceHead: Eventlog.getClientHeadFromDb(source.handle),
          reimport:
            source.image === undefined
              ? Effect.die(new Error('SOURCE image unavailable'))
              : source.image.export.pipe(
                  Effect.flatMap(
                    (bytes) => source.image?.import(bytes) ?? Effect.die(new Error('SOURCE image unavailable')),
                  ),
                ),
          monitorReset: () => {
            monitor = true
            log.length = 0
          },
          frameWrites,
          log,
          failCommit: (role: 'state' | 'source' | 'host') => {
            failRole = role
          },
        }
      }).pipe(Effect.provide(PlatformNode.NodeFileSystem.layer)),
    )
    await run(fixture)
  } finally {
    if (close !== undefined) await Effect.runPromise(close)
    fs.rmSync(directory, { recursive: true, force: true })
  }
}

describe('leader persistence with canonical SOURCE', () => {
  test('materializes with its scoped SOURCE transaction and completes after STATE then SOURCE commit', async () => {
    await withFixture(async (f) => {
      const receipt = await Effect.runPromise(f.persistence.persistLocal({ events: [event] }))
      expect(receipt.stateHead).toEqual(event.seqNum)
      expect(f.state.select(tables.todos).map((row) => row.id)).toEqual(['one'])
      expect(await Effect.runPromise(f.sourceHead)).toEqual(event.seqNum)
      expect(f.log).toEqual(['state-commit', 'source-commit', 'completion'])
      expect(await Effect.runPromise(f.persistence.exportSnapshot)).toBeInstanceOf(Uint8Array)
    })
  })

  test('a failed SOURCE commit retains committed STATE with no completion proof and fences publication', async () => {
    await withFixture(async (f) => {
      f.failCommit('source')
      const result = await Effect.runPromiseExit(f.persistence.persistLocal({ events: [event] }))
      expect(Exit.isFailure(result)).toBe(true)
      expect(f.state.select(tables.todos).map((row) => row.id)).toEqual(['one'])
      expect(StateSnapshot.readProvenance(f.state)).toBeUndefined()
      expect(f.log).toEqual(['state-commit', 'source-commit'])
      expect(Exit.isFailure(await Effect.runPromiseExit(f.persistence.exportSnapshot))).toBe(true)
      expect(Exit.isFailure(await Effect.runPromiseExit(f.persistence.persistLocal({ events: [] })))).toBe(true)
    })
  })

  test('a STATE commit failure rolls back STATE and leaves SOURCE cleanup to its owner', async () => {
    await withFixture(async (f) => {
      f.failCommit('state')
      const result = await Effect.runPromiseExit(f.persistence.persistLocal({ events: [event] }))
      expect(Exit.isFailure(result)).toBe(true)
      expect(f.state.select(tables.todos)).toEqual([])
      expect(StateSnapshot.readProvenance(f.state)).toBeUndefined()
      expect(f.log).toEqual(['state-commit', 'state-rollback', 'source-rollback'])
    })
  })
  test('native shared-host SOURCE stages into one host frame without an independent SQL transaction', async () => {
    await withFixture(async (f) => {
      await Effect.runPromise(f.persistence.persistLocal({ events: [event] }))
      expect(f.state.select(tables.todos).map((row) => row.id)).toEqual(['one'])
      expect(f.log).toEqual(['host-enter', 'state-commit', 'completion', 'host-commit'])
      expect(await Effect.runPromise(f.sourceHead)).toEqual(event.seqNum)
    }, true)
  })
  test('a native host failure after staging never publishes its completed in-memory fence', async () => {
    await withFixture(async (f) => {
      f.failCommit('host')
      const result = await Effect.runPromiseExit(f.persistence.persistLocal({ events: [event] }))
      expect(Exit.isFailure(result)).toBe(true)
      expect(f.log).toEqual(['host-enter', 'state-commit', 'completion', 'host-commit'])
      expect(Exit.isFailure(await Effect.runPromiseExit(f.persistence.exportSnapshot))).toBe(true)
    }, true)
  })
  test('same-identity image import invalidates an active projection even when its head is unchanged', async () => {
    await withFixture(async (f) => {
      await Effect.runPromise(f.persistence.persistLocal({ events: [event] }))
      const proof = StateSnapshot.readProvenance(f.state)!
      await Effect.runPromise(f.reimport)
      expect(await Effect.runPromise(f.sourceHead)).toEqual(event.seqNum)
      expect(Exit.isFailure(await Effect.runPromiseExit(f.persistence.exportSnapshot))).toBe(true)
      expect(
        Exit.isFailure(
          await Effect.runPromiseExit(
            f.persistence.admitSnapshot({
              expectedProjection: StateSnapshot.getProjectionIdentity(schema),
              candidate: proof,
            }),
          ),
        ),
      ).toBe(true)
      const before = [...f.log]
      expect(Exit.isFailure(await Effect.runPromiseExit(f.persistence.persistLocal({ events: [] })))).toBe(true)
      expect(f.log).toEqual(before)
    })
  })
  test('native reset fences STATE, rotates SOURCE, and drops STATE inside one host frame', async () => {
    await withFixture(async (f) => {
      await Effect.runPromise(f.persistence.persistLocal({ events: [event] }))
      f.monitorReset()
      await Effect.runPromise(f.persistence.resetSource)
      expect(f.log).toEqual(['host-enter', 'host-commit'])
      expect(f.frameWrites.length).toBeGreaterThan(0)
      expect(f.frameWrites.every(({ insideHost }) => insideHost === true)).toBe(true)
      expect(
        f.frameWrites.some(
          ({ role, sql }) => role === 'state' && sql.startsWith(`DELETE FROM ${SystemTables.REBUILD_META_TABLE}`),
        ),
      ).toBe(true)
      expect(f.frameWrites.some(({ role, sql }) => role === 'state' && sql.startsWith('DROP TABLE "todos"'))).toBe(true)
      expect(
        f.frameWrites.some(
          ({ role, sql }) => role === 'source' && sql.startsWith(`UPDATE ${SystemTables.SOURCE_IDENTITY_TABLE}`),
        ),
      ).toBe(true)
      expect(await Effect.runPromise(f.sourceHead)).toEqual(EventSequenceNumber.Client.ROOT)
    }, true)
  })
  test('a borrowed native host frame cannot return a persistence receipt even when its refusal is caught', async () => {
    await withFixture(async (f) => {
      let received = false
      const result = await Effect.runPromiseExit(
        f.host.runTransaction(
          Effect.gen(function* () {
            const attempt = yield* Effect.exit(f.persistence.persistLocal({ events: [event] }))
            received = Exit.isSuccess(attempt)
            expect(Exit.isFailure(attempt)).toBe(true)
          }),
        ),
      )
      expect(received).toBe(false)
      expect(Exit.isFailure(result)).toBe(true)
      expect(f.state.select(tables.todos)).toEqual([])
      expect(f.log).toEqual(['host-enter'])
      expect(Exit.isFailure(await Effect.runPromiseExit(f.persistence.exportSnapshot))).toBe(true)
    }, true)
  })
  test('a borrowed native reset is refused before STATE or SOURCE writes', async () => {
    await withFixture(async (f) => {
      f.monitorReset()
      const result = await Effect.runPromiseExit(f.host.runTransaction(f.persistence.resetSource.pipe(Effect.ignore)))
      expect(Exit.isFailure(result)).toBe(true)
      expect(f.frameWrites).toEqual([])
    }, true)
  })
})

test('real upstream persistence removes obsolete generations before collision replacement and later ACK', async () => {
  await withFixture(async (f) => {
    const position = (global: number, generation = 0) =>
      EventSequenceNumber.Client.Composite.make({ global, client: 0, rebaseGeneration: generation })
    const pending = {
      ...event,
      args: { id: 'local-two', text: 'local pending' },
      seqNum: position(2),
      parentSeqNum: event.seqNum,
    }
    await Effect.runPromise(f.persistence.persistLocal({ events: [event, pending] }))
    expect((await Effect.runPromise(f.sourceRows)).map((row) => row.event)).toEqual([event, pending])
    const remote = { ...pending, args: { id: 'remote-two', text: 'remote collision' } }
    const merge = await Effect.runPromise(
      SyncState.merge({
        syncState: new SyncState.SyncState({
          pending: [pending],
          upstreamHead: event.seqNum,
          localHead: pending.seqNum,
        }),
        payload: SyncState.PayloadUpstreamAdvance.make({ newEvents: [remote] }),
        isClientOnlyEvent: () => false,
        isEqualEvent: LiveStoreEvent.Client.isEqualEncoded,
        ignoreClientOnlyEvents: true,
      }),
    )
    expect(merge._tag).toBe('rebase')
    if (merge._tag !== 'rebase') throw new Error('Expected collision rebase')
    const rebased = merge.newSyncState.pending[0]!
    expect(rebased.seqNum).toEqual(position(3, 1))
    await Effect.runPromise(
      f.persistence.persistUpstream({
        pulledEvents: [{ event: remote, syncMetadata: Option.none() }],
        events: merge.newEvents,
        rollbackEvents: merge.rollbackEvents,
        confirmedEvents: [],
        backendHead: remote.seqNum,
      }),
    )
    expect((await Effect.runPromise(f.sourceRows)).map((row) => row.event)).toEqual([event, remote, rebased])
    const remoteAgain = {
      ...remote,
      args: { id: 'remote-three', text: 'second collision' },
      seqNum: position(3),
      parentSeqNum: remote.seqNum,
    }
    const second = await Effect.runPromise(
      SyncState.merge({
        syncState: merge.newSyncState,
        payload: SyncState.PayloadUpstreamAdvance.make({ newEvents: [remoteAgain] }),
        isClientOnlyEvent: () => false,
        isEqualEvent: LiveStoreEvent.Client.isEqualEncoded,
        ignoreClientOnlyEvents: true,
      }),
    )
    if (second._tag !== 'rebase') throw new Error('Expected second generation collision')
    await Effect.runPromise(
      f.persistence.persistUpstream({
        pulledEvents: [{ event: remoteAgain, syncMetadata: Option.none() }],
        events: second.newEvents,
        rollbackEvents: second.rollbackEvents,
        confirmedEvents: [],
        backendHead: remoteAgain.seqNum,
      }),
    )
    const finalPending = second.newSyncState.pending[0]!
    expect(f.rawSourceRows()).toEqual([
      { seqNumGlobal: 1, seqNumRebaseGeneration: 0 },
      { seqNumGlobal: 2, seqNumRebaseGeneration: 0 },
      { seqNumGlobal: 3, seqNumRebaseGeneration: 0 },
      { seqNumGlobal: 4, seqNumRebaseGeneration: 1 },
    ])
    const beforeAck = await Effect.runPromise(f.sourceRows)
    expect(beforeAck.map((row) => row.event)).toEqual([event, remote, remoteAgain, finalPending])
    expect(
      beforeAck.filter((row) => row.event.seqNum.global === 3).map((row) => row.event.seqNum.rebaseGeneration),
    ).toEqual([0])
    const ackEvent = LiveStoreEvent.Client.fromGlobal(LiveStoreEvent.Client.toGlobal(finalPending))
    const ack = await Effect.runPromise(
      SyncState.merge({
        syncState: second.newSyncState,
        payload: SyncState.PayloadUpstreamAdvance.make({ newEvents: [ackEvent] }),
        isClientOnlyEvent: () => false,
        isEqualEvent: LiveStoreEvent.Client.isEqualEncoded,
        ignoreClientOnlyEvents: true,
      }),
    )
    expect(ack._tag).toBe('advance')
    if (ack._tag !== 'advance') throw new Error('Expected later ACK')
    expect(ack.confirmedEvents).toEqual([finalPending])
    await Effect.runPromise(
      f.persistence.persistUpstream({
        pulledEvents: [{ event: ackEvent, syncMetadata: Option.some({ acknowledged: true }) }],
        events: ack.newEvents,
        rollbackEvents: [],
        confirmedEvents: ack.confirmedEvents,
        backendHead: ackEvent.seqNum,
      }),
    )
    const after = await Effect.runPromise(f.sourceRows)
    expect(after.map((row) => row.event)).toEqual(beforeAck.map((row) => row.event))
    expect(after[3]!.syncMetadata).toEqual(Option.some({ acknowledged: true }))
  })
})
