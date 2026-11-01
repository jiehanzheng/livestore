import { expect } from 'vitest'

import { AdmittedOwnerEndedError, MaterializeError, makeMockSyncBackend, SqliteDbHelper } from '@livestore/common'
import { Eventlog } from '@livestore/common/leader-thread'
import { Events, EventSequenceNumber, LiveStoreEvent, makeSchema, State } from '@livestore/common/schema'
import { createStore, makeShutdownDeferred, StoreInternalsSymbol } from '@livestore/livestore'
import { Vitest } from '@livestore/utils-dev/node-vitest'
import { Cause, Deferred, Effect, Exit, FetchHttpClient, Layer, Schema, Stream } from '@livestore/utils/effect'
import { PlatformNode } from '@livestore/utils/node'

import { makeTestAdapter } from '../test-adapter.ts'

Vitest.live('a leader persistence failure closes the optimistic session instead of leaving it queryable', (test) =>
  Effect.gen(function* () {
    const rows = State.SQLite.table({ name: 'rows', columns: { id: State.SQLite.text({ primaryKey: true }) } })
    const events = { created: Events.synced({ name: 'created', schema: Schema.Struct({ id: Schema.String }) }) }
    const schema = makeSchema({
      projectionRevision: 'test-fixture-v1',
      events,
      state: State.SQLite.makeState({
        tables: { rows },
        materializers: State.SQLite.materializers(events, { created: ({ id }) => rows.insert({ id }) }),
      }),
    })
    const shutdown = yield* makeShutdownDeferred
    let armed = false
    const adapter = makeTestAdapter({
      testing: {
        overrides: {
          makeLeaderThread: (makeSqliteDb) =>
            Effect.gen(function* () {
              // Use the adapter's WASM factory: SQLite handles cannot cross module instances.
              const rawEventlog = yield* Effect.acquireRelease(makeSqliteDb({ _tag: 'in-memory' }), (db) =>
                Effect.sync(() => db.close()),
              )
              const dbEventlog = {
                ...rawEventlog,
                execute: SqliteDbHelper.makeExecute((...args) => {
                  if (armed === true && args[0] === 'COMMIT') throw new Error('Injected leader source COMMIT failure')
                  rawEventlog.execute(...args)
                }),
              }
              const initializedSource = yield* Eventlog.initializeSource(dbEventlog, { sourceIsNew: true })
              const dbState = yield* Effect.acquireRelease(makeSqliteDb({ _tag: 'in-memory' }), (db) =>
                Effect.sync(() => db.close()),
              )
              return { dbState, dbEventlog, initializedSource }
            }),
        },
      },
    })
    const store = yield* createStore({ schema, storeId: 'poisoned-leader', adapter, shutdownDeferred: shutdown })
    armed = true
    store.commit(events.created({ id: 'optimistic' }))
    const error = yield* Deferred.await(shutdown).pipe(Effect.flip)
    expect(error._tag).toBe('MaterializeError')
    expect(store[StoreInternalsSymbol].isShutdown).toBe(true)
    expect(() => store.query(rows)).toThrow()
    expect(() => store.commit(events.created({ id: 'too-late' }))).toThrow()
  }).pipe(
    Effect.provide(Layer.mergeAll(PlatformNode.NodeFileSystem.layer, FetchHttpClient.layer)),
    Vitest.withTestCtx(test),
  ),
)

for (const snapshotAdmission of [false, true]) {
  for (const boundary of ['after-object', 'after-outcome'] as const) {
    Vitest.live(
      `preserves the original constraint cause for ${snapshotAdmission === true ? 'admitted' : 'legacy'} shared SQL failure ${boundary}`,
      (test) =>
        Effect.gen(function* () {
          const objects = State.SQLite.table({
            name: 'objects',
            columns: { id: State.SQLite.text({ primaryKey: true }) },
          })
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
                  return id === 'failed'
                    ? [...(boundary === 'after-object' ? writes.slice(0, 1) : writes), objects.insert({ id })]
                    : writes
                },
              }),
            }),
          })
          const backend = yield* makeMockSyncBackend({ startConnected: true })
          const remote = (id: string, seqNum: number) =>
            LiveStoreEvent.Global.Encoded.make({
              name: 'created',
              args: { id },
              clientId: 'peer',
              sessionId: 'peer-session',
              seqNum: EventSequenceNumber.Global.make(seqNum),
              parentSeqNum: EventSequenceNumber.Global.make(seqNum - 1),
            })
          yield* backend.advance(remote('confirmed', 1))
          const shutdown = yield* makeShutdownDeferred
          const store = yield* createStore({
            schema,
            storeId: `constraint-cause-${snapshotAdmission}-${boundary}`,
            shutdownDeferred: shutdown,
            adapter: makeTestAdapter({
              sync: { backend: () => backend.makeSyncBackend },
              testing: { snapshotAdmission },
            }),
          })
          yield* store[StoreInternalsSymbol].syncProcessor.syncState.changes.pipe(
            Stream.filter((state) => state.upstreamHead.global === 1),
            Stream.runHead,
          )
          expect(store.query(objects)).toEqual([{ id: 'confirmed' }])
          const observed: ReturnType<typeof store.syncStatus>[][] = [[], []]
          const ready = yield* Deferred.make<void>()
          let initialCallbacks = 0
          const stops = observed.map((values) =>
            store.subscribeSyncStatus((status) => {
              const initial = values.length === 0
              values.push(status)
              if (initial === true && ++initialCallbacks === observed.length) {
                Deferred.doneUnsafe(ready, Effect.void)
              }
            }),
          )
          yield* Deferred.await(ready)
          const beforeFailure = observed.map((values) => values.slice())
          yield* backend.advance(remote('failed', 2))
          const failed = yield* Deferred.await(shutdown).pipe(Effect.exit)
          expect(Exit.isFailure(failed)).toBe(true)
          if (Exit.isFailure(failed) === true) {
            expect(Cause.pretty(failed.cause)).toMatch(/constraint|UNIQUE/i)
            expect(Schema.is(MaterializeError)(Cause.squash(failed.cause))).toBe(true)
            expect(Schema.is(AdmittedOwnerEndedError)(Cause.squash(failed.cause))).toBe(false)
          }
          expect(observed).toEqual(beforeFailure)
          for (const stop of stops) stop()
          expect(store[StoreInternalsSymbol].isShutdown).toBe(true)
          expect(() => store.query(objects)).toThrow()
        }).pipe(
          Effect.provide(Layer.mergeAll(PlatformNode.NodeFileSystem.layer, FetchHttpClient.layer)),
          Vitest.withTestCtx(test),
        ),
    )
  }
}
