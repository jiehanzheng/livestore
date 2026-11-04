import path from 'node:path'

import { expect } from 'vitest'

import type { SourceIdentity } from '@livestore/common'
import { makeMockSyncBackend, type SqliteDb, SyncBackend, type UnknownError } from '@livestore/common'
import { Eventlog, LeaderThreadCtx, makeLeaderThreadLayer, ShutdownChannel } from '@livestore/common/leader-thread'
import { EventSequenceNumber, LiveStoreEvent, SystemTables } from '@livestore/common/schema'
import type { SourceOwner, SourceDbError } from '@livestore/common/source-db'
import { loadSqlite3Wasm } from '@livestore/sqlite-wasm/load-wasm'
import { reserveNodeSource, sqliteDbFactory } from '@livestore/sqlite-wasm/node'
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

import { ownSource, makeSqliteServicesLayer, schema } from './fixture.ts'

Vitest.live('enumerates the real SQL backend binding across reopen and rejects reset or rebinding', (test) =>
  Effect.gen(function* () {
    const sqlite3 = yield* Effect.promise(() => loadSqlite3Wasm())
    const makeSqliteDb = yield* sqliteDbFactory({ sqlite3 })
    const fs = yield* FileSystem.FileSystem
    const directory = yield* fs.makeTempDirectoryScoped()
    const open = (fileName: string, newlyAllocated = false) =>
      makeSqliteDb({
        _tag: 'fs',
        directory,
        fileName,
        ...(newlyAllocated === true ? { sourceCreation: reserveNodeSource(path.join(directory, fileName)) } : {}),
      })
    const openState = (fileName: string) => Effect.acquireRelease(open(fileName), (db) => Effect.sync(() => db.close()))
    const withLeader = (
      dbState: SqliteDb,
      source: SourceOwner,
      initializedSource: SourceIdentity.InitializedSource,
      body: (
        store: KeyValueStore.KeyValueStore,
      ) => Effect.Effect<void, KeyValueStore.KeyValueStoreError | UnknownError | SourceDbError>,
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
        }).pipe(Layer.provide(makeSqliteServicesLayer({ dbState, source })), Layer.provide(FetchHttpClient.layer))
        yield* Effect.gen(function* () {
          const leader = yield* LeaderThreadCtx
          if (capturedStore === undefined)
            throw new Error('Backend constructor did not receive its durable identity store')
          if ((yield* Eventlog.getClientHeadFromDb(source.handle)).global === 0) {
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
      const db = yield* open('eventlog.db', true)
      const source = yield* ownSource(db, db.metadata.sourceCreation)
      const initializedSource = yield* Eventlog.initializeSource(source)
      const dbState = yield* openState('state.db')
      yield* withLeader(dbState, source, initializedSource, (store) =>
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
      const source = yield* ownSource(db)
      const initializedSource = yield* Eventlog.initializeSource(source)
      const dbState = yield* openState('state.db')
      yield* withLeader(dbState, source, initializedSource, (store) =>
        Effect.gen(function* () {
          const retainedSourceRows = db.select(SystemTables.eventlogMetaTable)
          expect(retainedSourceRows).toHaveLength(1)
          expect(yield* store.get('backendId')).toBe("backend'with-quotes")
          for (const reset of [store.remove('unrelated'), store.remove('backendId'), store.clear]) {
            const error = yield* reset.pipe(Effect.flip, Effect.orDie)
            expect(error._tag).toBe('KeyValueStoreError')
            expect(yield* store.get('backendId')).toBe("backend'with-quotes")
            expect(yield* store.keys).toEqual(['backendId'])
            expect(yield* store.size).toBe(1)
          }
          expect(yield* Eventlog.getBackendHeadFromDb(source.handle)).toBe(0)
          expect(db.select(SystemTables.eventlogMetaTable)).toEqual(retainedSourceRows)
          expect(db.select(SystemTables.syncStatusTable)).toEqual([{ head: 0, backendId: "backend'with-quotes" }])
          db.execute(`DROP TABLE ${SystemTables.SYNC_STATUS_TABLE}`)
          const error = yield* store.keys.pipe(Effect.flip, Effect.orDie)
          expect(error._tag).toBe('KeyValueStoreError')
          expect(error.method).toBe('keys')
        }),
      )
    }).pipe(Effect.scoped)

    const raced = yield* Effect.gen(function* () {
      const db = yield* open('concurrent-eventlog.db', true)
      const source = yield* ownSource(db, db.metadata.sourceCreation)
      const initializedSource = yield* Eventlog.initializeSource(source)
      const dbState = yield* openState('concurrent-state.db')
      let winner: string | undefined
      yield* withLeader(dbState, source, initializedSource, (store) =>
        Effect.gen(function* () {
          const outcomes = yield* Effect.all(
            [Effect.exit(store.set('backendId', 'backend-A')), Effect.exit(store.set('backendId', 'backend-B'))],
            { concurrency: 'unbounded' },
          )
          expect(outcomes.filter((outcome) => outcome._tag === 'Success')).toHaveLength(1)
          expect(outcomes.filter((outcome) => outcome._tag === 'Failure')).toHaveLength(1)
          winner = yield* store.get('backendId')
          if (winner === undefined) return yield* Effect.die('No concurrent binding committed')
          yield* store.set('backendId', winner)
          expect(yield* store.keys).toEqual(['backendId'])
          expect(yield* store.size).toBe(1)
          expect(yield* Eventlog.getBackendIdFromDb(source.handle)).toEqual(Option.some(winner))
          expect((yield* Effect.exit(store.set('backendId', 'third-backend')))._tag).toBe('Failure')
          expect((yield* Effect.exit(store.set('unrelated', 'value')))._tag).toBe('Failure')
          expect((yield* Effect.exit(store.remove('backendId')))._tag).toBe('Failure')
          expect((yield* Effect.exit(store.clear))._tag).toBe('Failure')
          expect(yield* store.get('backendId')).toBe(winner)
        }),
      )
      if (source.image === undefined || winner === undefined)
        return yield* Effect.die('Missing independent source image or binding')
      return { image: yield* source.image.export, winner, identity: initializedSource.identity }
    }).pipe(Effect.scoped)

    yield* Effect.gen(function* () {
      // Restore logical bytes through the owner capability; a fresh-memory permit cannot authorize retained data.
      const source = yield* makeSqliteDb({ _tag: 'in-memory' }).pipe(
        Effect.flatMap((database) => ownSource(database)),
        Effect.uninterruptible,
      )
      if (source.image === undefined) return yield* Effect.die('Independent source import capability missing')
      yield* source.image.import(raced.image)
      const initializedSource = yield* Eventlog.initializeSource(source)
      expect(initializedSource.identity).toEqual(raced.identity)
      const dbState = yield* Effect.acquireRelease(makeSqliteDb({ _tag: 'in-memory' }), (database) =>
        Effect.sync(() => database.close()),
      )
      yield* withLeader(dbState, source, initializedSource, (store) =>
        Effect.gen(function* () {
          expect(yield* store.get('backendId')).toBe(raced.winner)
          expect(yield* store.keys).toEqual(['backendId'])
          expect((yield* Effect.exit(store.clear))._tag).toBe('Failure')
          expect(yield* store.get('backendId')).toBe(raced.winner)
        }),
      )
    }).pipe(Effect.scoped)

    yield* Effect.gen(function* () {
      const db = yield* open('empty-eventlog.db', true)
      const source = yield* ownSource(db, db.metadata.sourceCreation)
      const initializedSource = yield* Eventlog.initializeSource(source)
      const dbState = yield* openState('empty-state.db')
      yield* withLeader(dbState, source, initializedSource, (store) =>
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
