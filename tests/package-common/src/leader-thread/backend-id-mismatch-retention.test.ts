import path from 'node:path'

import { expect } from 'vitest'

import { StateSnapshot } from '@livestore/common'
import { BackendIdMismatchError, makeMockSyncBackend, type SqliteDb, UnknownError } from '@livestore/common'
import { Eventlog, LeaderThreadCtx, makeLeaderThreadLayer, ShutdownChannel } from '@livestore/common/leader-thread'
import type { EventSequenceNumber } from '@livestore/common/schema'
import { Events, LiveStoreEvent, makeSchema, State, SystemTables } from '@livestore/common/schema'
import { EventFactory } from '@livestore/common/testing'
import { loadSqlite3Wasm } from '@livestore/sqlite-wasm/load-wasm'
import { reserveNodeSource, sqliteDbFactory } from '@livestore/sqlite-wasm/node'
import { Vitest } from '@livestore/utils-dev/node-vitest'
import {
  Cause,
  Deferred,
  Effect,
  Exit,
  FetchHttpClient,
  Fiber,
  FileSystem,
  KeyValueStore,
  Layer,
  Queue,
  Schema,
  Stream,
  WebChannel,
} from '@livestore/utils/effect'
import { PlatformNode } from '@livestore/utils/node'

import { ownSource, getStateHead, makeSqliteServicesLayer } from './fixture.ts'

const objects = State.SQLite.table({
  name: 'retained_objects',
  columns: { id: State.SQLite.text({ primaryKey: true }) },
})
const outcomes = State.SQLite.table({
  name: 'retained_outcomes',
  columns: { id: State.SQLite.text({ primaryKey: true }) },
})
const events = { created: Events.synced({ name: 'created', schema: Schema.Struct({ id: Schema.String }) }) }
const schema = makeSchema({
  projectionRevision: 'test-fixture-v1',
  events,
  state: State.SQLite.makeState({
    tables: { objects, outcomes },
    materializers: State.SQLite.materializers(events, {
      created: ({ id }) => [objects.insert({ id }), outcomes.insert({ id })],
    }),
  }),
})
const clientId = 'retained-client'
const sessionId = 'retained-session'
const backendId = 'retained-backend'

const persisted = (dbState: SqliteDb, dbEventlog: SqliteDb) => ({
  source: dbEventlog.select(`SELECT * FROM eventlog ORDER BY seqNumGlobal, seqNumClient, seqNumRebaseGeneration`),
  objects: dbState.select(objects),
  outcomes: dbState.select(outcomes),
  syncStatus: dbEventlog.select(SystemTables.syncStatusTable),
})

for (const policy of ['shutdown', 'reset'] as const) {
  Vitest.live(
    `typed backend mismatch ${policy} ${policy === 'shutdown' ? 'retains' : 'resets'} real SQL files across reopen`,
    (test) =>
      Effect.gen(function* () {
        const sqlite3 = yield* Effect.promise(() => loadSqlite3Wasm())
        const makeSqliteDb = yield* sqliteDbFactory({ sqlite3 })
        const fs = yield* FileSystem.FileSystem
        // Each policy has disposable files: the reset control must never share the retained source fixture.
        const directory = yield* fs.makeTempDirectoryScoped()
        const open = (fileName: string, newlyAllocated = false) =>
          makeSqliteDb({
            _tag: 'fs',
            directory,
            fileName,
            ...(newlyAllocated === true ? { sourceCreation: reserveNodeSource(path.join(directory, fileName)) } : {}),
          })
        const openState = (fileName: string) =>
          Effect.acquireRelease(open(fileName), (db) => Effect.sync(() => db.close()))
        const factory = EventFactory.makeFactory(events)({ client: EventFactory.clientIdentity(clientId, sessionId) })
        const confirmed = factory.created.next({ id: 'confirmed' })
        const pending = factory.created.next({ id: 'pending' })
        const encoded = (event: LiveStoreEvent.Global.Encoded) =>
          LiveStoreEvent.Client.Encoded.make(LiveStoreEvent.Global.toClientEncoded(event))
        let retained: ReturnType<typeof persisted> | undefined
        let retainedPending: ReadonlyArray<LiveStoreEvent.Client.Encoded> | undefined
        let retainedHead: EventSequenceNumber.Client.Composite | undefined

        yield* Effect.gen(function* () {
          const dbEventlog = yield* open('eventlog.db', true)
          const source = yield* ownSource(dbEventlog, dbEventlog.metadata.sourceCreation)
          const initializedSource = yield* Eventlog.initializeSource(source)
          const dbState = yield* openState('state.db')
          const mockBackend = yield* makeMockSyncBackend()
          const mismatchStarted = yield* Deferred.make<void>()
          const releaseMismatch = yield* Deferred.make<void>()
          const mismatch = new BackendIdMismatchError({ expected: 'replacement-backend', received: backendId })
          const shutdown = yield* WebChannel.queueChannelProxy({ schema: ShutdownChannel.All })
          const leaderLayer = makeLeaderThreadLayer({
            initializedSource,
            schema,
            storeId: 'backend-retention',
            clientId,
            makeSqliteDb,
            syncPayloadEncoded: undefined,
            syncPayloadSchema: undefined,
            syncOptions: {
              livePull: true,
              onBackendIdMismatch: policy,
              backend: () =>
                Effect.gen(function* () {
                  const kv = yield* KeyValueStore.KeyValueStore
                  yield* kv.set('backendId', backendId).pipe(UnknownError.mapToUnknownError)
                  return yield* mockBackend.makeSyncBackend
                }),
            },
            devtoolsOptions: { enabled: false },
            shutdownChannel: shutdown.webChannel,
          }).pipe(Layer.provide(makeSqliteServicesLayer({ dbState, source })), Layer.provide(FetchHttpClient.layer))

          yield* Effect.gen(function* () {
            const leader = yield* LeaderThreadCtx
            const { queue: sessionQueue } = yield* leader.syncProcessor.openSession({
              expectedProjection: StateSnapshot.getProjectionIdentity(schema),
              candidate: undefined,
            })
            const sessionStopped = yield* Stream.fromQueue(sessionQueue).pipe(
              Stream.runDrain,
              Effect.exit,
              Effect.forkScoped,
            )
            yield* leader.syncProcessor.push([encoded(confirmed)])
            yield* leader.syncProcessor.syncState.changes.pipe(
              Stream.takeUntil((state) => state.upstreamHead.global === 1 && state.pending.length === 0),
              Stream.runDrain,
              Effect.timeout(3000),
            )
            // Hold the provider failure until the second event and both derived facts are durable.
            // This proves retained pending work, rather than merely preserving an already-synced database.
            yield* mockBackend.failNextPushes(1, () =>
              Deferred.succeed(mismatchStarted, void 0).pipe(
                Effect.andThen(Deferred.await(releaseMismatch)),
                Effect.andThen(Effect.fail(mismatch)),
              ),
            )
            yield* leader.syncProcessor.push([encoded(pending)])
            yield* Deferred.await(mismatchStarted).pipe(Effect.timeout(3000))
            const syncState = yield* leader.syncProcessor.syncState.get
            expect(syncState.pending.map((event) => event.args)).toEqual([{ id: 'pending' }])
            expect(syncState.pending.map((event) => [event.clientId, event.sessionId])).toEqual([[clientId, sessionId]])
            retainedPending = syncState.pending
            retainedHead = yield* getStateHead(dbState)
            retained = persisted(dbState, dbEventlog)
            expect(retained.objects).toEqual([{ id: 'confirmed' }, { id: 'pending' }])
            expect(retained.outcomes).toEqual(retained.objects)
            expect(retained.source).toHaveLength(2)
            expect(retained.syncStatus).toEqual([{ head: 1, backendId }])
            yield* Deferred.succeed(releaseMismatch, void 0)
            const message = yield* Queue.take(shutdown.sendQueue).pipe(Effect.timeout(3000))
            expect(message._tag).toBe(policy === 'shutdown' ? 'BackendIdMismatchError' : 'IntentionalShutdownCause')
            if (message._tag === 'BackendIdMismatchError') {
              expect(Schema.is(BackendIdMismatchError)(message)).toBe(true)
              expect(message.expected).toBe('replacement-backend')
              expect(message.received).toBe(backendId)
            } else if (message._tag === 'IntentionalShutdownCause') {
              expect(message.reason).toBe('backend-id-mismatch')
            }
            const stopped = yield* Fiber.join(sessionStopped).pipe(Effect.timeout(3000))
            expect(Exit.isFailure(stopped)).toBe(true)
            if (Exit.isFailure(stopped) === true) expect(Cause.squash(stopped.cause)).toEqual(message)
            if (policy === 'shutdown') {
              expect(persisted(dbState, dbEventlog)).toEqual(retained)
              expect(yield* getStateHead(dbState)).toEqual(retainedHead)
            } else {
              expect(dbEventlog.select(SystemTables.eventlogMetaTable)).toEqual([])
              expect(dbEventlog.select(SystemTables.syncStatusTable)).toEqual([{ head: 0, backendId: null }])
              expect(
                dbState.select(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`),
              ).toEqual([])
            }
          }).pipe(Effect.provide(leaderLayer))
        }).pipe(Effect.scoped)

        yield* Effect.gen(function* () {
          const dbEventlog = yield* open('eventlog.db')
          const source = yield* ownSource(dbEventlog)
          const initializedSource = yield* Eventlog.initializeSource(source)
          const dbState = yield* openState('state.db')
          if (policy === 'shutdown') expect(persisted(dbState, dbEventlog)).toEqual(retained)
          else {
            expect(dbEventlog.select(SystemTables.eventlogMetaTable)).toEqual([])
            expect(dbEventlog.select(SystemTables.syncStatusTable)).toEqual([{ head: 0, backendId: null }])
          }
          const shutdown = yield* WebChannel.queueChannelProxy({ schema: ShutdownChannel.All })
          yield* Effect.gen(function* () {
            const leader = yield* LeaderThreadCtx
            const reopened = yield* leader.syncProcessor.syncState.get
            if (policy === 'shutdown') {
              expect(persisted(dbState, dbEventlog)).toEqual(retained)
              expect(reopened.pending).toEqual(retainedPending)
              expect(yield* getStateHead(dbState)).toEqual(retainedHead)
            } else {
              expect(dbState.select(objects)).toEqual([])
              expect(dbState.select(outcomes)).toEqual([])
              expect(reopened.pending).toEqual([])
            }
          }).pipe(
            Effect.provide(
              makeLeaderThreadLayer({
                initializedSource,
                schema,
                storeId: 'backend-retention',
                clientId,
                makeSqliteDb,
                syncPayloadEncoded: undefined,
                syncPayloadSchema: undefined,
                syncOptions: undefined,
                devtoolsOptions: { enabled: false },
                shutdownChannel: shutdown.webChannel,
              }).pipe(
                Layer.provide(makeSqliteServicesLayer({ dbState, source })),
                Layer.provide(FetchHttpClient.layer),
              ),
            ),
          )
        }).pipe(Effect.scoped)
      }).pipe(Effect.provide(PlatformNode.NodeFileSystem.layer), Vitest.withTestCtx(test)),
  )
}
