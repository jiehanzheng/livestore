import { Cause, Effect, Fiber } from 'effect'
import { describe, expect, test } from 'vitest'

import { acquireSourceAuthority } from './creation.ts'

const controlledLock = () => {
  const requested = Promise.withResolvers<void>()
  const finished = Promise.withResolvers<void>()
  let callback: ((lock: Lock | null) => Promise<unknown>) | undefined
  let granted = false
  let returned = false
  const locks = {
    request: (_name: string, options: LockOptions, body: typeof callback) => {
      callback = body
      options.signal?.addEventListener('abort', () => {
        if (granted === false) finished.reject(new DOMException('cancelled', 'AbortError'))
      })
      requested.resolve()
      return finished.promise
    },
  } as unknown as LockManager
  return {
    locks,
    requested: requested.promise,
    isGranted: () => granted,
    isReturned: () => returned,
    grant: () => {
      granted = true
      void callback!({} as Lock).then(
        () => {
          returned = true
          finished.resolve()
        },
        (cause) => finished.reject(cause),
      )
    },
  }
}

describe('SOURCE authority masked resource acquisition', () => {
  test('a contended lock remains cancellable and joins its native request', async () => {
    const native = controlledLock()
    const fiber = Effect.runFork(
      Effect.scoped(
        Effect.acquireRelease(acquireSourceAuthority(native.locks, 'contended'), (lease) =>
          Effect.promise(() => lease.release()),
        ),
      ),
    )
    await native.requested
    await Effect.runPromise(Fiber.interrupt(fiber))
    expect(native.isGranted()).toBe(false)
    expect(fiber.pollUnsafe()).toMatchObject({ _tag: 'Failure' })
  })

  test('cancellation preserves both interruption and an unexpected native cleanup failure', async () => {
    const started = Promise.withResolvers<void>()
    const finished = Promise.withResolvers<void>()
    const locks = {
      request: (_name: string, options: LockOptions) => {
        options.signal?.addEventListener('abort', () => finished.reject(new Error('native cancellation failed')))
        started.resolve()
        return finished.promise
      },
    } as unknown as LockManager
    const fiber = Effect.runFork(
      Effect.scoped(
        Effect.acquireRelease(acquireSourceAuthority(locks, 'failure'), (lease) =>
          Effect.promise(() => lease.release()),
        ),
      ),
    )
    await started.promise
    await Effect.runPromise(Fiber.interrupt(fiber))
    const result = await Effect.runPromise(Fiber.await(fiber))
    expect(result._tag).toBe('Failure')
    if (result._tag === 'Failure') {
      expect(Cause.hasInterrupts(result.cause)).toBe(true)
      expect(Cause.hasFails(result.cause)).toBe(true)
    }
  })

  test('interruption at each grant-to-finalizer operation cannot strand the granted native callback', async () => {
    let interruptedCases = 0
    for (let interruptAt = 1; interruptAt <= 60; interruptAt++) {
      const native = controlledLock()
      let operations = 0
      const interruption = { happened: false }
      const scheduler = {
        executionMode: 'async' as const,
        makeDispatcher: () => ({ scheduleTask: (task: () => void) => queueMicrotask(task), flush: () => {} }),
        shouldYield: (fiber: Fiber.Fiber<unknown, unknown>) => {
          if (native.isGranted() === true && ++operations === interruptAt) {
            interruption.happened = true
            fiber.interruptUnsafe()
          }
          return false
        },
      }
      // This is the factory's acquisition structure: only the native lock wait is interruptible.
      // Restoring the whole acquisition can lose a granted lease before finalizer registration.
      const fiber = Effect.runFork(
        Effect.scoped(
          Effect.acquireRelease(acquireSourceAuthority(native.locks, 'handoff'), (lease) =>
            Effect.promise(() => lease.release()),
          ),
        ),
        { scheduler },
      )
      const done = new Promise((resolve) => fiber.addObserver(resolve))
      await native.requested
      native.grant()
      await done
      expect(native.isReturned(), `interruption operation ${interruptAt}`).toBe(true)
      if (interruption.happened === true) interruptedCases++
    }
    expect(interruptedCases).toBeGreaterThan(0)
  })
})
