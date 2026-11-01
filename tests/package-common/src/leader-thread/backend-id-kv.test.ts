import { expect } from 'vitest'

import type { SourceIdentity } from '@livestore/common'
import { makeMockSyncBackend, type SqliteDb, SyncBackend, type UnknownError } from '@livestore/common'
import { Eventlog, LeaderThreadCtx, makeLeaderThreadLayer, ShutdownChannel } from '@livestore/common/leader-thread'
import { EventSequenceNumber, LiveStoreEvent, SystemTables } from '@livestore/common/schema'
import { loadSqlite3Wasm } from '@livestore/sqlite-wasm/load-wasm'
import { sqliteDbFactory } from '@livestore/sqlite-wasm/node'
import { Vitest } from '@livestore/utils-dev/node-vitest'
import {
  Effect,
  FetchHttpClient,
  FileSystem,
  KeyValueStore,
  Layer,
  Option,
  Stream,
  WebChannel,
} from '@livestore/utils/effect'
import { PlatformNode } from '@livestore/utils/node'

import { makeSqliteServicesLayer, schema } from './fixture.ts'

Vitest.live('enumerates the real SQL backend binding across reopen and rejects reset or rebinding', (test) =>
  Effect.gen(function* () {
    const sqlite3 = yield* Effect.promise(() => loadSqlite3Wasm())
    const makeSqliteDb = yield* sqliteDbFactory({ sqlite3 })
    const fs = yield* FileSystem.FileSystem
    const directory = yield* fs.makeTempDirectoryScoped()
    const open = (fileName: string) =>
      Effect.acquireRelease(makeSqliteDb({ _tag: 'fs', directory, fileName }), (db) => Effect.sync(() => db.close()))
    const withLeader = (
      dbState: SqliteDb,
      dbEventlog: SqliteDb,
      initializedSource: SourceIdentity.InitializedSource,
      body: (
        store: KeyValueStore.KeyValueStore,
      ) => Effect.Effect<void, KeyValueStore.KeyValueStoreError | UnknownError>,
    ) =>
      Effect.gen(function* () {
        const mock = yield* makeMockSyncBackend()
        const channel = yield* WebChannel.queueChannelProxy({ schema: ShutdownChannel.All })
        let capturedStore: KeyValueStore.KeyValueStore | undefined
        const layer = makeLeaderThreadLayer({
          initializedSource,
          schema,
          storeId: 'backend-kv',
          clientId: 'backend-kv-client',
          makeSqliteDb,
          syncPayloadEncoded: undefined,
          syncPayloadSchema: undefined,
          syncOptions: {
            backend: () =>
              Effect.gen(function* () {
                capturedStore = yield* KeyValueStore.KeyValueStore
                const backend = yield* mock.makeSyncBackend
                // Keep provider work pending so the SQL assertions cannot race backend confirmation.
                return { ...backend, pull: () => Stream.never, push: () => Effect.never }
              }),
          },
          devtoolsOptions: { enabled: false },
          shutdownChannel: channel.webChannel,
        }).pipe(Layer.provide(makeSqliteServicesLayer({ dbState, dbEventlog })), Layer.provide(FetchHttpClient.layer))
        yield* Effect.gen(function* () {
          const leader = yield* LeaderThreadCtx
          if (capturedStore === undefined)
            throw new Error('Backend constructor did not receive its durable identity store')
          if (Eventlog.getClientHeadFromDb(dbEventlog).global === 0) {
            yield* leader.syncProcessor.push([
              LiveStoreEvent.Client.Encoded.make({
                name: 'todoCreated',
                args: { id: 'retained', text: 'retained', completed: false },
                seqNum: EventSequenceNumber.Client.Composite.make({ global: 1, client: 0 }),
                parentSeqNum: EventSequenceNumber.Client.ROOT,
                clientId: 'backend-kv-client',
                sessionId: 'backend-kv-session',
              }),
            ])
          }
          yield* body(capturedStore)
        }).pipe(Effect.provide(layer))
      })

    yield* Effect.gen(function* () {
      const db = yield* open('eventlog.db')
      const initializedSource = yield* Eventlog.initializeSource(db, { sourceIsNew: true })
      const dbState = yield* open('state.db')
      yield* withLeader(dbState, db, initializedSource, (store) =>
        Effect.gen(function* () {
          expect(yield* store.keys).toEqual([])
          expect(yield* store.size).toBe(0)
          expect(yield* store.get('backendId')).toBeUndefined()
          yield* store.set('backendId', "backend'with-quotes")
          expect(yield* store.get('backendId')).toBe("backend'with-quotes")
          expect(yield* store.get('unrelated')).toBeUndefined()
          expect(yield* store.keys).toEqual(['backendId'])
          expect(yield* store.size).toBe(1)
          const error = yield* store.set('unrelated', 'value').pipe(Effect.flip, Effect.orDie)
          expect(error._tag).toBe('KeyValueStoreError')
          yield* store.set('backendId', "backend'with-quotes")
          const rebindError = yield* store.set('backendId', 'different-backend').pipe(Effect.flip, Effect.orDie)
          expect(rebindError._tag).toBe('KeyValueStoreError')
          const helper = yield* SyncBackend.makeBackendIdHelper.pipe(
            Effect.provideService(KeyValueStore.KeyValueStore, store),
          )
          yield* helper.lazySet('different-backend').pipe(Effect.flip, Effect.orDie)
          expect(Option.getOrThrow(helper.get())).toBe("backend'with-quotes")
        }),
      )
    }).pipe(Effect.scoped)

    yield* Effect.gen(function* () {
      const db = yield* open('eventlog.db')
      const initializedSource = yield* Eventlog.initializeSource(db, { sourceIsNew: false })
      const dbState = yield* open('state.db')
      yield* withLeader(dbState, db, initializedSource, (store) =>
        Effect.gen(function* () {
          const source = db.select(SystemTables.eventlogMetaTable)
          expect(source).toHaveLength(1)
          expect(yield* store.get('backendId')).toBe("backend'with-quotes")
          for (const reset of [store.remove('unrelated'), store.remove('backendId'), store.clear]) {
            const error = yield* reset.pipe(Effect.flip, Effect.orDie)
            expect(error._tag).toBe('KeyValueStoreError')
            expect(yield* store.get('backendId')).toBe("backend'with-quotes")
            expect(yield* store.keys).toEqual(['backendId'])
            expect(yield* store.size).toBe(1)
          }
          expect(Eventlog.getBackendHeadFromDb(db)).toBe(0)
          expect(db.select(SystemTables.eventlogMetaTable)).toEqual(source)
          expect(db.select(SystemTables.syncStatusTable)).toEqual([{ head: 0, backendId: "backend'with-quotes" }])
          db.execute(`DROP TABLE ${SystemTables.SYNC_STATUS_TABLE}`)
          const error = yield* store.keys.pipe(Effect.flip, Effect.orDie)
          expect(error._tag).toBe('KeyValueStoreError')
          expect(error.method).toBe('keys')
        }),
      )
    }).pipe(Effect.scoped)

    yield* Effect.gen(function* () {
      const db = yield* open('empty-eventlog.db')
      const initializedSource = yield* Eventlog.initializeSource(db, { sourceIsNew: true })
      const dbState = yield* open('empty-state.db')
      yield* withLeader(dbState, db, initializedSource, (store) =>
        Effect.gen(function* () {
          yield* store.set('backendId', '')
          expect(yield* store.get('backendId')).toBe('')
          expect(yield* store.keys).toEqual(['backendId'])
          expect(yield* store.size).toBe(1)
        }),
      )
    }).pipe(Effect.scoped)
  }).pipe(Effect.provide(PlatformNode.NodeFileSystem.layer), Vitest.withTestCtx(test)),
)
