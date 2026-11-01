import { expect } from 'vitest'

import type { SourceIdentity } from '@livestore/common'
import { type BootStatus, type SqliteDb, makeMockSyncBackend, SqliteDbHelper } from '@livestore/common'
import { Eventlog, LeaderPersistence, makeMaterializeEvent, recreateDb } from '@livestore/common/leader-thread'
import { EventSequenceNumber, LiveStoreEvent, SystemTables } from '@livestore/common/schema'
import { createStore, StoreInternalsSymbol } from '@livestore/livestore'
import { loadSqlite3Wasm } from '@livestore/sqlite-wasm/load-wasm'
import { sqliteDbFactory } from '@livestore/sqlite-wasm/node'
import { Vitest } from '@livestore/utils-dev/node-vitest'
import {
  Deferred,
  Effect,
  Exit,
  FetchHttpClient,
  FileSystem,
  Layer,
  Option,
  Queue,
  Stream,
} from '@livestore/utils/effect'
import { PlatformNode } from '@livestore/utils/node'

import { events, makeSqliteServicesLayer, schema, tables } from '../leader-thread/fixture.ts'
import { makeTestAdapter } from '../test-adapter.ts'

for (const owner of ['ongoing', 'restarted'] as const) {
  Vitest.live(`reconciles a delayed pre-fence snapshot with ${owner} source before later events`, (test) =>
    Effect.gen(function* () {
      const sqlite3 = yield* Effect.promise(() => loadSqlite3Wasm())
      const makeSqliteDb = yield* sqliteDbFactory({ sqlite3 })
      const fs = yield* FileSystem.FileSystem
      const directory = yield* fs.makeTempDirectoryScoped()
      const open = (fileName: string) =>
        Effect.acquireRelease(makeSqliteDb({ _tag: 'fs', directory, fileName }), (db) => Effect.sync(() => db.close()))
      const base = todo('base', 1, 0)
      const original = todo('pending', 2, 0)
      const competing = LiveStoreEvent.Client.Encoded.make({
        ...todo('remote', 2, 0),
        clientId: 'peer',
        sessionId: 'peer',
      })
      const replacement = LiveStoreEvent.Client.Encoded.make({
        ...original,
        seqNum: EventSequenceNumber.Client.Composite.make({ global: 3, client: 0, rebaseGeneration: 1 }),
        parentSeqNum: competing.seqNum,
      })
      const captured = yield* Effect.gen(function* () {
        const dbState = yield* open('state.db')
        const rawEventlog = yield* open('eventlog.db')
        let armed = false
        const dbEventlog = {
          ...rawEventlog,
          execute: SqliteDbHelper.makeExecute((...args) => {
            rawEventlog.execute(...args)
            if (armed === true && args[0] === 'COMMIT')
              throw new Error('Source committed before completion marker restoration')
          }),
        }
        yield* Eventlog.initEventlogDb(dbEventlog, { sourceIsNew: true })
        const services = makeSqliteServicesLayer({ dbState, dbEventlog })
        const materializeEvent = yield* makeMaterializeEvent({ schema }).pipe(Effect.provide(services))
        const bootStatusQueue = yield* Queue.unbounded<BootStatus>()
        yield* recreateDb({ schema, bootStatusQueue, materializeEvent }).pipe(Effect.provide(services))
        const persistence = yield* LeaderPersistence.make({ materializeEvent, schema }).pipe(Effect.provide(services))
        yield* persistence.persistUpstream({
          events: [base],
          rollbackEvents: [],
          pulledEvents: [{ event: base, syncMetadata: Option.none() }],
          confirmedEvents: [],
          backendHead: base.seqNum,
        })
        yield* persistence.persistLocal({ events: [original] })
        // This is a valid completed image when captured. Invalidating the live file cannot revoke these bytes.
        const snapshot = yield* persistence.exportSnapshot
        expect(Eventlog.getClientHeadFromDb(dbEventlog)).toEqual(original.seqNum)
        expect(
          dbState
            .select(tables.todos)
            .map((row) => row.id)
            .toSorted(),
        ).toEqual(['base', 'pending'])
        if (owner === 'restarted') {
          armed = true
          yield* persistence
            .persistUpstream({
              events: [competing, replacement],
              rollbackEvents: [original],
              pulledEvents: [{ event: competing, syncMetadata: Option.none() }],
              confirmedEvents: [],
              backendHead: competing.seqNum,
            })
            .pipe(Effect.flip)
          expect(dbState.select(SystemTables.rebuildMetaTable)).toEqual([])
          expect(Eventlog.getClientHeadFromDb(dbEventlog)).toEqual(replacement.seqNum)
          expect(Eventlog.getBackendHeadFromDb(dbEventlog)).toEqual(2)
        }
        return snapshot
      }).pipe(Effect.scoped)

      const recovered = yield* Deferred.make<{
        dbState: SqliteDb
        dbEventlog: SqliteDb
        initializedSource: SourceIdentity.InitializedSource
      }>()
      let opening = false
      const backend = yield* makeMockSyncBackend({ startConnected: true })
      yield* backend.advance(...[base, competing].map(LiveStoreEvent.Client.toGlobal))
      const store = yield* createStore({
        schema,
        storeId: `delayed-complete-snapshot-${owner}`,
        adapter: makeTestAdapter({
          clientId: 'snapshot-fixture',
          sessionId: 'snapshot-fixture',
          importSnapshot: captured,
          sync: {
            backend: () => backend.makeSyncBackend.pipe(Effect.map((real) => ({ ...real, push: () => Effect.never }))),
          },
          testing: {
            snapshotAdmission: true,
            overrides: {
              makeLeaderThread: (factory) =>
                Effect.gen(function* () {
                  if (opening === false) {
                    opening = true
                    // SQLite handles belong to their WASM instance; reopen with the adapter's factory.
                    const reopen = (fileName: string) =>
                      Effect.acquireRelease(factory({ _tag: 'fs', directory, fileName }), (db) =>
                        Effect.sync(() => db.close()),
                      )
                    const dbEventlog = yield* reopen('eventlog.db')
                    const initializedSource = yield* Eventlog.initializeSource(dbEventlog, { sourceIsNew: false })
                    const dbState = yield* reopen('state.db')
                    yield* Deferred.succeed(recovered, { dbState, dbEventlog, initializedSource })
                  }
                  return yield* Deferred.await(recovered)
                }),
              clientSession: {
                leaderThreadProxy: (proxy) => ({
                  // Reproduce both browser fast paths: initial head comes from the captured image, not recovered source.
                  initialState: { ...proxy.initialState, leaderHead: original.seqNum },
                }),
              },
            },
          },
        }),
      })
      const { dbState } = yield* Deferred.await(recovered)
      const leader = store[StoreInternalsSymbol].clientSession.leaderThread
      yield* leader.syncState.changes.pipe(
        Stream.filter((state) => state.upstreamHead.global === 2 && state.localHead.global === 3),
        Stream.runHead,
      )
      expect(Eventlog.getClientHeadFromDb((yield* Deferred.await(recovered)).dbEventlog)).toEqual(replacement.seqNum)
      expect((yield* leader.syncState.get).pending.map((event) => event.args.id)).toEqual(['pending'])
      expect(
        dbState
          .select(tables.todos)
          .map((row) => row.id)
          .toSorted(),
      ).toEqual(['base', 'pending', 'remote'])
      const refreshed = yield* Deferred.make<void>()
      const stop = store.subscribe(tables.todos, (rows) => {
        if (rows.some((row) => row.id === 'later') === true) Deferred.doneUnsafe(refreshed, Exit.void)
      })
      const later = LiveStoreEvent.Client.Encoded.make({ ...todo('later', 4, 0), parentSeqNum: replacement.seqNum })
      yield* backend.advance(LiveStoreEvent.Client.toGlobal(replacement), LiveStoreEvent.Client.toGlobal(later))
      yield* Deferred.await(refreshed).pipe(Effect.ensuring(Effect.sync(stop)))
      expect(
        dbState
          .select(tables.todos)
          .map((row) => row.id)
          .toSorted(),
      ).toEqual(['base', 'later', 'pending', 'remote'])
      expect(
        store
          .query(tables.todos)
          .map((row) => row.id)
          .toSorted(),
      ).toEqual(['base', 'later', 'pending', 'remote'])
    }).pipe(
      Effect.provide(Layer.mergeAll(PlatformNode.NodeFileSystem.layer, FetchHttpClient.layer)),
      Vitest.withTestCtx(test),
    ),
  )
}

const todo = (id: string, global: number, rebaseGeneration: number) =>
  LiveStoreEvent.Client.Encoded.make({
    name: events.todoCreated.name,
    args: { id, text: id },
    clientId: 'snapshot-fixture',
    sessionId: 'snapshot-fixture',
    seqNum: EventSequenceNumber.Client.Composite.make({ global, client: 0, rebaseGeneration }),
    parentSeqNum: EventSequenceNumber.Client.Composite.make({ global: global - 1, client: 0 }),
  })
