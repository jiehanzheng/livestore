import { type SqliteDb, UnknownError } from '@livestore/common'
import { Cause, Effect, Exit, Fiber, Option, Scope } from '@livestore/utils/effect'
import type { SQLiteAPI } from '@livestore/wa-sqlite'

import { claimPhysicalApi } from './api-ownership.ts'
import { makeOpfsRegistry } from './opfs/index.ts'

type Connection = { close: () => void; closed: () => boolean }
type FactoryOwner = {
  acquire: <A extends SqliteDb, E, R>(
    create: (adopt: (db: A) => void) => Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>
  openOpfs: ReturnType<typeof makeOpfsRegistry>
  close: Effect.Effect<void>
}

/** Own acquisitions and connections even when callers supply unrelated scopes. */
export const makeFactoryOwner = (sqlite3: SQLiteAPI): Effect.Effect<FactoryOwner, never, Scope.Scope> =>
  Effect.uninterruptible(
    Effect.gen(function* () {
      yield* Effect.sync(() => claimPhysicalApi(sqlite3))
      const acquisitions = yield* Scope.make()
      const pools = yield* Scope.make()
      const connections = new Set<Connection>()
      let phase: 'active' | 'closing' | 'closed' | 'failed' = 'active'
      let uncertainOpen: { cause: unknown } | undefined
      const unavailable = () => new UnknownError({ cause: 'SQLite factory owner is closing, closed or failed' })

      // Scope.close itself does not join a previous invocation's finalizers.
      const close = yield* Effect.cached(
        Effect.uninterruptible(
          Effect.gen(function* () {
            phase = 'closing'
            const pending = yield* Effect.exit(Scope.close(acquisitions, Exit.void))
            const databaseResults = yield* Effect.forEach(
              [...connections],
              (connection) => Effect.exit(Effect.sync(connection.close)),
              { concurrency: 1 },
            )
            // A failed sqlite3_close can leave a live native DB referencing these handles.
            const physical =
              uncertainOpen !== undefined
                ? Exit.die(
                    new UnknownError({
                      cause: uncertainOpen.cause,
                      note: 'Uncertain native open retains its physical SQLite owner',
                    }),
                  )
                : connections.size === 0
                  ? yield* Effect.exit(Scope.close(pools, Exit.void))
                  : Exit.void
            const failures = [pending, ...databaseResults, physical].filter(Exit.isFailure)
            phase = failures.length === 0 ? 'closed' : 'failed'
            if (failures.length > 0) {
              return yield* Effect.failCause(
                failures.map((exit) => exit.cause).reduce((left, right) => Cause.combine(left, right)),
              )
            }
          }),
        ),
      )
      yield* Effect.addFinalizer(() => close)

      const acquire = <A extends SqliteDb, E, R>(create: (adopt: (db: A) => void) => Effect.Effect<A, E, R>) =>
        Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            if (phase !== 'active') return yield* Effect.die(unavailable())
            const caller = yield* Effect.serviceOption(Scope.Scope)
            let connection: Connection | undefined
            const adopt = (db: A) => {
              const nativeClose = db.close
              const nativeDestroy = db.destroy
              let state: 'open' | 'closed' | 'failed' = 'open'
              let failure: unknown
              const tracked: Connection = {
                closed: () => state !== 'open',
                close: () => {
                  if (state === 'closed') return
                  if (state === 'failed') throw failure
                  try {
                    nativeClose()
                    state = 'closed'
                    connections.delete(tracked)
                  } catch (cause) {
                    phase = 'failed'
                    state = 'failed'
                    failure = cause
                    throw cause
                  }
                },
              }
              db.close = tracked.close
              db.destroy = () => {
                if (phase !== 'active' || state !== 'open') throw unavailable()
                nativeDestroy()
              }
              connection = tracked
              connections.add(tracked)
            }
            // Native pool initialization must finish and publish pointer ownership before cancellation.
            const opening = Effect.uninterruptible(
              Effect.gen(function* () {
                if (phase !== 'active') return yield* Effect.die(unavailable())
                const db = yield* create(adopt)
                const owned = connection
                if (owned === undefined)
                  return yield* Effect.die(new UnknownError({ cause: 'SQLite connection was not adopted' }))
                if (Option.isSome(caller) === true) yield* Scope.addFinalizer(caller.value, Effect.sync(owned.close))
                if (phase !== 'active' || owned.closed() === true) {
                  yield* Effect.sync(owned.close)
                  return yield* Effect.interrupt
                }
                return db
              }),
            ).pipe(
              Effect.onExit((exit) =>
                Effect.gen(function* () {
                  if (Exit.isFailure(exit) === true) {
                    if (
                      phase === 'active' &&
                      (connection === undefined || Cause.hasInterruptsOnly(exit.cause) === false)
                    )
                      phase = 'failed'
                    if (connection !== undefined) yield* Effect.sync(connection.close)
                  }
                }),
              ),
            )
            // A caller's scope need not descend from ours; the owner always retains this fiber.
            const fiber = yield* opening.pipe(Effect.forkIn(acquisitions))
            return yield* restore(Fiber.join(fiber)).pipe(Effect.onInterrupt(() => Fiber.interrupt(fiber)))
          }),
        )
      if (phase !== 'active') return yield* Effect.interrupt
      return {
        acquire,
        openOpfs: makeOpfsRegistry({
          sqlite3,
          scope: pools,
          isOpen: () => phase === 'active',
          onUncertainOpen: (cause) => {
            uncertainOpen = { cause }
            phase = 'failed'
          },
        }),
        close,
      }
    }),
  )
