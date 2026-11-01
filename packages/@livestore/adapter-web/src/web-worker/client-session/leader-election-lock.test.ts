import { afterEach, describe, expect, it, vi } from 'vitest'

import { Cause, Deferred, Effect, Exit, Fiber, Scope } from '@livestore/utils/effect'

import { makeLeaderElectionLock } from './leader-election-lock.ts'

afterEach(() => vi.unstubAllGlobals())

describe('leader election lock lifetime', () => {
  for (const failStartup of [false, true]) {
    it(`releases an acquired lock when startup ${failStartup === true ? 'fails' : 'is interrupted'}`, () =>
      Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const locks = installLockManager()
            const ready = yield* Deferred.make<void>()
            const failure = new Error('Startup failed before snapshot admission')
            const opening = yield* Effect.scoped(
              Effect.gen(function* () {
                const lock = yield* makeLeaderElectionLock('startup')
                expect(yield* lock.tryAcquire).toBe(true)
                yield* Deferred.succeed(ready, undefined)
                if (failStartup === true) return yield* Effect.fail(failure)
                return yield* Effect.never
              }),
            ).pipe(Effect.forkChild)
            yield* Deferred.await(ready)
            if (failStartup === false) yield* Fiber.interrupt(opening)
            const exit = yield* Fiber.await(opening)
            yield* Deferred.await(locks.receipt(0).released)
            expect(locks.isHeld('startup')).toBe(false)
            expect(Exit.isFailure(exit)).toBe(true)
            if (failStartup === true && Exit.isFailure(exit) === true) expect(Cause.squash(exit.cause)).toBe(failure)
          }),
        ),
      ))
  }

  it('keeps the lock until later SDK resources have finalized', () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const locks = installLockManager()
          const order: string[] = []
          yield* Effect.scoped(
            Effect.gen(function* () {
              const lock = yield* makeLeaderElectionLock('order')
              expect(yield* lock.tryAcquire).toBe(true)
              yield* Effect.addFinalizer(() =>
                Effect.sync(() => {
                  expect(locks.isHeld('order')).toBe(true)
                  order.push('sdk-finalized')
                }),
              )
            }),
          )
          yield* Deferred.await(locks.receipt(0).released)
          order.push('lock-released')
          expect(order).toEqual(['sdk-finalized', 'lock-released'])
        }),
      ),
    ))

  it('owns a follower lock after promotion and releases it on interrupted startup', () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const locks = installLockManager()
          const leaderScope = yield* ownedScope
          const leader = yield* makeLeaderElectionLock('promotion').pipe(Scope.provide(leaderScope))
          expect(yield* leader.tryAcquire).toBe(true)
          const followerScope = yield* ownedScope
          const follower = yield* makeLeaderElectionLock('promotion').pipe(Scope.provide(followerScope))
          expect(yield* follower.tryAcquire).toBe(false)
          const promoted = yield* follower.wait.pipe(Scope.provide(followerScope), Effect.forkIn(followerScope))
          yield* Deferred.await(locks.receipt(2).requested)
          yield* Scope.close(leaderScope, Exit.void)
          yield* Deferred.await(locks.receipt(0).released)
          yield* Fiber.join(promoted)
          expect(locks.isHeld('promotion')).toBe(true)
          yield* Scope.close(followerScope, Exit.interrupt(1))
          yield* Deferred.await(locks.receipt(2).released)
          expect(locks.isHeld('promotion')).toBe(false)
        }),
      ),
    ))

  it('cancels a queued follower without releasing the current leader or acquiring later', () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const locks = installLockManager()
          const leaderScope = yield* ownedScope
          const leader = yield* makeLeaderElectionLock('queued').pipe(Scope.provide(leaderScope))
          expect(yield* leader.tryAcquire).toBe(true)
          const followerScope = yield* ownedScope
          const follower = yield* makeLeaderElectionLock('queued').pipe(Scope.provide(followerScope))
          expect(yield* follower.tryAcquire).toBe(false)
          const waiting = yield* follower.wait.pipe(Scope.provide(followerScope), Effect.forkIn(followerScope))
          yield* Deferred.await(locks.receipt(2).requested)
          yield* Scope.close(followerScope, Exit.void)
          const exit = yield* Fiber.await(waiting)
          expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
          expect(locks.isHeld('queued')).toBe(true)
          yield* Scope.close(leaderScope, Exit.void)
          yield* Deferred.await(locks.receipt(0).released)
          expect(yield* Deferred.isDone(locks.receipt(2).granted)).toBe(false)
          expect(locks.isHeld('queued')).toBe(false)
        }),
      ),
    ))

  it('releases a grant whose callback arrives after the owning scope has closed', () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const locks = installLockManager()
          const grant = Deferred.makeUnsafe<void>()
          locks.pauseNextCallback(grant)
          yield* Effect.addFinalizer(() =>
            Deferred.succeed(grant, undefined).pipe(Effect.andThen(Deferred.await(locks.receipt(0).released))),
          )
          const opening = yield* Effect.scoped(
            Effect.gen(function* () {
              const lock = yield* makeLeaderElectionLock('late-callback')
              yield* lock.tryAcquire
              return yield* Effect.never
            }),
          ).pipe(Effect.forkChild)
          yield* Deferred.await(locks.receipt(0).requested)
          yield* Fiber.interrupt(opening)
          yield* Deferred.succeed(grant, undefined)
          yield* Deferred.await(locks.receipt(0).released)
          expect(locks.isHeld('late-callback')).toBe(false)
        }),
      ),
    ))
})

const ownedScope = Effect.gen(function* () {
  const scope = yield* Scope.make()
  yield* Effect.addFinalizer((exit) => Scope.close(scope, exit))
  return scope
})

/** Deterministic browser boundary: a lock is held until its callback promise settles. */
const installLockManager = () => {
  type Receipt = {
    requested: Deferred.Deferred<void>
    granted: Deferred.Deferred<void>
    released: Deferred.Deferred<void>
  }
  type Request = {
    name: string
    id: number
    signal?: AbortSignal
    cancelled: boolean
    pause?: Deferred.Deferred<void>
    callback: (lock: { name: string; mode: 'exclusive' } | null) => unknown
    resolve(value: unknown): void
    reject(error: unknown): void
  }
  const receipts = new Map<number, Receipt>()
  const held = new Map<string, Request>()
  const pending: Request[] = []
  let nextId = 0
  let pause: Deferred.Deferred<void> | undefined
  const receipt = (id: number) => {
    let value = receipts.get(id)
    if (value === undefined) {
      value = {
        requested: Deferred.makeUnsafe<void>(),
        granted: Deferred.makeUnsafe<void>(),
        released: Deferred.makeUnsafe<void>(),
      }
      receipts.set(id, value)
    }
    return value
  }
  const signal = (ready: Deferred.Deferred<void>) => Deferred.doneUnsafe(ready, Effect.void)
  const grant = (request: Request) => {
    held.set(request.name, request)
    void (async () => {
      if (request.pause !== undefined) await Effect.runPromise(Deferred.await(request.pause))
      signal(receipt(request.id).granted)
      return request.callback({ name: request.name, mode: 'exclusive' })
    })()
      .then(request.resolve, request.reject)
      .finally(() => {
        held.delete(request.name)
        const index = pending.findIndex((entry) => entry.name === request.name && !entry.cancelled)
        if (index >= 0) grant(pending.splice(index, 1)[0]!)
        signal(receipt(request.id).released)
      })
  }
  vi.stubGlobal('navigator', {
    locks: {
      request(name: string, options: { ifAvailable?: boolean; signal?: AbortSignal }, callback: Request['callback']) {
        return new Promise((resolve, reject) => {
          const request: Request = {
            name,
            id: nextId++,
            callback,
            resolve,
            reject,
            cancelled: false,
            ...(options.signal !== undefined ? { signal: options.signal } : {}),
            ...(pause !== undefined ? { pause } : {}),
          }
          pause = undefined
          signal(receipt(request.id).requested)
          if (held.has(name) === false) grant(request)
          else if (options.ifAvailable === true) Promise.resolve(callback(null)).then(resolve, reject)
          else {
            pending.push(request)
            const abort = () => {
              if (held.get(name) === request) return
              request.cancelled = true
              reject(new DOMException('signal is aborted without reason', 'AbortError'))
            }
            options.signal?.addEventListener('abort', abort, { once: true })
            if (options.signal?.aborted === true) abort()
          }
        })
      },
    },
  })
  return {
    receipt,
    isHeld: (name: string) => held.has(name),
    pauseNextCallback: (ready: Deferred.Deferred<void>) => {
      pause = ready
    },
  }
}
