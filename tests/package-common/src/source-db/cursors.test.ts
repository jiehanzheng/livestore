import { describe, expect, it } from 'vitest'

import { SourceEvents as Events, SourceIdentity as Identity } from '@livestore/common/source-db'
import { Effect, Option } from '@livestore/utils/effect'

import { makeMemorySource, run, sequence, stored } from './fixture.ts'

describe('canonical SOURCE cursor semantics with actual SQLite', () => {
  it('validates the exact parent incarnation while allowing other generations at its logical position', () =>
    run(
      Effect.gen(function* () {
        const { source, fresh } = yield* makeMemorySource()
        yield* Identity.initialize(source, fresh!)
        yield* source.transaction((transaction) => Events.insert(transaction, [stored(1), stored(1, 0, 2)]))
        yield* Events.assertParentExists(source, sequence(1, 0, 2))
        expect((yield* Effect.exit(Events.assertParentExists(source, sequence(1, 0, 1))))._tag).toBe('Failure')
        expect((yield* Effect.exit(source.export))._tag).toBe('Failure')
      }),
    ))

  it('reads the entire composite tail, including client-zero events beyond the backend and more than one page', () =>
    run(
      Effect.gen(function* () {
        const { source, fresh } = yield* makeMemorySource()
        yield* Identity.initialize(source, fresh!)
        const tail = Array.from({ length: 137 }, (_, index) => stored(index + 6))
        const pending = stored(142, 1)
        yield* source.transaction((transaction) =>
          Effect.gen(function* () {
            yield* Events.insert(transaction, [stored(5), ...tail, pending])
            yield* Events.updateBackendHead(transaction, sequence(5).global)
          }),
        )
        expect(yield* Events.readBackendHead(source)).toBe(5)
        expect(yield* Events.readAfterComposite(source, sequence(5))).toEqual([...tail, pending])
        expect(yield* Events.readPending(source)).toEqual([pending])
        expect(yield* Events.readPage(source, { since: sequence(5) })).toHaveLength(100)
      }),
    ))

  it('drains global windows with a composite cursor without losing generation or client ties at limit one', () =>
    run(
      Effect.gen(function* () {
        const { source, fresh } = yield* makeMemorySource()
        yield* Identity.initialize(source, fresh!)
        const expected = [stored(6), stored(6, 0, 2), stored(6, 1), stored(7)]
        yield* source.transaction((transaction) => Events.insert(transaction, [stored(5), ...expected, stored(8)]))
        const result: Events.StoredEvent[] = []
        let after: ReturnType<typeof sequence> | undefined
        for (;;) {
          const page = yield* Events.readGlobalWindowPage(source, {
            since: sequence(5).global,
            until: sequence(7).global,
            limit: 1,
            includeClientOnly: true,
            ...(after === undefined ? {} : { after }),
          })
          if (page.length === 0) break
          result.push(...page)
          after = page.at(-1)!.event.seqNum
        }
        expect(result).toEqual(expected)
        expect(
          yield* Events.readGlobalWindowPage(source, {
            since: sequence(5).global,
            until: sequence(6).global,
            after: sequence(6),
            limit: 1,
          }),
        ).toEqual([expected[1]])
        expect(
          yield* Events.readGlobalWindowPage(source, {
            since: sequence(5).global,
            until: sequence(7).global,
            names: ['unknown'],
            includeClientOnly: true,
          }),
        ).toEqual([])
      }),
    ))

  it('preserves ROOT and missing-metadata behavior without initializing a missing source', () =>
    run(
      Effect.gen(function* () {
        const { source, fresh } = yield* makeMemorySource()
        expect(yield* Events.getSyncBackendCursorInfo(source, { remoteHead: sequence(0).global })).toEqual(
          Option.none(),
        )
        yield* Identity.initialize(source, fresh!)
        expect(yield* Events.getSyncBackendCursorInfo(source, { remoteHead: sequence(5).global })).toEqual(
          Option.some({ eventSequenceNumber: sequence(5).global, metadata: Option.none() }),
        )
        yield* source.transaction((transaction) => Events.insert(transaction, [stored(5), stored(5, 0, 3)]))
        expect(yield* Events.getSyncBackendCursorInfo(source, { remoteHead: sequence(5).global })).toEqual(
          Option.some({ eventSequenceNumber: sequence(5).global, metadata: Option.none() }),
        )
      }),
    ))

  it('chooses the smallest client and maximum generation while accepting semantic JSON object equality', () =>
    run(
      Effect.gen(function* () {
        const { source, fresh } = yield* makeMemorySource()
        yield* Identity.initialize(source, fresh!)
        const older = {
          ...stored(5),
          syncMetadata: Option.some({ cursor: 'c5', nested: { first: 1, second: [true, null] } }),
        }
        const newer = {
          ...stored(5, 0, 3),
          syncMetadata: Option.some({ nested: { second: [true, null], first: 1 }, cursor: 'c5' }),
        }
        const differentClient = { ...stored(5, 1, 9), syncMetadata: Option.some({ cursor: 'client-one' }) }
        yield* source.transaction((transaction) => Events.insert(transaction, [newer, differentClient, older]))
        const info = Option.getOrThrow(
          yield* Events.getSyncBackendCursorInfo(source, { remoteHead: sequence(5).global }),
        )
        expect(info.metadata).toEqual(newer.syncMetadata)
        const metadata = Option.getOrThrow(info.metadata)
        if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata) === true) {
          return yield* Effect.die('Expected retained object metadata')
        }
        // The equivalent objects have different insertion order, making the chosen retained generation observable.
        expect(Object.keys(metadata)).toEqual(['nested', 'cursor'])
        expect(yield* Events.readBackendHead(source)).toBe(0)
      }),
    ))

  it('compares legal JSON property names as data rather than invoking object conversion methods', () =>
    run(
      Effect.gen(function* () {
        const { source, fresh } = yield* makeMemorySource()
        yield* Identity.initialize(source, fresh!)
        const older = Option.some({ constructor: { retained: true }, toString: 'ordinary data', valueOf: 7 })
        const newer = Option.some({ valueOf: 7, toString: 'ordinary data', constructor: { retained: true } })
        yield* source.transaction((transaction) =>
          Events.insert(transaction, [
            { ...stored(5), syncMetadata: older },
            { ...stored(5, 0, 1), syncMetadata: newer },
          ]),
        )
        const info = Option.getOrThrow(
          yield* Events.getSyncBackendCursorInfo(source, { remoteHead: sequence(5).global }),
        )
        expect(info.metadata).toEqual(newer)
      }),
    ))

  it('fences conflicting valid metadata before publication even when the caller catches the invariant failure', () =>
    run(
      Effect.gen(function* () {
        const { source, fresh, rolledBackImages } = yield* makeMemorySource()
        yield* Identity.initialize(source, fresh!)
        const items = [
          { ...stored(5), syncMetadata: Option.some({ cursor: 'first' }) },
          { ...stored(5, 0, 1), syncMetadata: Option.some({ cursor: 'different' }) },
        ]
        yield* source.transaction((transaction) => Events.insert(transaction, items))
        const attempted = yield* Effect.exit(
          source.transaction((transaction) =>
            Effect.gen(function* () {
              yield* Events.insert(transaction, [stored(6)])
              yield* Events.updateBackendHead(transaction, sequence(6).global)
              yield* Events.getSyncBackendCursorInfo(transaction, { remoteHead: sequence(5).global }).pipe(
                Effect.ignore,
              )
            }),
          ),
        )
        expect(attempted._tag).toBe('Failure')
        expect((yield* Effect.exit(source.export))._tag).toBe('Failure')
        expect(rolledBackImages).toHaveLength(1)
        yield* source.close
        const reopened = (yield* makeMemorySource(rolledBackImages[0]!)).source
        expect(yield* Events.readPage(reopened, { includeClientOnly: true })).toEqual(items)
        expect(yield* Events.readBackendHead(reopened)).toBe(0)
      }),
    ))

  it('treats None versus Some at the same logical position as a fenced conflict, not fallback metadata', () =>
    run(
      Effect.gen(function* () {
        const { source, fresh } = yield* makeMemorySource()
        yield* Identity.initialize(source, fresh!)
        yield* source.transaction((transaction) =>
          Events.insert(transaction, [
            stored(5),
            { ...stored(5, 0, 2), syncMetadata: Option.some({ cursor: 'only-one-generation' }) },
          ]),
        )
        expect(
          (yield* Effect.exit(Events.getSyncBackendCursorInfo(source, { remoteHead: sequence(5).global })))._tag,
        ).toBe('Failure')
        expect((yield* Effect.exit(Events.readClientHead(source)))._tag).toBe('Failure')
      }),
    ))

  it('confirms and deletes every retained generation at a logical position', () =>
    run(
      Effect.gen(function* () {
        const { source, fresh } = yield* makeMemorySource()
        yield* Identity.initialize(source, fresh!)
        const original = stored(5),
          newer = stored(5, 0, 2),
          otherClient = stored(5, 1)
        yield* source.transaction((transaction) => Events.insert(transaction, [original, newer, otherClient]))
        const metadata = Option.some({ cursor: 'all-confirmed-generations' })
        yield* source.transaction((transaction) =>
          Events.updateSyncMetadata(transaction, [{ event: newer.event, syncMetadata: metadata }]),
        )
        expect(yield* Events.readAfterComposite(source, sequence(4))).toEqual([
          { ...original, syncMetadata: metadata },
          { ...newer, syncMetadata: metadata },
          otherClient,
        ])
        expect(
          Option.getOrThrow(yield* Events.getSyncBackendCursorInfo(source, { remoteHead: sequence(5).global }))
            .metadata,
        ).toEqual(metadata)
        yield* source.transaction((transaction) => Events.deletePositions(transaction, [newer.event.seqNum]))
        expect(yield* Events.readAfterComposite(source, sequence(4))).toEqual([otherClient])
      }),
    ))

  it('shares row decoding and explicit attribution normalization without changing unknown event arguments', () =>
    run(
      Effect.gen(function* () {
        const { source, fresh } = yield* makeMemorySource()
        yield* Identity.initialize(source, fresh!)
        const original = {
          ...stored(1).event,
          name: 'unknown.future.event',
          args: { nested: [{ future: true }], nullable: null },
        }
        const normalized = Events.normalizeStoredEvent(original, {
          clientId: 'override-client',
          sessionId: 'override-session',
          schemaHash: 9,
        })
        expect(normalized.event.args).toEqual(original.args)
        expect(original.clientId).toBe('client-A')
        expect(normalized.event.clientId).toBe('override-client')
        expect(normalized.event.sessionId).toBe('override-session')
        yield* source.transaction((transaction) => Events.insert(transaction, [normalized]))
        const raw = yield* source.select('SELECT * FROM eventlog')
        expect(yield* Events.decodeStoredEvents(source, raw)).toEqual([normalized])
        expect(
          yield* Events.selectStoredEvents(source, 'SELECT * FROM eventlog WHERE name = ?', ['unknown.future.event']),
        ).toEqual([normalized])
        expect((yield* Effect.exit(Events.decodeStoredEvents(source, [{}])))._tag).toBe('Failure')
        expect((yield* Effect.exit(source.export))._tag).toBe('Failure')
      }),
    ))
})
