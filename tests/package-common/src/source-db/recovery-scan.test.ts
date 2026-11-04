import { describe, expect, it } from 'vitest'

import { SourceEvents, SourceIdentity } from '@livestore/common/source-db'
import type { CaptureLimits, SourceRecoveryRow } from '@livestore/common/source-maintenance'
import { scanSource } from '@livestore/common/source-maintenance/internal'
import { Effect, Option } from '@livestore/utils/effect'

import { makeMemorySource, run, stored } from './fixture.ts'

const limits: CaptureLimits = { maxRows: 100, maxBytes: 100_000, maxRowBytes: 10_000, pageSize: 1 }
const confirmed = (global: number, generation = 0) => {
  const original = stored(global, 0, generation)
  return { ...original, event: { ...original.event, name: 'future.Unknown', args: { position: global } } }
}

describe('bounded retained SOURCE scanner on actual SQLite', () => {
  it('preserves raw JSON and all residual generations, independent of page boundaries', () =>
    run(
      Effect.gen(function* () {
        const { source, fresh } = yield* makeMemorySource()
        yield* SourceIdentity.initialize(source, fresh!)
        yield* source.transaction((tx) =>
          Effect.gen(function* () {
            yield* SourceEvents.insert(tx, [
              confirmed(1),
              confirmed(1, 2),
              confirmed(2),
              stored(2, 1),
              stored(2, 1, 3),
              confirmed(3),
            ])
            yield* SourceEvents.updateBackendHead(tx, confirmed(2).event.seqNum.global)
            yield* tx.execute('UPDATE eventlog SET argsJson = ? WHERE seqNumGlobal = 1', [' { "position" : 1 } '])
            yield* tx.execute('UPDATE eventlog SET syncMetadataJson = ? WHERE seqNumGlobal = 1', [
              ' { "_tag" : "Some", "value" : {"cursor":"original"} } ',
            ])
          }),
        )
        const captured: SourceRecoveryRow[] = []
        const first = yield* source.transaction((tx) =>
          scanSource(tx, limits, (_index, rows) =>
            Effect.sync(() => {
              captured.push(...rows)
            }),
          ),
        )
        const second = yield* source.transaction((tx) => scanSource(tx, { ...limits, pageSize: 4 }))
        expect(first.snapshot).toEqual(second.snapshot)
        expect(first.coverage).toEqual(second.coverage)
        expect(first.coverage).toMatchObject({ status: 'complete', provenThrough: 2 })
        expect(first.snapshot.rows).toBe(6)
        expect(captured[0]!.argsJson).toBe(' { "position" : 1 } ')
        expect(captured[0]!.syncMetadataJson).toBe(' { "_tag" : "Some", "value" : {"cursor":"original"} } ')
        yield* source.transaction((tx) =>
          SourceEvents.updateSyncMetadata(
            tx,
            [confirmed(1)].map(({ event }) => ({ event, syncMetadata: Option.none() })),
          ),
        )
        const cleared = yield* source.transaction((tx) => scanSource(tx, limits))
        expect(cleared.snapshot.eventDigest).toBe(first.snapshot.eventDigest)
        expect(cleared.snapshot.rowDigest).toBe(first.snapshot.clearedMetadataRowDigest)
      }),
    ))

  it('includes never-synced global-zero pending work and reports absent acknowledged prefix', () =>
    run(
      Effect.gen(function* () {
        const { source, fresh } = yield* makeMemorySource()
        yield* SourceIdentity.initialize(source, fresh!)
        yield* source.transaction((tx) => SourceEvents.insert(tx, [stored(0, 1)]))
        const emptyPrefix = yield* source.transaction((tx) => scanSource(tx, limits))
        expect(emptyPrefix.snapshot.rows).toBe(1)
        expect(emptyPrefix.coverage).toMatchObject({ status: 'complete', provenThrough: 0 })
        yield* source.transaction((tx) => SourceEvents.updateBackendHead(tx, confirmed(1).event.seqNum.global))
        const missing = yield* source.transaction((tx) => scanSource(tx, limits))
        expect(missing.coverage).toMatchObject({ status: 'incomplete', provenThrough: 0 })
      }),
    ))

  it('retains conflicting generation bodies while refusing prefix coverage', () =>
    run(
      Effect.gen(function* () {
        const { source, fresh } = yield* makeMemorySource()
        yield* SourceIdentity.initialize(source, fresh!)
        const conflict = confirmed(1, 2)
        yield* source.transaction((tx) =>
          Effect.gen(function* () {
            yield* SourceEvents.insert(tx, [confirmed(1), { ...conflict, event: { ...conflict.event, args: null } }])
            yield* SourceEvents.updateBackendHead(tx, conflict.event.seqNum.global)
          }),
        )
        const result = yield* source.transaction((tx) => scanSource(tx, limits))
        expect(result.snapshot.rows).toBe(2)
        expect(result.coverage).toMatchObject({ status: 'conflicting', provenThrough: 0 })
      }),
    ))

  it('rejects oversized cells in preflight before delivering any chunk', () =>
    run(
      Effect.gen(function* () {
        const { source, fresh } = yield* makeMemorySource()
        yield* SourceIdentity.initialize(source, fresh!)
        yield* source.transaction((tx) =>
          SourceEvents.insert(tx, [{ ...confirmed(1), event: { ...confirmed(1).event, args: 'x'.repeat(1000) } }]),
        )
        let callbacks = 0
        const result = yield* Effect.exit(
          source.transaction((tx) =>
            scanSource(tx, { ...limits, maxRowBytes: 100 }, () =>
              Effect.sync(() => {
                callbacks++
              }),
            ),
          ),
        )
        expect(result._tag).toBe('Failure')
        expect(callbacks).toBe(0)
        expect((yield* Effect.exit(source.transaction((tx) => scanSource(tx, { ...limits, maxRows: 0 }))))._tag).toBe(
          'Failure',
        )
      }),
    ))
  it('measures wire continuity without discarding local parent-generation evidence', () =>
    run(
      Effect.gen(function* () {
        const { source, fresh } = yield* makeMemorySource()
        yield* SourceIdentity.initialize(source, fresh!)
        const child = confirmed(2)
        yield* source.transaction((tx) =>
          Effect.gen(function* () {
            yield* SourceEvents.insert(tx, [
              confirmed(1),
              {
                ...child,
                event: { ...child.event, parentSeqNum: { ...child.event.parentSeqNum, rebaseGeneration: 9 } },
              },
            ])
            yield* SourceEvents.updateBackendHead(tx, child.event.seqNum.global)
          }),
        )
        const result = yield* source.transaction((tx) => scanSource(tx, limits))
        expect(result.snapshot.rows).toBe(2)
        expect(result.coverage).toMatchObject({ status: 'complete', provenThrough: 2 })
      }),
    ))

  it('refuses a root event row and a nonsingleton sync status instead of skipping them', () =>
    run(
      Effect.gen(function* () {
        const { source, fresh } = yield* makeMemorySource()
        yield* SourceIdentity.initialize(source, fresh!)
        yield* source.transaction((tx) => SourceEvents.insert(tx, [stored(0)]))
        expect((yield* Effect.exit(source.transaction((tx) => scanSource(tx, limits))))._tag).toBe('Failure')
        yield* source.transaction((tx) =>
          tx.execute('DELETE FROM eventlog; INSERT INTO __livestore_sync_status(head) VALUES (1)'),
        )
        expect((yield* Effect.exit(source.transaction((tx) => scanSource(tx, limits))))._tag).toBe('Failure')
      }),
    ))

  it('enforces row-count and aggregate byte limits before staging an oversized page', () =>
    run(
      Effect.gen(function* () {
        const { source, fresh } = yield* makeMemorySource()
        yield* SourceIdentity.initialize(source, fresh!)
        yield* source.transaction((tx) => SourceEvents.insert(tx, [confirmed(1), confirmed(2)]))
        expect((yield* Effect.exit(source.transaction((tx) => scanSource(tx, { ...limits, maxRows: 1 }))))._tag).toBe(
          'Failure',
        )
        let staged = 0
        expect(
          (yield* Effect.exit(
            source.transaction((tx) =>
              scanSource(tx, { ...limits, maxBytes: 20, pageSize: 2 }, () =>
                Effect.sync(() => {
                  staged++
                }),
              ),
            ),
          ))._tag,
        ).toBe('Failure')
        expect(staged).toBe(0)
      }),
    ))
})
