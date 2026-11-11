import type { UnknownError } from '@livestore/common'
import { Effect, Fiber, Scope } from '@livestore/utils/effect'

import {
  acquirePhysicalWorker,
  makePhysicalWorkerLifetime,
  makePhysicalWorkerLifetimeWithRealmLoss,
  type PhysicalWorkerCloseOutcome,
} from '../common/physical-worker-lifetime.ts'
import { makeLeaderElectionLock } from './leader-election-lock.ts'

/** The factory owner supplies positive proof of loss of this exact dedicated realm. */
export interface WitnessedWorkerEndpoint {
  readonly port: MessagePort
  readonly realmLost: AbortSignal
  /** Joins app-owned resources after SDK cleanup, without waiting for election release. */
  readonly beforeRelease: (outcome: PhysicalWorkerCloseOutcome) => Promise<void>
}

export type DedicatedWorkerEndpoint = Worker | MessagePort | WitnessedWorkerEndpoint

export const makeWorkerShutdown = Effect.gen(function* () {
  const startupScope = yield* Scope.make()
  const electionScope = yield* Scope.make()
  let retireLeader = Effect.void
  let afterRelease = Effect.void
  let worker:
    | {
        readonly endpoint: WitnessedWorkerEndpoint
        readonly close: Effect.Effect<PhysicalWorkerCloseOutcome, UnknownError>
      }
    | undefined
  // The parent finalizer owns the only close of resources. A second Scope.close
  // would not join its first execution and could hide a failed surviving owner.
  const resources = yield* Effect.acquireRelease(Scope.make(), (scope, exit) =>
    Effect.gen(function* () {
      // Setup and queued election can still register resources. Stop and join
      // them before starting the first close of the ordinary resource scope.
      yield* Scope.close(startupScope, exit)
      // Followers must observe retirement before physical cleanup can interrupt their RPC.
      // Keep the proxy connection alive until retirement is acknowledged.
      yield* retireLeader.pipe(
        Effect.ensuring(
          Effect.gen(function* () {
            yield* Scope.close(scope, exit)
            const owned = worker
            if (owned !== undefined) {
              const outcome = yield* owned.close.pipe(Effect.orDie)
              yield* Effect.promise(() =>
                owned.endpoint.beforeRelease(
                  outcome === 'never-started' && owned.endpoint.realmLost.aborted === true
                    ? 'witnessed-realm-loss'
                    : outcome,
                ),
              )
            }
            yield* Scope.close(electionScope, exit)
            yield* afterRelease
          }),
        ),
      )
    }),
  )

  return {
    run: <A, E, R>(startup: Effect.Effect<A, E, R | Scope.Scope>) =>
      Effect.gen(function* () {
        const fiber = yield* startup.pipe(Effect.interruptible, Scope.provide(resources), Effect.forkIn(startupScope))
        return yield* Fiber.join(fiber)
      }),
    forkStartup: Effect.forkIn(startupScope),
    election: (name: string) => makeLeaderElectionLock(name).pipe(Scope.provide(electionScope)),
    beforePhysicalClose: (retire: Effect.Effect<void>) => {
      retireLeader = retire
    },
    afterElectionRelease: (wait: Effect.Effect<void>) => {
      afterRelease = wait
    },
    acquireWorker: (spawn: () => DedicatedWorkerEndpoint) =>
      Effect.gen(function* () {
        let closeLegacy = Effect.void
        const endpoint = yield* acquirePhysicalWorker(spawn, { close: Effect.suspend(() => closeLegacy) })
        if ('realmLost' in endpoint) {
          const lifetime = yield* makePhysicalWorkerLifetimeWithRealmLoss(endpoint.realmLost)
          worker = { endpoint, close: lifetime.close }
          const close = lifetime.close.pipe(Effect.asVoid, Effect.orDie)
          yield* Effect.addFinalizer(() => close)
          return { transport: endpoint.port, lifetime, close }
        }

        const lifetime = yield* makePhysicalWorkerLifetime
        const close = lifetime.close.pipe(Effect.orDie)
        closeLegacy = close
        yield* Effect.addFinalizer(() => close)
        return { transport: endpoint, lifetime, close }
      }).pipe(Effect.uninterruptible, Scope.provide(resources)),
  }
})

export type WorkerShutdown = Effect.Success<typeof makeWorkerShutdown>
