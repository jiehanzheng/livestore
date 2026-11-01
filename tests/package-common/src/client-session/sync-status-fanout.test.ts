import { expect } from 'vitest'

import { makeMockSyncBackend } from '@livestore/common'
import { EventSequenceNumber, LiveStoreEvent } from '@livestore/common/schema'
import { createStore } from '@livestore/livestore'
import { Vitest } from '@livestore/utils-dev/node-vitest'
import { Deferred, Effect } from '@livestore/utils/effect'

import { schema, tables } from '../leader-thread/fixture.ts'
import { makeTestAdapter } from '../test-adapter.ts'

Vitest.live('broadcasts materialized shared progress to multiple public Store subscribers', (test) =>
  Effect.gen(function* () {
    const backend = yield* makeMockSyncBackend({ startConnected: true })
    const store = yield* createStore({
      schema,
      storeId: 'shared-status-fanout',
      adapter: makeTestAdapter({ sync: { backend: () => backend.makeSyncBackend } }),
    })
    const ready = [yield* Deferred.make<void>(), yield* Deferred.make<void>()]
    const completed = [yield* Deferred.make<void>(), yield* Deferred.make<void>()]
    const observed: { status: ReturnType<typeof store.syncStatus>; rows: number }[][] = [[], []]
    const stops = observed.map((values, index) =>
      store.subscribeSyncStatus((status) => {
        values.push({ status, rows: store.query(tables.todos).length })
        Deferred.doneUnsafe(ready[index]!, Effect.void)
        if (status.localHead === 'e2' && status.isSynced === true) Deferred.doneUnsafe(completed[index]!, Effect.void)
      }),
    )
    try {
      for (const signal of ready) yield* Deferred.await(signal)
      for (let seqNum = 1; seqNum <= 2; seqNum++) {
        yield* backend.advance(
          LiveStoreEvent.Global.Encoded.make({
            name: 'todoCreated',
            args: { id: String(seqNum), text: `Shared ${seqNum}` },
            clientId: 'remote',
            sessionId: 'remote-session',
            seqNum: EventSequenceNumber.Global.make(seqNum),
            parentSeqNum: EventSequenceNumber.Global.make(seqNum - 1),
          }),
        )
      }
      for (const signal of completed) yield* Deferred.await(signal)
      expect(observed[0]).toEqual(observed[1])
      expect(observed[0]!.at(-1)?.rows).toBe(2)
      expect(observed[0]!.at(-1)?.status).toEqual(store.syncStatus())
    } finally {
      for (const stop of stops) stop()
    }
  }).pipe(Vitest.withTestCtx(test)),
)
