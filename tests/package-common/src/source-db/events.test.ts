import { describe, expect, it } from 'vitest'

import { liveStoreStorageFormatVersion } from '@livestore/common'
import { SystemTables } from '@livestore/common/schema'
import { SourceEvents as Events, SourceIdentity as Identity, SourceSchema } from '@livestore/common/source-db'
import { Effect, Option } from '@livestore/utils/effect'

import { makeMemorySource, run, sequence, stored } from './fixture.ts'

const { eventlogSystemTables, SOURCE_IDENTITY_TABLE } = SystemTables
const { listSourceTables } = SourceSchema

describe('effectful SOURCE helpers with actual SQLite', () => {
  it('initializes the current eventlog AST and preserves its real encoded row codecs', () =>
    run(
      Effect.gen(function* () {
        const { source, fresh } = yield* makeMemorySource()
        const identity = yield* Identity.initialize(source, fresh!)
        expect(identity.formatVersion).toBe(liveStoreStorageFormatVersion)
        expect(identity.incarnation.length).toBeGreaterThan(0)
        expect(yield* Identity.read(source)).toEqual(identity)
        expect(yield* listSourceTables(source)).toEqual(
          new Set(eventlogSystemTables.map((table) => table.sqliteDef.name)),
        )
        const item = { ...stored(1), syncMetadata: Option.some({ cursor: 'confirmed-1', nested: { ok: true } }) }
        yield* source.transaction((transaction) => Events.insert(transaction, [item]))
        expect(yield* Events.readPage(source)).toEqual([item])
        expect(yield* Events.readClientHead(source)).toEqual(item.event.seqNum)
        expect(yield* Events.readBackendHead(source)).toBe(0)
        expect(Option.isNone(yield* Events.readBackendId(source))).toBe(true)
        expect((yield* Effect.exit(Identity.initialize(source, fresh!)))._tag).toBe('Failure')
        expect(yield* Identity.read(source)).toEqual(identity)
      }),
    ))

  it('round-trips unknown JSON arguments with original attribution and schema hashes', () =>
    run(
      Effect.gen(function* () {
        const { source, fresh } = yield* makeMemorySource()
        yield* Identity.initialize(source, fresh!)
        const items = [null, 'unknown scalar', [null, 1, { future: true }]].map((args, index) => {
          const original = stored(index + 1)
          return Events.normalizeStoredEvent(
            { ...original.event, name: 'future.UnknownEvent', args },
            { schemaHash: 100 + index, clientId: 'original-client', sessionId: 'original-session' },
          )
        })
        yield* source.transaction((transaction) => Events.insert(transaction, items))
        expect(yield* Events.readPage(source)).toEqual(items)
        const reopened = (yield* makeMemorySource(yield* source.export)).source
        expect(yield* Events.readPage(reopened)).toEqual(items)
      }),
    ))

  it('rolls back event insert, metadata and backend progress together after a transaction callback fails', () =>
    run(
      Effect.gen(function* () {
        const { source, fresh } = yield* makeMemorySource()
        yield* Identity.initialize(source, fresh!)
        const original = stored(1)
        yield* source.transaction((transaction) => Events.insert(transaction, [original]))
        const failed = yield* Effect.exit(
          source.transaction((transaction) =>
            Effect.gen(function* () {
              yield* Events.insert(transaction, [stored(2)])
              yield* Events.updateSyncMetadata(transaction, [
                { event: original.event, syncMetadata: Option.some({ cursor: 'uncommitted' }) },
              ])
              yield* Events.updateBackendHead(transaction, sequence(2).global)
              yield* Events.updateBackendId(transaction, 'uncommitted-backend')
              return yield* Effect.fail('Reject the completed SQL writes before COMMIT')
            }),
          ),
        )
        expect(failed._tag).toBe('Failure')
        expect(yield* Events.readPage(source)).toEqual([original])
        expect(yield* Events.readBackendHead(source)).toBe(0)
        expect(Option.isNone(yield* Events.readBackendId(source))).toBe(true)
      }),
    ))

  it('rolls back a real SQLite constraint failure and fences its owner until a retained-image reopen', () =>
    run(
      Effect.gen(function* () {
        const { source, fresh, rolledBackImages } = yield* makeMemorySource()
        const identity = yield* Identity.initialize(source, fresh!)
        const original = stored(1)
        yield* source.transaction((transaction) => Events.insert(transaction, [original]))
        const failed = yield* Effect.exit(
          source.transaction((transaction) =>
            Effect.gen(function* () {
              yield* Events.insert(transaction, [stored(2)])
              yield* Events.updateBackendHead(transaction, sequence(2).global)
              yield* Events.insert(transaction, [original])
            }),
          ),
        )
        expect(failed._tag).toBe('Failure')
        expect((yield* Effect.exit(Events.readPage(source)))._tag).toBe('Failure')
        expect(rolledBackImages).toHaveLength(1)
        yield* source.close
        const reopened = (yield* makeMemorySource(rolledBackImages[0]!)).source
        expect(yield* Identity.read(reopened)).toEqual(identity)
        expect(yield* Events.readPage(reopened)).toEqual([original])
        expect(yield* Events.readBackendHead(reopened)).toBe(0)
      }),
    ))

  it('preserves pending events and atomically replaces their logical position on confirmation', () =>
    run(
      Effect.gen(function* () {
        const { source, fresh } = yield* makeMemorySource()
        yield* Identity.initialize(source, fresh!)
        const base = stored(1),
          pending = stored(1, 1),
          rebased = stored(1, 1, 1)
        yield* source.transaction((transaction) => Events.insert(transaction, [base, pending, rebased]))
        expect(yield* Events.readPending(source)).toEqual([pending, rebased])
        const confirmed = { ...stored(2), syncMetadata: Option.some({ cursor: 'confirmation-2' }) }
        yield* source.transaction((transaction) =>
          Effect.gen(function* () {
            yield* Events.deletePositions(transaction, [pending.event.seqNum])
            yield* Events.insert(transaction, [{ ...confirmed, syncMetadata: Option.none() }])
            yield* Events.updateSyncMetadata(transaction, [
              { event: confirmed.event, syncMetadata: confirmed.syncMetadata },
            ])
            yield* Events.updateBackendHead(transaction, confirmed.event.seqNum.global)
            yield* Events.updateBackendId(transaction, 'backend-A')
          }),
        )
        expect(yield* Events.readPending(source)).toEqual([])
        expect(yield* Events.readPage(source)).toEqual([base, confirmed])
        expect(yield* Events.readBackendHead(source)).toBe(2)
        expect(yield* Events.readBackendId(source)).toEqual(Option.some('backend-A'))
      }),
    ))

  it('pages across client and rebase components without skipping retained event incarnations', () =>
    run(
      Effect.gen(function* () {
        const { source, fresh } = yield* makeMemorySource()
        yield* Identity.initialize(source, fresh!)
        const items = [stored(1), stored(1, 1), stored(1, 1, 1), stored(2)]
        yield* source.transaction((transaction) => Events.insert(transaction, items))
        const first = yield* Events.readPage(source, { limit: 2, includeClientOnly: true })
        const second = yield* Events.readPage(source, {
          since: first[1]!.event.seqNum,
          limit: 2,
          includeClientOnly: true,
        })
        expect([...first, ...second]).toEqual(items)
        expect(yield* Events.readPage(source, { until: sequence(1, 1), includeClientOnly: true })).toEqual(
          items.slice(0, 2),
        )
        expect(yield* Events.readPage(source, { names: ['unknown-event'], includeClientOnly: true })).toEqual([])
        expect((yield* Effect.exit(Events.readPage(source, { limit: 0 })))._tag).toBe('Failure')
      }),
    ))

  it('reopens exported SOURCE bytes with the same identity, pending originals, metadata and heads', () =>
    run(
      Effect.gen(function* () {
        const { source, fresh } = yield* makeMemorySource()
        const identity = yield* Identity.initialize(source, fresh!)
        const confirmed = { ...stored(1), syncMetadata: Option.some({ cursor: 'retained-cursor' }) },
          pending = stored(1, 1)
        yield* source.transaction((transaction) =>
          Effect.gen(function* () {
            yield* Events.insert(transaction, [confirmed, pending])
            yield* Events.updateBackendHead(transaction, confirmed.event.seqNum.global)
            yield* Events.updateBackendId(transaction, 'retained-backend')
          }),
        )
        const bytes = yield* source.export
        yield* source.close
        const reopened = (yield* makeMemorySource(bytes)).source
        expect(yield* Identity.read(reopened)).toEqual(identity)
        expect(yield* Events.readPending(reopened)).toEqual([pending])
        expect(yield* Events.readPage(reopened)).toEqual([confirmed])
        expect(yield* Events.readClientHead(reopened)).toEqual(pending.event.seqNum)
        expect(yield* Events.readBackendHead(reopened)).toBe(1)
        expect(yield* Events.readBackendId(reopened)).toEqual(Option.some('retained-backend'))
      }),
    ))

  it('refuses incompatible retained identity read-only and rotates a current identity only inside a transaction', () =>
    run(
      Effect.gen(function* () {
        const { source, fresh } = yield* makeMemorySource()
        const original = yield* Identity.initialize(source, fresh!)
        const rotated = yield* source.transaction(Identity.rotate)
        expect(rotated.incarnation).not.toBe(original.incarnation)
        yield* source.transaction((transaction) =>
          transaction.execute(`UPDATE ${SOURCE_IDENTITY_TABLE} SET formatVersion = ?`, [-1]),
        )
        const bytes = yield* source.export
        expect((yield* Effect.exit(Identity.read(source)))._tag).toBe('Failure')
        expect(yield* source.export).toEqual(bytes)
      }),
    ))
})
