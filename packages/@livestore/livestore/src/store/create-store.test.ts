import { expect } from 'vitest'

import { type Adapter, OtelLiveDummy, UnknownError } from '@livestore/common'
import { Vitest } from '@livestore/utils-dev/node-vitest'
import { Effect } from '@livestore/utils/effect'

import { makeTodoMvc, schema } from '../utils/tests/fixture.ts'
import { createStore } from './create-store.ts'

Vitest.live('rejects a canonical SOURCE read when the adapter has no persisted owner', () =>
  Effect.gen(function* () {
    const store = yield* makeTodoMvc()
    yield* Effect.promise(async () => {
      await expect(store.getSourceIncarnation()).rejects.toThrow('does not expose a persisted SOURCE incarnation')
      await expect(store.getSourceBackendId()).rejects.toThrow('does not expose a persisted SOURCE backend identity')
    })
  }).pipe(Effect.scoped),
)

Vitest.live('validates stateRebuildBatchSize before invoking the adapter', () =>
  Effect.gen(function* () {
    const observedBatchSizes: number[] = []
    const adapter: Adapter = ({ params }) => {
      observedBatchSizes.push(params.stateRebuildBatchSize)
      return Effect.fail(UnknownError.make({ cause: 'adapter sentinel' }))
    }
    const run = (stateRebuildBatchSize?: number) =>
      createStore({
        schema,
        adapter,
        storeId: 'batch-size-test',
        ...(stateRebuildBatchSize === undefined ? {} : { params: { stateRebuildBatchSize } }),
      }).pipe(Effect.scoped, Effect.exit)

    for (const invalid of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect((yield* run(invalid))._tag).toBe('Failure')
    }
    expect(observedBatchSizes).toEqual([])

    yield* run()
    yield* run(1)
    yield* run(100_000)
    expect(observedBatchSizes).toEqual([100, 1, 100_000])
  }).pipe(Effect.provide(OtelLiveDummy)),
)
