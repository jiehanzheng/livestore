import { describe, expect, test } from 'vitest'

import { Context, Deferred, Effect, Exit, Fiber, Option, Semaphore } from '@livestore/utils/effect'

import { SqliteError } from '../errors.ts'
import { EventSequenceNumber } from '../schema/mod.ts'
import type { SqliteDb, SqliteTransactionHost } from '../sqlite-types.ts'
import { makeHostedSource } from './hosted.ts'
import { sourceLifecycle } from './lifecycle.ts'
import { fenceSource, type SourceTransaction } from './role.ts'

class Frame extends Context.Service<Frame, number>()('hosted-test/Frame') {}

// A controlled physical boundary: nested owning-fiber calls reuse a frame, other fibers queue.
const fixture = async () => {
  const gate = Semaphore.makeUnsafe(1)
  const log: string[] = []
  let failed = false
  let failSql = false
  let failClose = false
  let commits = 0
  const rowBytes = new Uint8Array([1])
  const host: SqliteTransactionHost = {
    sourceNamespace: 'durable-object',
    inTransaction: Effect.gen(function* () {
      const id = yield* Effect.fiberId
      const frame = yield* Effect.serviceOption(Frame)
      return Option.isSome(frame) === true && frame.value === id
    }),
    runTransaction: (effect) =>
      Effect.gen(function* () {
        const id = yield* Effect.fiberId
        const frame = yield* Effect.serviceOption(Frame)
        if (Option.isSome(frame) === true && frame.value === id) return yield* effect
        return yield* gate.withPermit(
          Effect.gen(function* () {
            if (failed === true) return yield* new SqliteError({ cause: 'fenced host' })
            log.push('host-enter')
            const exit = yield* Effect.exit(effect.pipe(Effect.provideService(Frame, id)))
            if (Exit.isFailure(exit) === true) {
              failed = true
              log.push('host-rollback')
              return yield* Effect.failCause(exit.cause)
            }
            commits++
            log.push('host-commit')
            return exit.value
          }),
        )
      }),
  }
  const db = {
    debug: { head: EventSequenceNumber.Client.ROOT },
    execute: (sql: string, bindings: unknown) => {
      log.push(sql)
      if (failSql === true) throw new Error('native SQL failed')
      if (Array.isArray(bindings) === true && bindings[0] instanceof Uint8Array) bindings[0][0] = 9
    },
    select: () => [{ bytes: rowBytes }],
    close: () => {
      log.push('logical-close')
      if (failClose === true) throw new Error('close failed')
    },
  } as unknown as Pick<SqliteDb, 'execute' | 'select' | 'close' | 'debug'>
  const source = await Effect.runPromise(makeHostedSource(db, { host, storageName: 'native-source' }))
  return {
    source,
    host,
    log,
    rowBytes,
    commits: () => commits,
    failSql: () => {
      failSql = true
    },
    failClose: () => {
      failClose = true
    },
  }
}

describe('native hosted SOURCE', () => {
  test('uses one host boundary, reenters reads and writes, and emits no SQL transaction controls', async () => {
    const f = await fixture()
    await Effect.runPromise(
      f.host.runTransaction(
        f.source.write((tx) =>
          Effect.gen(function* () {
            yield* tx.execute('INSERT source')
            yield* f.source.handle.select('SELECT source')
            yield* f.source.write((nested) => nested.execute('UPDATE source'))
            expect(f.commits()).toBe(0)
          }),
        ),
      ),
    )
    expect(f.log).toEqual(['host-enter', 'INSERT source', 'UPDATE source', 'host-commit'])
    expect(f.commits()).toBe(1)
    expect(f.source.image).toBeUndefined()
    expect(f.source.fresh).toBeUndefined()
    expect(f.source.persistence).toEqual({ kind: 'native-shared-host', host: f.host })
  })

  test('expires capabilities and refuses child fibers before native execution', async () => {
    const f = await fixture()
    let saved: SourceTransaction | undefined
    await Effect.runPromise(
      f.source.write((tx) =>
        Effect.gen(function* () {
          saved = tx
          const child = yield* Effect.forkDetach(Effect.exit(tx.execute('CHILD')))
          expect(Exit.isFailure(yield* Fiber.join(child))).toBe(true)
          yield* tx.execute('OWNER')
        }),
      ),
    )
    if (saved === undefined) throw new Error('No callback capability')
    expect(Exit.isFailure(await Effect.runPromiseExit(saved.execute('EXPIRED')))).toBe(true)
    expect(f.log).not.toContain('CHILD')
    expect(f.log).not.toContain('EXPIRED')
  })

  test('copies bindings and rows across the native boundary', async () => {
    const f = await fixture(),
      bytes = new Uint8Array([2])
    await Effect.runPromise(f.source.write((tx) => tx.execute('WRITE', [bytes])))
    expect(bytes[0]).toBe(2)
    const rows = await Effect.runPromise(f.source.handle.select<{ bytes: Uint8Array }>('READ'))
    rows[0]!.bytes[0] = 8
    expect(f.rowBytes[0]).toBe(1)
    expect(Object.isFrozen(rows[0])).toBe(true)
  })

  test('caught native errors and caught invariant failures still prevent commit and fence reuse', async () => {
    for (const native of [true, false]) {
      const f = await fixture()
      if (native === true) f.failSql()
      const exit = await Effect.runPromiseExit(
        f.source.write((tx) =>
          Effect.gen(function* () {
            if (native === true) yield* tx.execute('FAIL').pipe(Effect.ignore)
            else fenceSource(tx, 'identity', 'invalid persisted identity')
          }),
        ),
      )
      expect(Exit.isFailure(exit)).toBe(true)
      expect(f.commits()).toBe(0)
      expect(f.source.handle[sourceLifecycle].phase).toBe('failed')
      expect(Exit.isFailure(await Effect.runPromiseExit(f.source.handle.select('LATER')))).toBe(true)
    }
  })

  test('preserves application errors while fencing the native owner', async () => {
    const f = await fixture(),
      error = { kind: 'application' }
    const result = await Effect.runPromise(f.source.write(() => Effect.fail(error)).pipe(Effect.flip))
    expect(result).toBe(error)
    expect(f.source.handle[sourceLifecycle].phase).toBe('failed')
  })

  test('close joins outstanding host work and closes the logical facade exactly once', async () => {
    const f = await fixture()
    const entered = Deferred.makeUnsafe<void>(),
      release = Deferred.makeUnsafe<void>()
    const writer = Effect.runFork(
      f.source.write(() =>
        Effect.gen(function* () {
          yield* Deferred.succeed(entered, undefined)
          yield* Deferred.await(release)
        }),
      ),
    )
    await Effect.runPromise(Deferred.await(entered))
    const closing = Effect.runFork(f.source.close)
    expect(f.log).not.toContain('logical-close')
    await Effect.runPromise(Deferred.succeed(release, undefined))
    await Effect.runPromise(Fiber.join(writer))
    await Effect.runPromise(Fiber.join(closing))
    await Effect.runPromise(f.source.close)
    expect(f.log).toEqual(['host-enter', 'host-commit', 'host-enter', 'logical-close', 'host-commit'])
    expect(f.source.handle[sourceLifecycle].phase).toBe('closed')
  })

  test('close inside an owning callback refuses even after a nested write has returned', async () => {
    const f = await fixture()
    const exit = await Effect.runPromiseExit(
      f.source.write(() =>
        Effect.gen(function* () {
          yield* f.source.write(() => Effect.void)
          yield* f.source.close.pipe(Effect.ignore)
        }),
      ),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    expect(f.commits()).toBe(0)
    expect(f.log).not.toContain('logical-close')
    expect(f.source.handle[sourceLifecycle].phase).toBe('failed')
  })

  test('close refuses an external host frame before the cached close changes fibers', async () => {
    const f = await fixture()
    const result = await Effect.runPromiseExit(f.host.runTransaction(f.source.close))
    expect(Exit.isFailure(result)).toBe(true)
    expect(f.commits()).toBe(0)
    expect(f.log).toEqual(['host-enter', 'host-rollback'])
    expect(f.source.handle[sourceLifecycle].phase).toBe('failed')
  })

  test('memoizes close failure and never claims that a failed host was closed', async () => {
    const f = await fixture()
    f.failClose()
    expect(Exit.isFailure(await Effect.runPromiseExit(f.source.close))).toBe(true)
    expect(Exit.isFailure(await Effect.runPromiseExit(f.source.close))).toBe(true)
    expect(f.log.filter((entry) => entry === 'logical-close')).toHaveLength(1)
    expect(f.source.handle[sourceLifecycle].phase).toBe('failed')
    const fenced = await fixture()
    await Effect.runPromiseExit(fenced.source.write(() => Effect.fail('rollback')))
    expect(Exit.isFailure(await Effect.runPromiseExit(fenced.source.close))).toBe(true)
    expect(fenced.log).not.toContain('logical-close')
    expect(fenced.source.handle[sourceLifecycle].phase).toBe('failed')
  })
  test.each(['select', 'write', 'close'] as const)(
    'refuses child %s through its active outer SOURCE callback before join can deadlock',
    async (operation) => {
      const f = await fixture()
      const attempted =
        operation === 'select'
          ? f.source.handle.select('CHILD')
          : operation === 'close'
            ? f.source.close
            : f.source.write(() => Effect.void)
      const result = await Effect.runPromiseExit(
        f.source.write(() =>
          Effect.gen(function* () {
            const child = yield* Effect.forkDetach(attempted.pipe(Effect.ignore))
            yield* Fiber.join(child)
          }),
        ),
      )
      expect(Exit.isFailure(result)).toBe(true)
      expect(f.commits()).toBe(0)
      expect(f.log).toEqual(['host-enter', 'host-rollback'])
      expect(f.source.handle[sourceLifecycle].phase).toBe('failed')
    },
  )
})
