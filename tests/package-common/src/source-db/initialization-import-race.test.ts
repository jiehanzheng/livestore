import { expect, it } from 'vitest'

import {
  fromSourceDb,
  initializeSource,
  SourceIdentity,
  type AsyncSourceDriver,
  type SourceBindings,
} from '@livestore/common/source-db'
import { Effect, Fiber } from '@livestore/utils/effect'

import { makeMemorySource, run } from './fixture.ts'

const signal = () => {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

it.each([
  ['owner', 'queued'],
  ['identity', 'queued'],
  ['owner', 'after-authorization'],
  ['identity', 'after-authorization'],
] as const)(
  'does not initialize imported empty bytes using an earlier %s allocation receipt (%s)',
  (entry, admission) =>
    run(
      Effect.gen(function* () {
        const empty = yield* makeMemorySource()
        yield* empty.source.transaction((tx) =>
          tx.execute('CREATE TABLE seed (id INTEGER)').pipe(Effect.andThen(tx.execute('DROP TABLE seed'))),
        )
        const bytes = yield* empty.source.export
        expect(bytes.byteLength).toBeGreaterThan(0)
        expect(yield* empty.source.select('SELECT name FROM sqlite_master')).toEqual([])

        const entered = signal(),
          release = signal(),
          statements: string[] = []
        let observer: AsyncSourceDriver | undefined
        let importedImage: Uint8Array | undefined
        const target = yield* makeMemorySource(undefined, {
          wrapDriver: (driver) => {
            observer = driver
            return {
              ...driver,
              import: async (image) => {
                await driver.import(image)
                // Compare against completed import so native header normalization is not mistaken for initialization.
                importedImage = await driver.export()
              },
              execute: async (sql, bindings) => {
                statements.push(sql)
                await driver.execute(sql, bindings)
              },
              select: async <Row extends object>(sql: string, bindings?: SourceBindings) => {
                if (sql === 'SELECT 1 AS admission_barrier') {
                  entered.resolve()
                  await release.promise
                }
                return driver.select<Row>(sql, bindings)
              },
            }
          },
        })
        const initialize = () =>
          entry === 'owner'
            ? initializeSource(
                fromSourceDb(target.source, { fresh: target.fresh!, storageName: target.storageName }),
              ).pipe(Effect.asVoid)
            : SourceIdentity.initialize(target.source, target.fresh!).pipe(Effect.asVoid)
        if (admission === 'queued') {
          const holding = yield* target.source
            .select('SELECT 1 AS admission_barrier')
            .pipe(Effect.forkChild({ startImmediately: true }))
          yield* Effect.promise(() => entered.promise)
          const importing = yield* target.source.import(bytes).pipe(Effect.forkChild({ startImmediately: true }))
          const initializing = yield* initialize().pipe(Effect.exit, Effect.forkChild({ startImmediately: true }))
          release.resolve()
          yield* Fiber.join(holding)
          yield* Fiber.join(importing)
          expect((yield* Fiber.join(initializing))._tag).toBe('Failure')
          expect(statements).toEqual([])
        } else {
          const transaction = target.source.transaction
          target.source.transaction = (use) =>
            Effect.promise(() => {
              entered.resolve()
              return release.promise
            }).pipe(Effect.andThen(transaction(use)))
          const initializing = yield* initialize().pipe(Effect.exit, Effect.forkChild({ startImmediately: true }))
          yield* Effect.promise(() => entered.promise)
          yield* target.source.import(bytes)
          release.resolve()
          expect((yield* Fiber.join(initializing))._tag).toBe('Failure')
          expect(statements).toEqual(['BEGIN IMMEDIATE', 'ROLLBACK'])
        }
        if (observer === undefined) throw new Error('Actual SQLite observer was not allocated')
        const native = observer
        expect(yield* Effect.promise(() => native.select('SELECT name FROM sqlite_master'))).toEqual([])
        expect(importedImage).toBeDefined()
        expect(yield* Effect.promise(() => native.export())).toEqual(importedImage)
      }),
    ),
)
