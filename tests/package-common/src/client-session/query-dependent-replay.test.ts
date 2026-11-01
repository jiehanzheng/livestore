import { expect } from 'vitest'

import { makeMockSyncBackend, type SyncState } from '@livestore/common'
import { Events, EventSequenceNumber, LiveStoreEvent, makeSchema, State } from '@livestore/common/schema'
import { createStore, makeShutdownDeferred, StoreInternalsSymbol } from '@livestore/livestore'
import { isDevEnv } from '@livestore/utils'
import { Vitest } from '@livestore/utils-dev/node-vitest'
import { Deferred, Effect, Exit, FetchHttpClient, Layer, Queue, Schema, Stream } from '@livestore/utils/effect'
import { PlatformNode } from '@livestore/utils/node'

import { makeTestAdapter } from '../test-adapter.ts'

// Reduced from ECBKS's public-contract replay reproduction; no graph or application recovery code.
Vitest.live(
  'query-dependent B and Undo U replay over competing X/Y/X, then confirm without losing attribution',
  (test) =>
    Effect.gen(function* () {
      expect(isDevEnv()).toBe(true)
      const backend = yield* makeMockSyncBackend({ startConnected: true })
      const pushes = yield* Queue.unbounded<void>()
      const shutdown = yield* makeShutdownDeferred
      const store = yield* createStore({
        schema,
        storeId: 'query-dependent-replay',
        shutdownDeferred: shutdown,
        adapter: makeTestAdapter({
          sync: {
            backend: () =>
              backend.makeSyncBackend.pipe(
                Effect.map((real) => ({
                  ...real,
                  // A transport barrier preserves pending work until canonical competing events arrive.
                  push: () => Queue.offer(pushes, undefined).pipe(Effect.andThen(Effect.never)),
                })),
              ),
            onSyncError: 'shutdown',
          },
        }),
      })
      const processor = store[StoreInternalsSymbol].syncProcessor
      const leader = store[StoreInternalsSymbol].clientSession.leaderThread
      const until = (predicate: (state: SyncState.SyncState) => boolean) =>
        processor.syncState.changes.pipe(
          Stream.filter(predicate),
          Stream.runHead,
          Effect.raceFirst(Deferred.await(shutdown).pipe(Effect.andThen(Effect.die('Unexpected store shutdown')))),
        )
      yield* backend.advance(canonical(events.set({ actionId: 'A', value: 'A' }), 1))
      yield* until((state) => state.upstreamHead.global === 1)
      store.commit(events.set({ actionId: 'B', value: 'B' }))
      yield* Queue.take(pushes)
      store.commit(events.undo({ actionId: 'U', targetActionId: 'B' }))
      expect(store.query(values.first())).toMatchObject({ value: 'A', owner: 'U' })

      yield* leader.syncState.changes.pipe(
        Stream.filter((state) => state.pending.length === 2),
        Stream.runHead,
      )

      for (const [actionId, value, global] of [
        ['X', 'X', 2],
        ['Y', 'Y', 3],
        ['X-final', 'X', 4],
      ] as const) {
        const refreshed = yield* Deferred.make<void>()
        const unsubscribe = store.subscribe(values, (rows) => {
          if (rows[0]?.value === value && rows[0]?.owner === 'U') Deferred.doneUnsafe(refreshed, Exit.void)
        })
        yield* backend.advance(canonical(events.set({ actionId, value }), global))
        yield* Deferred.await(refreshed).pipe(
          Effect.ensuring(Effect.sync(unsubscribe)),
          Effect.raceFirst(Deferred.await(shutdown)),
        )
        yield* until((state) => state.upstreamHead.global >= global)
        expect(store.query(values.first())).toMatchObject({ value, owner: 'U' })
        expect(store.query(history.where({ actionId: 'B' }))).toEqual([{ actionId: 'B', beforeValue: value }])
        expect(store.query(values.where({ owner: 'U' }))).toHaveLength(1)
        yield* leader.syncState.changes.pipe(
          Stream.filter((state) => state.upstreamHead.global === global && state.pending.length === 2),
          Stream.runHead,
        )
        expect((yield* leader.syncState.get).pending.map((event) => event.args.actionId)).toEqual(['B', 'U'])
      }
      const pending = (yield* leader.syncState.get).pending
      yield* backend.advance(...pending.map(LiveStoreEvent.Client.toGlobal))
      yield* leader.syncState.changes.pipe(
        Stream.filter((state) => state.pending.length === 0),
        Stream.runHead,
      )
      expect(store.query(values.first())).toMatchObject({ value: 'X', owner: 'U' })
      expect(store.query(history.where({ actionId: 'B' }))).toEqual([{ actionId: 'B', beforeValue: 'X' }])
      expect(yield* Deferred.isDone(shutdown)).toBe(false)
    }).pipe(
      Effect.provide(Layer.mergeAll(PlatformNode.NodeFileSystem.layer, FetchHttpClient.layer)),
      Vitest.withTestCtx(test),
    ),
)

const values = State.SQLite.table({
  name: 'replay_values',
  columns: { id: State.SQLite.text({ primaryKey: true }), value: State.SQLite.text(), owner: State.SQLite.text() },
})
const history = State.SQLite.table({
  name: 'replay_history',
  columns: { actionId: State.SQLite.text({ primaryKey: true }), beforeValue: State.SQLite.text() },
})
const events = {
  set: Events.synced({ name: 'set', schema: Schema.Struct({ actionId: Schema.String, value: Schema.String }) }),
  undo: Events.synced({
    name: 'undo',
    schema: Schema.Struct({ actionId: Schema.String, targetActionId: Schema.String }),
  }),
}
const schema = makeSchema({
  projectionRevision: 'test-fixture-v1',
  events,
  state: State.SQLite.makeState({
    tables: { values, history },
    materializers: State.SQLite.materializers(events, {
      set: (args, context) => {
        const prior = context.query(values.where({ id: 'value' }).first())
        return [
          history
            .insert({ actionId: args.actionId, beforeValue: prior?.value ?? '' })
            .onConflict('actionId', 'replace'),
          values.insert({ id: 'value', value: args.value, owner: args.actionId }).onConflict('id', 'replace'),
        ]
      },
      undo: (args, context) => {
        const prior = context.query(history.where({ actionId: args.targetActionId }).first())
        if (prior === undefined) throw new Error('Missing undo target')
        return values
          .insert({ id: 'value', value: prior.beforeValue, owner: args.actionId })
          .onConflict('id', 'replace')
      },
    }),
  }),
})
const canonical = (event: LiveStoreEvent.Input.Decoded, seqNum: number) =>
  LiveStoreEvent.Global.Encoded.make({
    ...event,
    seqNum: EventSequenceNumber.Global.make(seqNum),
    parentSeqNum: EventSequenceNumber.Global.make(seqNum - 1),
    clientId: 'peer',
    sessionId: 'peer-session',
  })
