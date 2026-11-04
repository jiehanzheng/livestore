import { describe, expect, it } from 'vitest'

import { SyncState } from '@livestore/common'
import { EventSequenceNumber, LiveStoreEvent } from '@livestore/common/schema'
import { SourceEvents, SourceIdentity } from '@livestore/common/source-db'
import { Effect, Option } from '@livestore/utils/effect'

import { makeMemorySource, run, sequence, stored } from '../source-db/fixture.ts'

const original = (client: number) => ({
  ...stored(client === 0 ? 2 : 1, client, 3),
  event: LiveStoreEvent.Client.Encoded.make({
    name: 'future.SharedAction',
    args: { actionId: 'same-original-action', value: 'retained' },
    seqNum: sequence(client === 0 ? 2 : 1, client, 3),
    parentSeqNum: sequence(1),
    clientId: 'original-client',
    sessionId: 'original-session',
  }),
})
const accepted = () =>
  LiveStoreEvent.Client.fromGlobal({
    name: 'future.SharedAction',
    args: { actionId: 'same-original-action', value: 'retained' },
    seqNum: EventSequenceNumber.Global.make(2),
    parentSeqNum: EventSequenceNumber.Global.make(1),
    clientId: 'original-client',
    sessionId: 'original-session',
  })

const exercise = (client: number) =>
  run(
    Effect.gen(function* () {
      const { source, fresh } = yield* makeMemorySource()
      yield* SourceIdentity.initialize(source, fresh!)
      const pending = original(client)
      yield* source.transaction((tx) =>
        Effect.gen(function* () {
          yield* SourceEvents.insert(tx, [stored(1), pending])
          yield* SourceEvents.updateBackendHead(tx, sequence(1).global)
          yield* SourceEvents.updateBackendId(tx, 'recovered-backend')
        }),
      )
      const retained = yield* SourceEvents.readAfterComposite(source, sequence(1))
      expect(retained).toEqual([pending])
      expect(yield* SourceEvents.readBackendHead(source)).toBe(1)
      const merge = yield* SyncState.merge({
        syncState: new SyncState.SyncState({
          pending: retained.map((row) => row.event),
          upstreamHead: sequence(1),
          localHead: pending.event.seqNum,
        }),
        payload: SyncState.PayloadUpstreamAdvance.make({ newEvents: [accepted()] }),
        isClientOnlyEvent: () => false,
        isEqualEvent: LiveStoreEvent.Client.isEqualEncoded,
        ignoreClientOnlyEvents: true,
      })
      if (merge._tag === 'reject') return yield* Effect.die('Upstream rejected unexpectedly')
      yield* source.transaction((tx) =>
        Effect.gen(function* () {
          if (merge._tag === 'rebase')
            yield* SourceEvents.deletePositions(
              tx,
              merge.rollbackEvents.map((event) => event.seqNum),
            )
          yield* SourceEvents.insert(
            tx,
            merge.newEvents.map((event) => ({ event, schemaHash: 42, syncMetadata: Option.none() })),
          )
          if (merge._tag === 'advance')
            yield* SourceEvents.updateSyncMetadata(tx, [
              { event: accepted(), syncMetadata: Option.some({ cursor: 'recovered-2' }) },
            ])
          yield* SourceEvents.updateBackendHead(tx, sequence(2).global)
        }),
      )
      const after = yield* SourceEvents.readPage(source, { includeClientOnly: true })
      return { merge, after, pending }
    }),
  )

describe('lost ACK recovery coordinate evidence on actual SOURCE and canonical merge', () => {
  it('confirms shared client0 beyond ACK without inserting or rebasing a second action', async () => {
    const { merge, after, pending } = await exercise(0)
    expect(merge._tag).toBe('advance')
    expect(merge.newSyncState.pending).toEqual([])
    expect(merge.newEvents).toEqual([])
    expect(after.filter((row) => row.event.name === pending.event.name)).toHaveLength(1)
    expect(after[1]!.event).toEqual(pending.event)
  })

  // Ordinary shared-event admission produces client0; this invalid producer shape documents why recovery must refuse it.
  it('characterizes invalid shared client1 producer shape as a rebase with a duplicate', async () => {
    const { merge, after, pending } = await exercise(1)
    expect({
      result: merge._tag,
      pending: merge.newSyncState.pending.map((event) => event.seqNum),
      retainedOccurrences: after.filter((row) => row.event.name === pending.event.name).map((row) => row.event.seqNum),
    }).toEqual({
      result: 'rebase',
      pending: [sequence(3, 0, 1)],
      retainedOccurrences: [sequence(2), sequence(3, 0, 1)],
    })
  })
})
