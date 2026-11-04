import * as BrowserWorker from '@effect/platform-browser/BrowserWorker'
import * as BrowserWorkerRunner from '@effect/platform-browser/BrowserWorkerRunner'
import * as Worker from 'effect/workers/Worker'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { Deferred, Effect, Exit, Fiber, Scope } from '@livestore/utils/effect'

import { makePhysicalWorkerLifetime, withPhysicalWorkerLifetime } from '../common/physical-worker-lifetime.ts'
import { makeLeaderElectionLock } from './leader-election-lock.ts'

afterEach(() => vi.unstubAllGlobals())

// Real MessageChannels and both selected browser platform implementations model
// the asynchronous receiver boundary; a page-local finalizer cannot stand in for it.
describe('leader election release follows receiving-worker physical close', () => {
  for (const mode of ['normal', 'sender-abort', 'receiver-close-failure', 'successful-ack-control'] as const) {
    it(`${mode}: cannot hand ownership to a successor before a successful receiver close`, async () => {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const locks = installLocks()
            const rpc = new MessageChannel()
            const lifetime = yield* makePhysicalWorkerLifetime
            const lifetimePort = yield* lifetime.initialPort
            const closingScope = yield* Scope.make()
            const leaderScope = yield* Scope.make()
            const followerScope = yield* Scope.make()
            const receiverScope = yield* Scope.make()
            const ready = yield* Deferred.make<void>()
            const receiverClosing = yield* Deferred.make<void>()
            const allowClose = yield* Deferred.make<void>()
            let physicalClosed = false
            const closeFailure = new Error('receiving-worker native close failed')
            yield* Effect.addFinalizer(() =>
              Effect.gen(function* () {
                yield* Deferred.succeed(allowClose, undefined)
                yield* Effect.exit(Scope.close(leaderScope, Exit.void))
                yield* Effect.exit(Scope.close(followerScope, Exit.void))
                yield* Effect.exit(Scope.close(receiverScope, Exit.void))
                yield* Effect.exit(Scope.close(closingScope, Exit.void))
                rpc.port1.close()
                rpc.port2.close()
              }),
            )
            const receiver = yield* withPhysicalWorkerLifetime(
              lifetimePort,
              Effect.scoped(
                Effect.gen(function* () {
                  yield* Effect.addFinalizer(() =>
                    Effect.gen(function* () {
                      yield* Deferred.succeed(receiverClosing, undefined)
                      yield* Deferred.await(allowClose)
                      if (mode === 'receiver-close-failure') return yield* Effect.die(closeFailure)
                      physicalClosed = true
                    }),
                  )
                  const runner = yield* BrowserWorkerRunner.make(rpc.port2).start()
                  yield* runner.run(() => Effect.void)
                }),
              ),
            ).pipe(Effect.forkIn(receiverScope))
            const leader = yield* makeLeaderElectionLock('physical-handoff', () => lifetime.close).pipe(
              Scope.provide(leaderScope),
            )
            expect(yield* leader.tryAcquire).toBe(true)
            const sender = yield* Effect.gen(function* () {
              const platform = yield* Worker.WorkerPlatform
              const endpoint = yield* platform.spawn(0)
              return yield* endpoint.run(() => Effect.void, { onSpawn: Deferred.succeed(ready, undefined) })
            }).pipe(Effect.provide(BrowserWorker.layer(() => rpc.port1)), Effect.forkIn(leaderScope))
            yield* Deferred.await(ready)
            if (mode === 'sender-abort') yield* Fiber.interrupt(sender)
            // This is the page's real close path: transport finalizers run inside
            // leaderScope, then the independent physical lifetime is joined later.
            const pageClose = yield* Effect.exit(Scope.close(leaderScope, Exit.void)).pipe(Effect.forkIn(closingScope))
            yield* Deferred.await(receiverClosing)
            expect(physicalClosed).toBe(false)
            expect(pageClose.pollUnsafe()).toBeUndefined()
            const follower = yield* makeLeaderElectionLock('physical-handoff').pipe(Scope.provide(followerScope))
            expect(yield* follower.tryAcquire).toBe(false)
            const duplicate = yield* Effect.exit(lifetime.close).pipe(Effect.forkIn(closingScope))
            yield* Deferred.succeed(allowClose, undefined)
            const pageExit = yield* Fiber.join(pageClose)
            const duplicateExit = yield* Fiber.join(duplicate)
            const receiverExit = yield* Fiber.await(receiver)
            if (mode === 'receiver-close-failure') {
              expect(Exit.isFailure(receiverExit)).toBe(true)
              expect(Exit.isFailure(pageExit)).toBe(true)
              expect(Exit.isFailure(duplicateExit)).toBe(true)
              expect(yield* follower.tryAcquire).toBe(false)
            } else {
              expect(physicalClosed).toBe(true)
              expect(Exit.isSuccess(pageExit)).toBe(true)
              expect(Exit.isSuccess(duplicateExit)).toBe(true)
              yield* Effect.promise(() => locks.firstReleased)
              expect(yield* follower.tryAcquire).toBe(true)
            }
          }),
        ),
      )
    })
  }
})

/** A browser lock remains owned until the callback promise settles. No timers. */
const installLocks = () => {
  let held = false
  let firstRelease!: () => void
  const firstReleased = new Promise<void>((resolve) => {
    firstRelease = resolve
  })
  vi.stubGlobal('navigator', {
    locks: {
      request(
        name: string,
        options: { ifAvailable?: boolean },
        callback: (lock: { name: string; mode: 'exclusive' } | null) => unknown,
      ) {
        if (held === true && options.ifAvailable === true) return Promise.resolve(callback(null))
        if (held === true) throw new Error('This fixture only uses nonwaiting election probes')
        held = true
        return Promise.resolve(callback({ name, mode: 'exclusive' })).finally(() => {
          held = false
          firstRelease()
        })
      },
    },
  })
  return { firstReleased }
}
