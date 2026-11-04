import { describe, expect, it } from 'vitest'

import { Eventlog } from '@livestore/common/leader-thread'
import { assertInitialized, fromSourceDb, SourceContext, SourceEvents } from '@livestore/common/source-db'
import { Effect, Option } from '@livestore/utils/effect'

import { makeMemorySource, run, sequence, stored } from './fixture.ts'

describe('canonical eventlog facade with actual SOURCE ownership', () => {
  it('admits one owned source and delegates attribution, metadata, heads, tails and logical deletion', () =>
    run(
      Effect.gen(function* () {
        const { source, fresh, storageName } = yield* makeMemorySource()
        const owner = fromSourceDb(source, { fresh: fresh!, storageName })
        const proof = yield* Eventlog.initializeSource(owner)
        yield* assertInitialized(owner.handle, proof)
        const first = stored(1).event
        yield* Eventlog.insertIntoEventlog(first, owner, 9, 'facade-client', 'facade-session')
        const normalized = { ...first, clientId: 'facade-client', sessionId: 'facade-session' }
        expect(yield* Eventlog.getEventsSince({ dbEventlog: owner.handle, since: sequence(0) })).toEqual([normalized])
        expect(yield* Eventlog.getClientHeadFromDb(owner.handle)).toEqual(first.seqNum)
        const metadata = Option.some({ cursor: 'facade-cursor' })
        yield* Eventlog.updateSyncMetadata([{ event: first, syncMetadata: metadata }]).pipe(
          Effect.provideService(SourceContext, owner),
        )
        yield* Eventlog.updateBackendHead(owner, first.seqNum)
        yield* Eventlog.updateBackendId(owner, 'facade-backend')
        expect(yield* Eventlog.getBackendHeadFromDb(owner.handle)).toBe(1)
        expect(yield* Eventlog.getBackendIdFromDb(owner.handle)).toEqual(Option.some('facade-backend'))
        expect(
          yield* Eventlog.getSyncBackendCursorInfo({ remoteHead: first.seqNum.global }).pipe(
            Effect.provideService(SourceContext, owner),
          ),
        ).toEqual(Option.some({ eventSequenceNumber: first.seqNum.global, metadata }))
        yield* Eventlog.deleteEvents(owner, [first.seqNum])
        expect(yield* Eventlog.getEventsSince({ dbEventlog: owner.handle, since: sequence(0) })).toEqual([])
      }),
    ))

  it('keeps global stream bounds fixed while the explicit cursor drains same-global generations', () =>
    run(
      Effect.gen(function* () {
        const { source, fresh, storageName } = yield* makeMemorySource()
        const owner = fromSourceDb(source, { fresh: fresh!, storageName })
        yield* Eventlog.initializeSource(owner)
        const items = [stored(1), stored(1, 0, 2), stored(1, 1), stored(2)]
        yield* owner.write((transaction) => SourceEvents.insert(transaction, items))
        const options = { since: sequence(0), until: sequence(1), batchSize: 1, includeClientOnly: true }
        const page1 = yield* Eventlog.getEventsFromEventlog({ dbEventlog: owner.handle, options })
        const page2 = yield* Eventlog.getEventsFromEventlog({
          dbEventlog: owner.handle,
          options,
          after: page1[0]!.seqNum,
        })
        const page3 = yield* Eventlog.getEventsFromEventlog({
          dbEventlog: owner.handle,
          options,
          after: page2[0]!.seqNum,
        })
        expect([...page1, ...page2, ...page3]).toEqual(items.slice(0, 3).map((item) => item.event))
        expect(
          yield* Eventlog.getEventsFromEventlog({ dbEventlog: owner.handle, options, after: page3[0]!.seqNum }),
        ).toEqual([])
      }),
    ))

  it('writes through a transaction-scoped owner without opening a second transaction or splitting rollback', () =>
    run(
      Effect.gen(function* () {
        const { source, fresh, storageName } = yield* makeMemorySource()
        const owner = fromSourceDb(source, { fresh: fresh!, storageName })
        yield* Eventlog.initializeSource(owner)
        const outcome = yield* Effect.exit(
          owner.write((transaction) => {
            const scoped = {
              ...owner,
              handle: transaction,
              write: <A, E, R>(use: (tx: typeof transaction) => Effect.Effect<A, E, R>) => use(transaction),
            }
            return Effect.gen(function* () {
              yield* Eventlog.insertIntoEventlog(stored(1).event, scoped, 42, 'scope-client', 'scope-session')
              yield* Eventlog.updateBackendHead(scoped, sequence(1))
              return yield* Effect.fail('Reject this complete staged transition')
            })
          }),
        )
        expect(outcome._tag).toBe('Failure')
        expect(yield* Eventlog.getClientHeadFromDb(owner.handle)).toEqual(sequence(0))
        expect(yield* Eventlog.getBackendHeadFromDb(owner.handle)).toBe(0)
      }),
    ))
})
