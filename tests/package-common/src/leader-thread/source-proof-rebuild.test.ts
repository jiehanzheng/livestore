import { expect, test } from 'vitest'

import {
  MaterializationJournal,
  SqliteDbHelper,
  StateHead,
  StateSnapshot,
  StateSqliteDb,
  type BootStatus,
  type SqliteDb,
} from '@livestore/common'
import { Eventlog, makeMaterializeEvent, recreateDb } from '@livestore/common/leader-thread'
import { makeSchema, State, SystemTables } from '@livestore/common/schema'
import { SourceContext } from '@livestore/common/source-db'
import { loadSqlite3Wasm } from '@livestore/sqlite-wasm/load-wasm'
import { sqliteDbFactory } from '@livestore/sqlite-wasm/node'
import { Effect, Exit, Layer, Queue } from '@livestore/utils/effect'
import { PlatformNode } from '@livestore/utils/node'

import { newMemorySource } from './fixture.ts'

for (const stage of ['post-hook', 'after-completion-insert'] as const)
  test(`same-identity import ${stage} refuses rebuild completion and destroys incomplete STATE`, async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const runtime = yield* Effect.context<never>()
        const pending: Promise<void>[] = []
        const sqlite3 = yield* Effect.promise(() => loadSqlite3Wasm())
        const makeDb = yield* sqliteDbFactory({ sqlite3 })
        const source = yield* newMemorySource(yield* makeDb({ _tag: 'in-memory' }))
        const initializedSource = yield* Eventlog.initializeSource(source)
        const image = source.image
        if (image === undefined) return yield* Effect.die(new Error('Test memory SOURCE requires image support'))
        const bytes = yield* image.export
        const rawState = yield* Effect.acquireRelease(makeDb({ _tag: 'in-memory' }), (db) =>
          Effect.sync(() => db.close()),
        )
        let destroyed = 0
        let proofAtDestroy: StateSnapshot.Provenance | undefined
        let completionWrites = 0
        const state: SqliteDb = {
          ...rawState,
          execute: SqliteDbHelper.makeExecute((...args) => {
            const result = rawState.execute(...args)
            if (args[0].startsWith(`INSERT OR REPLACE INTO ${SystemTables.REBUILD_META_TABLE}`) === true) {
              completionWrites++
              if (stage === 'after-completion-insert') pending.push(Effect.runPromiseWith(runtime)(image.import(bytes)))
            }
            return result
          }),
          destroy: () => {
            destroyed++
            proofAtDestroy = StateSnapshot.readProvenance(rawState)
            rawState.destroy()
          },
        }
        const schema = makeSchema({
          projectionRevision: 'source-proof-rebuild',
          events: [],
          state: State.SQLite.makeState({
            tables: [],
            materializers: {},
            migrations: { hooks: { post: () => (stage === 'post-hook' ? image.import(bytes) : Effect.void) } },
          }),
        })
        const base = Layer.mergeAll(StateSqliteDb.layer(state), Layer.succeed(SourceContext, source))
        const services = Layer.mergeAll(
          base,
          Layer.mergeAll(StateHead.layer, MaterializationJournal.layer).pipe(Layer.provide(base)),
        )
        const materializeEvent = yield* makeMaterializeEvent({ schema }).pipe(Effect.provide(services))
        const bootStatusQueue = yield* Queue.unbounded<BootStatus>()
        const result = yield* recreateDb({ schema, initializedSource, materializeEvent, bootStatusQueue }).pipe(
          Effect.provide(services),
          Effect.exit,
        )
        yield* Effect.promise(() => Promise.all(pending))
        expect(Exit.isFailure(result)).toBe(true)
        expect(destroyed).toBe(1)
        expect(completionWrites).toBe(stage === 'post-hook' ? 0 : 1)
        expect(proofAtDestroy).toBeUndefined()
      }).pipe(Effect.provide(PlatformNode.NodeFileSystem.layer), Effect.scoped),
    )
  })
