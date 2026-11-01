import { describe, expect, it } from '@effect/vitest'

import { makeInMemoryAdapter } from '@livestore/adapter-web'
import { type Adapter, IntentionalShutdownCause, provideOtel, UnknownError } from '@livestore/common'
import { Cause, Deferred, Effect, Exit, Fiber, Scope, TestClock } from '@livestore/utils/effect'

import { events, schema } from '../utils/tests/fixture.ts'
import { createStore } from './create-store.ts'
import { makeShutdownDeferred } from './store-types.ts'

const makeGatedStore = (
  failure?: Error,
  stallPush = false,
  hookOptions: {
    mode?: 'delegate' | 'stall' | 'fail' | 'nondelegating'
    failure?: Error
  } = {},
) =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const owner = yield* Scope.make()
    const pushEntered = yield* Deferred.make<void>()
    const pushInterrupted = yield* Deferred.make<void>()
    const notification = yield* makeShutdownDeferred
    const adapterRequest = yield* Deferred.make<Parameters<Adapter>[0]['shutdown']>()
    const hookEntered = yield* Deferred.make<void>()
    const hookRelease = yield* Deferred.make<void>()
    const hookInterrupted = yield* Deferred.make<void>()
    const hookFinished = yield* Deferred.make<Exit.Exit<void>>()
    const finalized = yield* Deferred.make<void>()
    let closes = 0
    let hookCalls = 0
    let observedExit: Exit.Exit<unknown, unknown> | undefined
    const adapter: Adapter = (args) =>
      Effect.gen(function* () {
        yield* Deferred.succeed(adapterRequest, args.shutdown)
        // Registered before adapter acquisition so this receipt follows its other local finalizers.
        yield* Effect.addFinalizer((exit) =>
          Effect.gen(function* () {
            observedExit = exit
            closes++
            yield* Deferred.succeed(entered, undefined)
            yield* Deferred.await(release)
            yield* Deferred.succeed(finalized, undefined)
            if (failure !== undefined) return yield* Effect.die(failure)
          }),
        )
        const session = yield* makeInMemoryAdapter()(args)
        if (stallPush === true) {
          session.leaderThread.events.push = () =>
            Deferred.succeed(pushEntered, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.ensuring(Deferred.succeed(pushInterrupted, undefined)),
            )
        }
        return {
          ...session,
          shutdown: (exit) =>
            Effect.gen(function* () {
              hookCalls++
              yield* Deferred.succeed(hookEntered, undefined)
              if (hookOptions.mode === 'stall') yield* Deferred.await(hookRelease)
              if (hookOptions.mode === 'fail')
                return yield* Effect.die(hookOptions.failure ?? new Error('adapter shutdown hook failed'))
              if (hookOptions.mode !== 'nondelegating') yield* session.shutdown(exit)
            }).pipe(
              Effect.onInterrupt(() => Deferred.succeed(hookInterrupted, undefined)),
              Effect.onExit((exit) => Deferred.succeed(hookFinished, exit)),
            ),
        }
      })
    yield* Effect.addFinalizer(() =>
      Deferred.succeed(release, undefined).pipe(
        Effect.andThen(Deferred.succeed(hookRelease, undefined)),
        Effect.andThen(Scope.close(owner, Exit.void)),
      ),
    )
    const store = yield* createStore({
      schema,
      storeId: 'local-shutdown',
      adapter,
      shutdownDeferred: notification,
    }).pipe(provideOtel({}), Scope.provide(owner))
    return {
      store,
      owner,
      entered,
      release,
      pushEntered,
      pushInterrupted,
      notification,
      adapterRequest,
      hookEntered,
      hookRelease,
      hookInterrupted,
      hookFinished,
      finalized,
      hookCalls: () => hookCalls,
      observedExit: () => observedExit,
      closes: () => closes,
    }
  })

describe('local teardown observation', () => {
  it.effect('promise shutdown observes its child; bounded request is distinct from strict completion', () =>
    Effect.gen(function* () {
      const { store, entered, release, closes } = yield* makeGatedStore()
      const requested = yield* Effect.forkScoped(Effect.promise(() => store.shutdownPromise()))
      yield* Deferred.await(entered)
      expect(requested.pollUnsafe()).toBeUndefined()
      const strict = yield* Effect.forkScoped(store.shutdownAndWait())
      yield* TestClock.adjust(1000)
      yield* Fiber.join(requested)
      expect(strict.pollUnsafe()).toBeUndefined()
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(strict)
      yield* Effect.promise(() => store.shutdownAndWaitPromise())
      expect(closes()).toBe(1)
    }).pipe(Effect.scoped),
  )

  it.effect('concurrent and repeated strict requests share cleanup; cancelling a waiter leaves cleanup running', () =>
    Effect.gen(function* () {
      const { store, entered, release, closes } = yield* makeGatedStore()
      const first = yield* Effect.forkScoped(store.shutdownAndWait())
      const second = yield* Effect.forkScoped(store.shutdownAndWait())
      yield* Deferred.await(entered)
      yield* Fiber.interrupt(first)
      expect(second.pollUnsafe()).toBeUndefined()
      expect(closes()).toBe(1)
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(second)
      yield* store.shutdownAndWait()
      yield* Effect.promise(() => store.shutdownAndWaitPromise())
      expect(closes()).toBe(1)
    }).pipe(Effect.scoped),
  )

  it.effect('strict observers retain the same teardown failure after a bounded caller returns', () =>
    Effect.gen(function* () {
      const error = new Error('local finalizer failed')
      const { store, entered, release, closes } = yield* makeGatedStore(error)
      const requested = yield* Effect.forkScoped(store.shutdown())
      yield* Deferred.await(entered)
      yield* TestClock.adjust(1000)
      yield* Fiber.join(requested)
      const observer = yield* Effect.forkScoped(Effect.exit(store.shutdownAndWait()))
      yield* Deferred.succeed(release, undefined)
      const result = yield* Fiber.join(observer)
      const repeated = yield* Effect.exit(store.shutdownAndWait())
      expect(Exit.isFailure(result) && Cause.squash(result.cause)).toBe(error)
      expect(Exit.isFailure(repeated) && Cause.squash(repeated.cause)).toBe(error)
      expect(closes()).toBe(1)
    }).pipe(Effect.scoped),
  )

  it.effect('observes the same teardown when the caller scope starts closing first', () =>
    Effect.gen(function* () {
      const { store, owner, entered, release, closes } = yield* makeGatedStore()
      const closingOwner = yield* Effect.forkScoped(Scope.close(owner, Exit.void))
      yield* Deferred.await(entered)
      const observer = yield* Effect.forkScoped(store.shutdownAndWait())
      yield* TestClock.adjust(1000)
      yield* Fiber.join(closingOwner)
      expect(observer.pollUnsafe()).toBeUndefined()
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(observer)
      expect(closes()).toBe(1)
    }).pipe(Effect.scoped),
  )

  it.effect('a hard drain timeout closes local resources but remains a strict teardown failure', () =>
    Effect.gen(function* () {
      const { store, entered, release, pushEntered, pushInterrupted, closes } = yield* makeGatedStore(undefined, true)
      store.commit(events.todoCreated({ id: 'pending', text: 'Pending', completed: false }))
      yield* Deferred.await(pushEntered)
      const observer = yield* Effect.forkScoped(Effect.exit(store.shutdownAndWait()))
      yield* TestClock.adjust(30_000)
      yield* Deferred.await(entered)
      expect(observer.pollUnsafe()).toBeUndefined()
      yield* Deferred.await(pushInterrupted)
      yield* Deferred.succeed(release, undefined)
      const result = yield* Fiber.join(observer)
      expect(Exit.isFailure(result) && Cause.pretty(result.cause)).toContain('Local teardown drain exceeded')
      expect(closes()).toBe(1)
    }).pipe(Effect.scoped),
  )

  it.effect('the first shutdown cause remains authoritative for concurrent requests', () =>
    Effect.gen(function* () {
      const firstCause = UnknownError.make({ cause: 'first shutdown request' })
      const laterCause = UnknownError.make({ cause: 'later shutdown request' })
      const { store, entered, release, observedExit, closes } = yield* makeGatedStore()
      const first = yield* Effect.forkScoped(Effect.exit(store.shutdownAndWait(Cause.fail(firstCause))))
      yield* Deferred.await(entered)
      const later = yield* Effect.forkScoped(Effect.exit(store.shutdownAndWait(Cause.fail(laterCause))))
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(first)
      yield* Fiber.join(later)
      const exit = observedExit()
      expect(exit !== undefined && Exit.isFailure(exit) && Cause.squash(exit.cause)).toBe(firstCause)
      expect(closes()).toBe(1)
    }).pipe(Effect.scoped),
  )
})

describe('shutdown request ownership', () => {
  it.effect('fences public operations before an adapter-initiated request notifies observers', () =>
    Effect.gen(function* () {
      const h = yield* makeGatedStore()
      const observed = yield* Effect.forkScoped(
        Deferred.await(h.notification).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              expect(() =>
                h.store.commit(events.todoCreated({ id: 'after-notification', text: 'Must reject', completed: false })),
              ).toThrow(
                expect.objectContaining({
                  _tag: 'UnknownError',
                  cause: 'Store has been shut down (while performing "commit").',
                }),
              )
            }),
          ),
        ),
      )
      const callback = yield* Deferred.await(h.adapterRequest)
      const request = yield* Effect.forkScoped(
        callback(Exit.succeed(IntentionalShutdownCause.make({ reason: 'manual' }))),
      )
      yield* Deferred.await(h.entered)
      yield* Fiber.join(observed)
      yield* Deferred.succeed(h.release, undefined)
      yield* Fiber.join(request)
      yield* h.store.shutdownAndWait()
      expect(h.closes()).toBe(1)
      expect(h.hookCalls()).toBe(1)
    }).pipe(Effect.scoped),
  )
  for (const first of ['strict', 'bounded'] as const) {
    for (const outcome of ['success', 'failure'] as const) {
      it.effect(
        `${first}-first ${outcome} notifies once and shares adapter work across concurrent, repeated and cancelled observers`,
        () =>
          Effect.gen(function* () {
            const h = yield* makeGatedStore()
            const firstError = UnknownError.make({ cause: 'original shutdown request' })
            const laterError = UnknownError.make({ cause: 'later shutdown request' })
            const cause = outcome === 'failure' ? Cause.fail(firstError) : undefined
            const initial = yield* Effect.forkScoped(
              first === 'strict' ? h.store.shutdownAndWait(cause) : h.store.shutdown(cause),
            )
            yield* Deferred.await(h.entered)
            yield* Deferred.await(h.hookEntered)
            const notified = yield* Effect.exit(Deferred.await(h.notification))
            expect(Exit.isFailure(notified)).toBe(outcome === 'failure')
            if (Exit.isFailure(notified) === true) expect(Cause.squash(notified.cause)).toBe(firstError)
            const concurrent = yield* Effect.forkScoped(h.store.shutdownAndWait(Cause.fail(laterError)))
            const cancelled = yield* Effect.forkScoped(h.store.shutdownAndWait())
            yield* Fiber.interrupt(cancelled)
            expect(yield* Deferred.isDone(h.hookInterrupted)).toBe(false)
            expect(concurrent.pollUnsafe()).toBeUndefined()
            yield* Deferred.succeed(h.release, undefined)
            yield* Fiber.join(initial)
            yield* Fiber.join(concurrent)
            yield* h.store.shutdown(Cause.fail(laterError))
            yield* h.store.shutdownAndWait(Cause.fail(laterError))
            expect(yield* Effect.exit(Deferred.await(h.notification))).toEqual(notified)
            const finalizerExit = h.observedExit()
            expect(finalizerExit !== undefined && Exit.isFailure(finalizerExit)).toBe(outcome === 'failure')
            if (finalizerExit !== undefined && Exit.isFailure(finalizerExit) === true)
              expect(Cause.squash(finalizerExit.cause)).toBe(firstError)
            expect(h.closes()).toBe(1)
            expect(h.hookCalls()).toBe(1)
          }).pipe(Effect.scoped),
      )
    }
  }

  it.effect('bounds the whole ordinary request when its adapter hook stalls; strict waits for that same hook', () =>
    Effect.gen(function* () {
      const h = yield* makeGatedStore(undefined, false, { mode: 'stall' })
      const ordinary = yield* Effect.forkScoped(h.store.shutdown())
      yield* Deferred.await(h.hookEntered)
      yield* Deferred.await(h.entered)
      expect(yield* Deferred.isDone(h.notification)).toBe(true)
      const strict = yield* Effect.forkScoped(h.store.shutdownAndWait())
      const cancelled = yield* Effect.forkScoped(h.store.shutdownAndWait())
      yield* Fiber.interrupt(cancelled)
      yield* TestClock.adjust(1000)
      yield* Fiber.join(ordinary)
      expect(yield* Deferred.isDone(h.hookInterrupted)).toBe(false)
      yield* Deferred.succeed(h.release, undefined)
      yield* Deferred.await(h.finalized)
      expect(strict.pollUnsafe()).toBeUndefined()
      yield* Deferred.succeed(h.hookRelease, undefined)
      yield* Fiber.join(strict)
      yield* h.store.shutdownAndWait()
      expect(h.closes()).toBe(1)
      expect(h.hookCalls()).toBe(1)
    }).pipe(Effect.scoped),
  )

  it.effect('cancelling the first ordinary waiter cannot cancel the once-only adapter hook or local cleanup', () =>
    Effect.gen(function* () {
      const h = yield* makeGatedStore(undefined, false, { mode: 'stall' })
      const first = yield* Effect.forkScoped(h.store.shutdown())
      yield* Deferred.await(h.hookEntered)
      yield* Deferred.await(h.entered)
      yield* Fiber.interrupt(first)
      expect(yield* Deferred.isDone(h.hookInterrupted)).toBe(false)
      const strict = yield* Effect.forkScoped(h.store.shutdownAndWait())
      yield* Deferred.succeed(h.release, undefined)
      yield* Deferred.succeed(h.hookRelease, undefined)
      yield* Fiber.join(strict)
      expect(h.closes()).toBe(1)
      expect(h.hookCalls()).toBe(1)
    }).pipe(Effect.scoped),
  )

  it.effect('a nondelegating hook cannot prevent the request owner from closing local resources', () =>
    Effect.gen(function* () {
      const h = yield* makeGatedStore(undefined, false, { mode: 'nondelegating' })
      const ordinary = yield* Effect.forkScoped(h.store.shutdown())
      yield* Deferred.await(h.entered)
      yield* Deferred.await(h.hookFinished)
      expect(ordinary.pollUnsafe()).toBeUndefined()
      yield* Deferred.succeed(h.release, undefined)
      yield* Fiber.join(ordinary)
      yield* h.store.shutdownAndWait()
      expect(yield* Deferred.isDone(h.notification)).toBe(true)
      expect(h.closes()).toBe(1)
      expect(h.hookCalls()).toBe(1)
    }).pipe(Effect.scoped),
  )

  it.effect('a known local cleanup defect is observable while the adapter hook remains stalled', () =>
    Effect.gen(function* () {
      const error = new Error('known local teardown failure')
      const h = yield* makeGatedStore(error, false, { mode: 'stall' })
      const strict = yield* Effect.forkScoped(Effect.exit(h.store.shutdownAndWait()))
      yield* Deferred.await(h.hookEntered)
      yield* Deferred.await(h.entered)
      yield* Deferred.succeed(h.release, undefined)
      const result = yield* Fiber.join(strict)
      const repeated = yield* Effect.exit(h.store.shutdownAndWait())
      for (const exit of [result, repeated]) expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toBe(error)
      expect(yield* Deferred.isDone(h.hookFinished)).toBe(false)
      expect(yield* Deferred.isDone(h.hookInterrupted)).toBe(false)
      expect(yield* Deferred.isDone(h.notification)).toBe(true)
      yield* Deferred.succeed(h.hookRelease, undefined)
      yield* Deferred.await(h.hookFinished)
      expect(h.closes()).toBe(1)
      expect(h.hookCalls()).toBe(1)
    }).pipe(Effect.scoped),
  )

  it.effect('an adapter hook defect does not cancel independently running local cleanup', () =>
    Effect.gen(function* () {
      const error = new Error('known adapter shutdown failure')
      const h = yield* makeGatedStore(undefined, false, { mode: 'fail', failure: error })
      const strict = yield* Effect.forkScoped(Effect.exit(h.store.shutdownAndWait()))
      yield* Deferred.await(h.entered)
      const result = yield* Fiber.join(strict)
      expect(Exit.isFailure(result) && Cause.squash(result.cause)).toBe(error)
      expect(yield* Deferred.isDone(h.finalized)).toBe(false)
      expect(yield* Deferred.isDone(h.notification)).toBe(true)
      yield* Deferred.succeed(h.release, undefined)
      yield* Deferred.await(h.finalized)
      const repeated = yield* Effect.exit(h.store.shutdownAndWait())
      expect(Exit.isFailure(repeated) && Cause.squash(repeated.cause)).toBe(error)
      expect(h.closes()).toBe(1)
      expect(h.hookCalls()).toBe(1)
    }).pipe(Effect.scoped),
  )

  for (const stage of ['before-session', 'after-session-before-return'] as const) {
    it.effect(`rejects admission after an adapter shutdown ${stage} and registers only a returned session's hook`, () =>
      Effect.gen(function* () {
        const owner = yield* Scope.make()
        const notification = yield* makeShutdownDeferred
        const firstError = UnknownError.make({ cause: `acquisition shutdown ${stage}` })
        const hookFinished = yield* Deferred.make<void>()
        let hookCalls = 0
        let closes = 0
        const adapter: Adapter = (args) =>
          Effect.gen(function* () {
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                closes++
              }),
            )
            if (stage === 'before-session') yield* args.shutdown(Exit.fail(firstError))
            const session = yield* makeInMemoryAdapter()(args)
            if (stage === 'after-session-before-return') yield* args.shutdown(Exit.fail(firstError))
            return {
              ...session,
              shutdown: (exit) =>
                Effect.sync(() => {
                  hookCalls++
                }).pipe(
                  Effect.andThen(session.shutdown(exit)),
                  Effect.ensuring(Deferred.succeed(hookFinished, undefined)),
                ),
            }
          })
        const result = yield* Effect.exit(
          createStore({ schema, storeId: `early-${stage}`, adapter, shutdownDeferred: notification }).pipe(
            provideOtel({}),
            Scope.provide(owner),
          ),
        )
        expect(Exit.isFailure(result) && Cause.squash(result.cause)).toBe(firstError)
        const notified = yield* Effect.exit(Deferred.await(notification))
        expect(Exit.isFailure(notified) && Cause.squash(notified.cause)).toBe(firstError)
        if (stage === 'after-session-before-return') yield* Deferred.await(hookFinished)
        yield* Scope.close(owner, Exit.void)
        expect(closes).toBe(1)
        expect(hookCalls).toBe(stage === 'after-session-before-return' ? 1 : 0)
      }).pipe(Effect.scoped),
    )
  }
})
