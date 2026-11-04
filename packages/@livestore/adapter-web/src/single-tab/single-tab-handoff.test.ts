import { afterEach, expect, it, vi } from 'vitest'

import type { BootStatus } from '@livestore/common'
import { makeSchema, State } from '@livestore/common/schema'
import { Effect, Exit, Fiber, Queue, Scope } from '@livestore/utils/effect'

import { makeWorkerEffect } from '../web-worker/leader-worker/make-leader-worker.ts'
import { makeSingleTabAdapter } from './single-tab-adapter.ts'

afterEach(() => vi.unstubAllGlobals())

it('joins the actual single-tab adapter and custom-port worker before releasing election', async () => {
  let held = false
  let release!: () => void
  const released = new Promise<void>((resolve) => {
    release = resolve
  })
  vi.stubGlobal('navigator', {
    storage: {
      getDirectory: async () => {
        throw new DOMException('Test private storage', 'SecurityError')
      },
    },
    locks: {
      request(
        name: string,
        options: { ifAvailable?: boolean },
        callback: (lock: { name: string; mode: 'exclusive' } | null) => unknown,
      ) {
        if (held === true && options.ifAvailable === true) return Promise.resolve(callback(null))
        if (held === true) throw new Error('Unexpected queued election')
        held = true
        return Promise.resolve(callback({ name, mode: 'exclusive' })).finally(() => {
          held = false
          release()
        })
      },
    },
  })
  vi.stubGlobal('window', {})
  vi.stubGlobal('sessionStorage', {})
  const data = new MessageChannel()
  vi.stubGlobal('self', data.port2)
  const schema = makeSchema({
    projectionRevision: 'single-tab-handoff-v1',
    events: {},
    state: State.SQLite.makeState({ tables: {}, materializers: {} }),
  })
  const receiver = Effect.runFork(makeWorkerEffect({ schema, transport: data.port2, logLevel: 'None' }))
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const scope = yield* Scope.make()
          yield* Effect.addFinalizer((exit) => Scope.close(scope, exit))
          const session = yield* makeSingleTabAdapter({
            worker: () => data.port1,
            storage: { type: 'opfs' },
            clientId: 'client',
            sessionId: 'session',
            experimental: { disableFastPath: true },
          })({
            schema,
            storeId: 'single-tab-handoff',
            params: { stateRebuildBatchSize: 100 },
            devtoolsEnabled: false,
            debugInstanceId: 'handoff',
            bootStatusQueue: yield* Queue.unbounded<BootStatus>(),
            shutdown: () => Effect.void,
            connectDevtoolsToStore: () => Effect.void,
            syncPayloadSchema: undefined,
            syncPayloadEncoded: undefined,
          }).pipe(Scope.provide(scope))
          expect(session.clientId).toBe('client')
          expect(
            session.sqliteDb.select<{ count: number }>('select count(*) as count from sqlite_master')[0]?.count,
          ).toBeGreaterThan(0)
          expect(held).toBe(true)
          yield* Scope.close(scope, Exit.void)
          yield* Fiber.await(receiver)
          yield* Effect.promise(() => released)
          expect(held).toBe(false)
          expect(receiver.pollUnsafe()).toBeDefined()
        }),
      ),
    )
  } finally {
    await Effect.runPromise(Fiber.interrupt(receiver))
    data.port1.close()
    data.port2.close()
  }
})
