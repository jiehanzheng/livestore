import { expect, test } from 'vitest'

import type { SqliteDb } from '@livestore/common'
import type { CfTypes } from '@livestore/common-cf'
import { EventSequenceNumber } from '@livestore/common/schema'
import { makeHostedSource } from '@livestore/common/source-db'
import { Deferred, Effect, Exit, Fiber } from '@livestore/utils/effect'

import { makeTransactionHost } from './transaction-host.ts'

const fixture = () => {
  const log: string[] = []
  const storage = {
    transaction: async <A>(callback: () => Promise<A>) => {
      log.push('begin')
      try {
        const value = await callback()
        log.push('commit')
        return value
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
  return { host, log }
}

test('host frame ownership is exact, reentrant, and never inherited by child fibers or other hosts', async () => {
  const { host, log } = fixture(),
    foreign = fixture().host
  expect(await Effect.runPromise(host.inTransaction)).toBe(false)
  await Effect.runPromise(
    host.runTransaction(
      Effect.gen(function* () {
        expect(yield* host.inTransaction).toBe(true)
        expect(yield* foreign.inTransaction).toBe(false)
        yield* host.runTransaction(
          Effect.gen(function* () {
            expect(yield* host.inTransaction).toBe(true)
          }),
        )
        const child = yield* Effect.forkDetach(host.inTransaction)
        expect(yield* Fiber.join(child)).toBe(false)
      }),
    ),
  )
  expect(await Effect.runPromise(host.inTransaction)).toBe(false)
  expect(log).toEqual(['begin', 'commit', 'sync'])
})

test('captured callback context expires before durability confirmation', async () => {
  const { host } = fixture()
  const { check } = await Effect.runPromise(
    host.runTransaction(
      Effect.gen(function* () {
        const context = yield* Effect.context<never>()
        return { check: host.inTransaction.pipe(Effect.provideContext(context)) }
      }),
    ),
  )
  expect(await Effect.runPromise(check)).toBe(false)
})

test('nested failure remains tainted when caught and fences the physical owner', async () => {
  const { host, log } = fixture()
  const result = await Effect.runPromiseExit(
    host.runTransaction(host.runTransaction(Effect.fail('nested failure')).pipe(Effect.ignore)),
  )
  expect(Exit.isFailure(result)).toBe(true)
  expect(log).toEqual(['begin', 'rollback', 'close-state'])
  expect(Exit.isFailure(await Effect.runPromiseExit(host.runTransaction(Effect.void)))).toBe(true)
  expect(log.filter((entry) => entry === 'begin')).toHaveLength(1)
})

test('a sibling owner queues at the existing physical gate', async () => {
  const { host, log } = fixture()
  const entered = Deferred.makeUnsafe<void>(),
    release = Deferred.makeUnsafe<void>()
  const first = Effect.runFork(
    host.runTransaction(
      Effect.gen(function* () {
        yield* Deferred.succeed(entered, undefined)
        yield* Deferred.await(release)
      }),
    ),
  )
  await Effect.runPromise(Deferred.await(entered))
  const second = Effect.runFork(
    host.runTransaction(
      Effect.gen(function* () {
        expect(yield* host.inTransaction).toBe(true)
        log.push('second')
      }),
    ),
  )
  expect(log).toEqual(['begin'])
  await Effect.runPromise(Deferred.succeed(release, undefined))
  await Effect.runPromise(Fiber.join(first))
  await Effect.runPromise(Fiber.join(second))
  expect(log).toEqual(['begin', 'commit', 'sync', 'begin', 'second', 'commit', 'sync'])
})

test('caught hosted close inside an external native frame still forces host rollback', async () => {
  const { host, log } = fixture()
  const db = {
    debug: { head: EventSequenceNumber.Client.ROOT },
    execute: () => {},
    select: () => [],
    close: () => {
      log.push('logical-close')
    },
  } as Pick<SqliteDb, 'execute' | 'select' | 'close' | 'debug'>
  const owner = await Effect.runPromise(makeHostedSource(db, { host, storageName: 'native-source' }))
  const result = await Effect.runPromiseExit(host.runTransaction(owner.close.pipe(Effect.ignore)))
  expect(Exit.isFailure(result)).toBe(true)
  expect(log).toEqual(['begin', 'rollback', 'close-state'])
})
