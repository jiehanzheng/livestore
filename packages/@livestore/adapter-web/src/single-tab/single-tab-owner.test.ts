import { afterEach, expect, it, vi } from 'vitest'

import type { BootStatus } from '@livestore/common'
import { makeSchema, State } from '@livestore/common/schema'
import { Effect, Queue } from '@livestore/utils/effect'

import { loadInMemorySqlite3 } from '../web-worker/client-session/sqlite-loader.ts'
import { makeSingleTabAdapter } from './single-tab-adapter.ts'

vi.mock('../web-worker/client-session/sqlite-loader.ts', () => ({
  loadInMemorySqlite3: vi.fn(() => {
    throw new Error('Database factory reached before physical ownership')
  }),
}))
afterEach(() => vi.unstubAllGlobals())

it('refuses an occupied single-tab owner without waiting or opening storage', () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const request = vi.fn((_name, options, callback) => {
        expect(options).toMatchObject({ ifAvailable: true, mode: 'exclusive' })
        return Promise.resolve(callback(null))
      })
      vi.stubGlobal('navigator', { locks: { request }, storage: {} })
      vi.stubGlobal('window', {})
      vi.stubGlobal('sessionStorage', {})
      const worker = vi.fn(() => {
        throw new Error('Worker must not start without physical ownership')
      })
      const schema = makeSchema({
        projectionRevision: 'single-tab-ownership-test-v1',
        events: {},
        state: State.SQLite.makeState({ tables: {}, materializers: {} }),
      })
      const result = yield* makeSingleTabAdapter({ worker, storage: { type: 'opfs' } })({
        schema,
        storeId: 'occupied-owner',
        params: { stateRebuildBatchSize: 100 },
        devtoolsEnabled: false,
        debugInstanceId: 'test',
        bootStatusQueue: yield* Queue.unbounded<BootStatus>(),
        shutdown: () => Effect.void,
        connectDevtoolsToStore: () => Effect.void,
        syncPayloadSchema: undefined,
        syncPayloadEncoded: undefined,
      }).pipe(Effect.result)
      expect(result).toMatchObject({
        _tag: 'Failure',
        failure: {
          _tag: 'UnknownError',
          cause: 'Single-tab storage already has an active owner; close it before opening another store',
        },
      })
      expect(request).toHaveBeenCalledExactlyOnceWith(
        'livestore-tab-lock-occupied-owner',
        expect.anything(),
        expect.anything(),
      )
      expect(worker).not.toHaveBeenCalled()
      expect(loadInMemorySqlite3).not.toHaveBeenCalled()
    }).pipe(Effect.scoped),
  ))
