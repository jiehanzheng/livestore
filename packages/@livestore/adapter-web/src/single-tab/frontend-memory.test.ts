import { afterAll, expect, test, vi } from 'vitest'

import type { AdapterArgs, BootStatus } from '@livestore/common'
import { makeSchema, State } from '@livestore/common/schema'
import { inMemorySqliteDbFactory, sqliteDbFactory } from '@livestore/sqlite-wasm/browser'
import type * as WasmLoader from '@livestore/sqlite-wasm/load-wasm'
import { Effect, Exit, Queue } from '@livestore/utils/effect'
import type { SQLiteAPI } from '@livestore/wa-sqlite'

import { makeOwnedOpfsFixture } from '../web-worker/common/opfs-owner.test-fixture.ts'

const observed = vi.hoisted(() => ({ apis: [] as SQLiteAPI[] }))
vi.mock('@livestore/sqlite-wasm/load-wasm', async (original) => {
  const real = await original<typeof WasmLoader>()
  return {
    ...real,
    loadSqlite3Wasm: async () => {
      const api = await real.loadSqlite3Wasm()
      observed.apis.push(api)
      return api
    },
  }
})
afterAll(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

test('twenty real single-tab frontends acquire the shared memory factory, never a physical API owner', async () => {
  const fs = makeOwnedOpfsFixture(),
    requests: Promise<unknown>[] = []
  vi.stubGlobal('window', {})
  vi.stubGlobal('sessionStorage', {})
  vi.stubEnv('SSR', false)
  vi.stubGlobal('navigator', {
    storage: { getDirectory: async () => fs.rootDirectory },
    locks: {
      request: (name: string, _options: unknown, callback: (lock: Lock) => Promise<unknown>) => {
        const request = Promise.resolve(callback({ name, mode: 'exclusive' } as Lock))
        requests.push(request)
        return request
      },
    },
  })
  const { makeSingleTabAdapter } = await import('./single-tab-adapter.ts')
  const schema = makeSchema({
    projectionRevision: 'single-tab-frontend-memory',
    events: [],
    state: State.SQLite.makeState({ tables: {}, materializers: {} }),
  })
  let workerBoundary = 0
  for (let graph = 0; graph < 20; graph++) {
    const bootStatusQueue = Effect.runSync(Queue.unbounded<BootStatus>())
    const args: AdapterArgs = {
      schema,
      storeId: `frontend-memory-${graph}`,
      params: { stateRebuildBatchSize: 100 },
      devtoolsEnabled: false,
      debugInstanceId: `frontend-${graph}`,
      bootStatusQueue,
      shutdown: () => Effect.void,
      connectDevtoolsToStore: () => Effect.void,
      syncPayloadEncoded: undefined,
      syncPayloadSchema: undefined,
    }
    const adapter = makeSingleTabAdapter({
      storage: { type: 'opfs' },
      clientId: 'frontend',
      sessionId: `session-${graph}`,
      experimental: { disableFastPath: true },
      worker: () => {
        workerBoundary++
        throw new Error('Controlled stop before allocating the dedicated physical worker')
      },
    })
    expect(Exit.isFailure(await Effect.runPromiseExit(Effect.scoped(adapter(args))))).toBe(true)
    Effect.runSync(Queue.shutdown(bootStatusQueue))
  }
  await Promise.all(requests)
  expect(workerBoundary).toBe(20)
  expect(observed.apis).toHaveLength(1)
  const api = observed.apis[0]!
  // This proves the actual factory claimed memory-only ownership, not just that a named mock was called.
  expect(Exit.isFailure(await Effect.runPromiseExit(Effect.scoped(sqliteDbFactory({ sqlite3: api }))))).toBe(true)
  const makeMemory = Effect.runSync(inMemorySqliteDbFactory({ sqlite3: api }))
  const db = Effect.runSync(makeMemory({ _tag: 'in-memory' }))
  expect(db.select('select 42 as value')).toEqual([{ value: 42 }])
  db.close()
  expect(fs.activeHandles()).toBe(0)
})
