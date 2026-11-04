import { expect, test } from 'vitest'

import type { SqliteDb } from '@livestore/common'
import type { CfTypes } from '@livestore/common-cf'
import { EventSequenceNumber } from '@livestore/common/schema'
import { makeHostedSource } from '@livestore/common/source-db'
import {
  captureSource,
  SourceMaintenanceError,
  type SourceMaintenanceLocationOwner,
} from '@livestore/common/source-maintenance'
import { retainedSourceMaintenanceOpener, withRetainedSource } from '@livestore/common/source-maintenance/internal'
import { Deferred, Effect, Exit, Fiber, Result } from '@livestore/utils/effect'

import { makeTransactionHost } from './transaction-host.ts'

test('borrowed native frame refuses capture without attesting joined outer closure', async () => {
  const log: string[] = []
  // Same controlled Durable Object transaction boundary as transaction-host.test.ts.
  const storage = {
    transaction: async <A>(callback: () => Promise<A>) => {
      log.push('begin')
      try {
        const result = await callback()
        log.push('commit')
        return result
      } catch (error) {
        log.push('rollback')
        throw error
      }
    },
    sync: async () => {
      log.push('sync')
    },
  } as unknown as CfTypes.DurableObjectStorage
  const host = makeTransactionHost(storage, () => {
    log.push('close-state')
  })
  const db: Pick<SqliteDb, 'execute' | 'select' | 'close' | 'debug'> = {
    debug: { head: EventSequenceNumber.Client.ROOT },
    execute: () => {},
    select: () => [],
    close: () => {
      log.push('logical-close')
    },
  }
  const source = await Effect.runPromise(makeHostedSource(db, { host, storageName: 'native-source' }))
  let observed: SourceMaintenanceError | undefined
  const locationOwner: SourceMaintenanceLocationOwner = {
    run: (_context, effect) =>
      Effect.gen(function* () {
        log.push('location-enter')
        const result = yield* Effect.result(effect)
        if (Result.isFailure(result) === true) {
          if (result.failure instanceof SourceMaintenanceError) observed = result.failure
          log.push(observed?.closure === 'joined' ? 'location-release' : 'location-retain')
          return yield* Effect.fail(result.failure)
        }
        log.push('location-release')
        return result.success
      }),
  }
  const binding = { operationId: 'borrowed-host', context: null }
  const opener = retainedSourceMaintenanceOpener({
    binding,
    locationOwner,
    acquire: Effect.acquireRelease(Effect.succeed(source), (owner) => owner.close.pipe(Effect.orDie)),
  })
  const result = await Effect.runPromiseExit(
    host.runTransaction(
      Effect.gen(function* () {
        const capture = yield* Effect.result(
          captureSource({
            opener,
            binding,
            limits: { maxRows: 10, maxBytes: 10000, maxRowBytes: 1000, pageSize: 1 },
            provenance: {},
            sink: {
              begin: () =>
                Effect.sync(() => {
                  log.push('begin-capture')
                }),
              chunk: () => Effect.void,
              seal: () =>
                Effect.sync(() => {
                  log.push('seal')
                }),
            },
          }),
        )
        expect(Result.isFailure(capture)).toBe(true)
        expect(log).not.toContain('commit')
        expect(log).not.toContain('sync')
        expect(observed?.closure).toBe('unknown')
        log.push('outer-still-pending')
      }),
    ),
  )
  expect(Exit.isFailure(result)).toBe(true)
  expect(log).not.toContain('location-release')
  expect(log).not.toContain('logical-close')
  expect(log).not.toContain('begin-capture')
  expect(log).not.toContain('seal')
  expect(log).toEqual(['begin', 'location-enter', 'location-retain', 'outer-still-pending', 'rollback', 'close-state'])
})

test('maintenance closure waits for the real outer host durability acknowledgement', async () => {
  const log: string[] = []
  const entered = Deferred.makeUnsafe<void>(),
    release = Deferred.makeUnsafe<void>()
  const storage = {
    transaction: async <A>(callback: () => Promise<A>) => {
      const result = await callback()
      log.push('commit')
      return result
    },
    sync: async () => {
      log.push('sync-pending')
      await Effect.runPromise(Deferred.succeed(entered, undefined))
      await Effect.runPromise(Deferred.await(release))
      log.push('sync-complete')
    },
  } as unknown as CfTypes.DurableObjectStorage
  const host = makeTransactionHost(storage, () => {})
  const db: Pick<SqliteDb, 'execute' | 'select' | 'close' | 'debug'> = {
    debug: { head: EventSequenceNumber.Client.ROOT },
    execute: () => {},
    select: () => [],
    close: () => {
      log.push('logical-close')
    },
  }
  const source = await Effect.runPromise(makeHostedSource(db, { host, storageName: 'native-source' }))
  const binding = { operationId: 'owned-host', context: null }
  const locationOwner: SourceMaintenanceLocationOwner = {
    run: (_context, effect) =>
      effect.pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            log.push('location-release')
          }),
        ),
      ),
  }
  const opener = retainedSourceMaintenanceOpener({
    binding,
    locationOwner,
    acquire: Effect.acquireRelease(Effect.succeed(source), (owner) => owner.close.pipe(Effect.orDie)),
  })
  const running = Effect.runFork(
    withRetainedSource(opener, binding, () =>
      Effect.sync(() => {
        log.push('body-staged')
        return 'closed-result'
      }),
    ).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          log.push('published')
        }),
      ),
    ),
  )
  await Effect.runPromise(Deferred.await(entered))
  expect(log).toEqual(['body-staged', 'logical-close', 'commit', 'sync-pending'])
  await Effect.runPromise(Deferred.succeed(release, undefined))
  expect(await Effect.runPromise(Fiber.join(running))).toBe('closed-result')
  expect(log).toEqual([
    'body-staged',
    'logical-close',
    'commit',
    'sync-pending',
    'sync-complete',
    'location-release',
    'published',
  ])
})
