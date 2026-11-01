import { Deferred, Effect } from '@livestore/utils/effect'
import { WebLock } from '@livestore/utils/effect/browser'

/** Own release before either election path can acquire, including interrupted startup. */
export const makeLeaderElectionLock = (name: string) =>
  Effect.gen(function* () {
    // Register first so later SDK resources finalize before the lock is released.
    // The acquisition callback's AbortSignal no longer owns a successfully granted lock.
    const released = yield* Effect.acquireRelease(Deferred.make<void>(), (deferred) =>
      Deferred.succeed(deferred, undefined),
    )
    return {
      tryAcquire: WebLock.tryGetDeferredLock(released, name),
      wait: WebLock.waitForDeferredLock(released, name),
    }
  })
