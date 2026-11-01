import { expect } from 'vitest'

import type { BootStatus } from '@livestore/common'
import {
  Eventlog,
  LeaderPersistence,
  LeaderThreadCtx,
  makeLeaderThreadLayer,
  makeMaterializeEvent,
  recreateDb,
  ShutdownChannel,
} from '@livestore/common/leader-thread'
import { Events, EventSequenceNumber, LiveStoreEvent, makeSchema, State, SystemTables } from '@livestore/common/schema'
import { loadSqlite3Wasm } from '@livestore/sqlite-wasm/load-wasm'
import { sqliteDbFactory } from '@livestore/sqlite-wasm/node'
import { Vitest } from '@livestore/utils-dev/node-vitest'
import { Effect, FetchHttpClient, FileSystem, Layer, Option, Queue, Schema, WebChannel } from '@livestore/utils/effect'
import { PlatformNode } from '@livestore/utils/node'

import { makeSqliteServicesLayer } from './fixture.ts'

for (const boundary of ['after-object', 'after-outcome'] as const) {
  Vitest.live(`shared pull SQL failure ${boundary} retains source and backend cursor across offline reopen`, (test) =>
    Effect.gen(function* () {
      const sqlite3 = yield* Effect.promise(() => loadSqlite3Wasm())
      const makeSqliteDb = yield* sqliteDbFactory({ sqlite3 })
      const fs = yield* FileSystem.FileSystem
      const directory = yield* fs.makeTempDirectoryScoped()
      const open = (fileName: string) => makeSqliteDb({ _tag: 'fs', directory, fileName })
      const objects = State.SQLite.table({ name: 'objects', columns: { id: State.SQLite.text({ primaryKey: true }) } })
      const outcomes = State.SQLite.table({
        name: 'outcomes',
        columns: { id: State.SQLite.text({ primaryKey: true }) },
      })
      const events = { created: Events.synced({ name: 'created', schema: Schema.Struct({ id: Schema.String }) }) }
      const schema = makeSchema({
        projectionRevision: 'test-fixture-v1',
        events,
        state: State.SQLite.makeState({
          tables: { objects, outcomes },
          materializers: State.SQLite.materializers(events, {
            created: ({ id }) => {
              const writes = [objects.insert({ id }), outcomes.insert({ id })]
              // Preserve the application's two real SQL failure positions without depending on its graph layer.
              return id === 'failed'
                ? [...(boundary === 'after-object' ? writes.slice(0, 1) : writes), objects.insert({ id })]
                : writes
            },
          }),
        }),
      })
      const event = (id: string, global: number) =>
        LiveStoreEvent.Client.Encoded.make({
          name: 'created',
          args: { id },
          clientId: 'peer',
          sessionId: 'peer-session',
          seqNum: EventSequenceNumber.Client.Composite.make({ global, client: 0 }),
          parentSeqNum: EventSequenceNumber.Client.Composite.make({ global: global - 1, client: 0 }),
        })
      const confirmed = event('confirmed', 1)
      const failed = event('failed', 2)
      yield* Effect.gen(function* () {
        const dbEventlog = yield* Effect.acquireRelease(open('eventlog.db'), (db) => Effect.sync(() => db.close()))
        yield* Eventlog.initializeSource(dbEventlog, { sourceIsNew: true })
        const dbState = yield* Effect.acquireRelease(open('state.db'), (db) => Effect.sync(() => db.close()))
        const services = makeSqliteServicesLayer({ dbState, dbEventlog })
        const materializeEvent = yield* makeMaterializeEvent({ schema }).pipe(Effect.provide(services))
        const bootStatusQueue = yield* Queue.unbounded<BootStatus>()
        yield* recreateDb({ schema, bootStatusQueue, materializeEvent }).pipe(Effect.provide(services))
        const persistence = yield* LeaderPersistence.make({ materializeEvent, schema }).pipe(Effect.provide(services))
        const persist = (event: LiveStoreEvent.Client.Encoded) =>
          persistence.persistUpstream({
            pulledEvents: [{ event, syncMetadata: Option.some({ cursor: event.seqNum.global }) }],
            events: [event],
            rollbackEvents: [],
            confirmedEvents: [],
            backendHead: event.seqNum,
          })
        yield* persist(confirmed)
        const source = dbEventlog.select(SystemTables.eventlogMetaTable)
        yield* persist(failed).pipe(Effect.flip)
        expect(dbState.select(objects)).toEqual([{ id: 'confirmed' }])
        expect(dbState.select(outcomes)).toEqual([{ id: 'confirmed' }])
        expect(Eventlog.getBackendHeadFromDb(dbEventlog)).toBe(1)
        expect(dbEventlog.select(SystemTables.eventlogMetaTable)).toEqual(source)
      }).pipe(Effect.scoped)
      yield* Effect.gen(function* () {
        const dbEventlog = yield* Effect.acquireRelease(open('eventlog.db'), (db) => Effect.sync(() => db.close()))
        const initializedSource = yield* Eventlog.initializeSource(dbEventlog, { sourceIsNew: false })
        const dbState = yield* Effect.acquireRelease(open('state.db'), (db) => Effect.sync(() => db.close()))
        const source = dbEventlog.select(SystemTables.eventlogMetaTable)
        const shutdown = yield* WebChannel.queueChannelProxy({ schema: ShutdownChannel.All })
        yield* Effect.gen(function* () {
          const leader = yield* LeaderThreadCtx
          expect(dbState.select(objects)).toEqual([{ id: 'confirmed' }])
          expect(dbState.select(outcomes)).toEqual([{ id: 'confirmed' }])
          expect(Eventlog.getBackendHeadFromDb(dbEventlog)).toBe(1)
          expect((yield* leader.syncProcessor.syncState.get).pending).toEqual([])
          expect(dbEventlog.select(SystemTables.eventlogMetaTable)).toEqual(source)
        }).pipe(
          Effect.provide(
            makeLeaderThreadLayer({
              initializedSource,
              schema,
              storeId: 'shared-sql-failure',
              clientId: 'local',
              makeSqliteDb,
              syncPayloadEncoded: undefined,
              syncPayloadSchema: undefined,
              syncOptions: undefined,
              devtoolsOptions: { enabled: false },
              shutdownChannel: shutdown.webChannel,
            }).pipe(
              Layer.provide(makeSqliteServicesLayer({ dbState, dbEventlog })),
              Layer.provide(FetchHttpClient.layer),
            ),
          ),
        )
      }).pipe(Effect.scoped)
    }).pipe(Effect.provide(PlatformNode.NodeFileSystem.layer), Vitest.withTestCtx(test)),
  )
}
