import { describe, expect, it } from '@effect/vitest'

import { Cause, Deferred, Effect, Exit, Fiber } from '@livestore/utils/effect'

import { closeSqliteDb } from './close-sqlite-db.ts'

describe('worker database release', () => {
  for (const failing of [[], ['state'], ['eventlog'], ['state', 'eventlog']]) {
    it.effect(`attempts every release and retains close failures: ${failing.join(',')}`, () =>
      Effect.gen(function* () {
        const closed: string[] = []
        const result = yield* Effect.exit(
          Effect.scoped(
            Effect.forEach(
              ['state', 'eventlog'],
              (kind) =>
                Effect.acquireRelease(
                  Effect.succeed({
                    close: () => {
                      closed.push(kind)
                      if (failing.includes(kind) === true) throw new Error(`${kind} close failed`)
                    },
                  }),
                  closeSqliteDb,
                ),
              { concurrency: 2 },
            ),
          ),
        )
        expect(closed.toSorted()).toEqual(['eventlog', 'state'])
        expect(Exit.isFailure(result)).toBe(failing.length > 0)
        if (Exit.isFailure(result) === true) {
          for (const kind of failing) expect(Cause.pretty(result.cause)).toContain(`${kind} close failed`)
        }
      }),
    )
  }

  it.effect('interrupted partial startup releases acquired DB and retains a failing close', () =>
    Effect.gen(function* () {
      const acquired = yield* Deferred.make<void>()
      const error = new Error('partial startup close failed')
      let closes = 0
      const opening = yield* Effect.forkScoped(
        Effect.scoped(
          Effect.gen(function* () {
            yield* Effect.acquireRelease(
              Effect.succeed({
                close: () => {
                  closes++
                  throw error
                },
              }),
              closeSqliteDb,
            )
            yield* Deferred.succeed(acquired, undefined)
            return yield* Effect.never
          }),
        ),
      )
      yield* Deferred.await(acquired)
      yield* Fiber.interrupt(opening)
      const result = yield* Fiber.await(opening)
      expect(closes).toBe(1)
      expect(Exit.isFailure(result) && Cause.pretty(result.cause)).toContain(error.message)
    }).pipe(Effect.scoped),
  )
})
