import { expect, it } from 'vitest'

import { LegacyStorageFormatError, toAdapterError } from '@livestore/common'
import {
  assertInitialized,
  fromSourceDb,
  initializeSource,
  SourceDbError,
  type SourceBindings,
  type SourceRow,
} from '@livestore/common/source-db'
import { Deferred, Effect, Fiber } from '@livestore/utils/effect'

import { makeMemorySource, run } from './fixture.ts'

it.each(['initialize', 'revalidate'] as const)('refuses a proof when identical image import races %s', (operation) =>
  run(
    Effect.gen(function* () {
      const { source, fresh, storageName } = yield* makeMemorySource()
      const owner = fromSourceDb(source, { fresh: fresh!, storageName })
      const proof = yield* initializeSource(owner)
      const image = yield* source.export
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const select = source.select
      source.select = <Row extends object = SourceRow>(sql: string, bindings?: SourceBindings) =>
        select<Row>(sql, bindings).pipe(
          Effect.tap(() =>
            sql.includes('SELECT * FROM __livestore_source_identity') === true
              ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)))
              : Effect.void,
          ),
        )
      const checking = yield* (
        operation === 'revalidate'
          ? assertInitialized(source, proof).pipe(Effect.asVoid)
          : initializeSource(fromSourceDb(source, { storageName })).pipe(Effect.asVoid)
      ).pipe(Effect.exit, Effect.forkChild)
      yield* Deferred.await(entered)
      yield* source.import(image)
      yield* Deferred.succeed(release, undefined)
      expect((yield* Fiber.join(checking))._tag).toBe('Failure')
    }),
  ),
)

it('preserves a typed compatibility refusal through the SOURCE adapter boundary', () => {
  const refusal = new LegacyStorageFormatError({
    expectedFormatVersion: 7,
    actualFormatVersion: 6,
    reason: 'retained source',
  })
  expect(toAdapterError(new SourceDbError({ operation: 'source-identity', cause: refusal }))).toBe(refusal)
})
