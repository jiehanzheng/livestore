import { Effect, Fiber } from 'effect'
import { describe, expect, test } from 'vitest'

import { makeSourceDb, type AsyncSourceDriver } from './role.ts'

const signal = () => {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('physical SOURCE admission across image replacement', () => {
  test.each(['select', 'export', 'import', 'transaction'] as const)(
    'refuses a queued stale %s before native work',
    async (operation) => {
      const entered = signal(),
        release = signal(),
        calls: string[] = []
      const driver: AsyncSourceDriver = {
        execute: async (sql) => {
          calls.push(sql)
        },
        select: async () => {
          calls.push('SELECT')
          return []
        },
        export: async () => {
          calls.push('EXPORT')
          entered.resolve()
          await release.promise
          return new Uint8Array([9])
        },
        import: async (bytes) => {
          calls.push(`IMPORT ${bytes[0]}`)
        },
        close: async () => {
          calls.push('CLOSE')
        },
      }
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const source = yield* makeSourceDb(driver)
            yield* Effect.addFinalizer(() => source.close.pipe(Effect.orDie))
            const holding = yield* source.export.pipe(Effect.forkChild({ startImmediately: true }))
            yield* Effect.promise(() => entered.promise)
            const importing = yield* source
              .import(new Uint8Array([1]))
              .pipe(Effect.forkChild({ startImmediately: true }))
            const request =
              operation === 'select'
                ? source.select('OLD').pipe(Effect.asVoid)
                : operation === 'export'
                  ? source.export.pipe(Effect.asVoid)
                  : operation === 'import'
                    ? source.import(new Uint8Array([2]))
                    : source.transaction((transaction) => transaction.execute('OLD'))
            const stale = yield* request.pipe(Effect.exit, Effect.forkChild({ startImmediately: true }))
            release.resolve()
            yield* Fiber.join(holding)
            yield* Fiber.join(importing)
            expect((yield* Fiber.join(stale))._tag).toBe('Failure')
            expect(calls).toEqual(['EXPORT', 'IMPORT 1'])
            // Effects are reusable: a new execution after replacement belongs to the new epoch.
            yield* request
            expect(calls.length).toBeGreaterThan(2)
          }),
        ),
      )
    },
  )
})
