import { expect } from 'vitest'

import { makeInMemoryAdapter } from '@livestore/adapter-web'
import { migrateDb } from '@livestore/common'
import { makeSchema, State, SystemTables } from '@livestore/common/schema'
import { createStore } from '@livestore/livestore'
import { loadSqlite3Wasm } from '@livestore/sqlite-wasm/load-wasm'
import { sqliteDbFactory } from '@livestore/sqlite-wasm/node'
import { Vitest } from '@livestore/utils-dev/node-vitest'
import { Cause, Effect, Exit } from '@livestore/utils/effect'
import { PlatformNode } from '@livestore/utils/node'

Vitest.live('refuses state-only snapshots without a completion marker before import', (test) =>
  Effect.gen(function* () {
    const todos = State.SQLite.table({
      name: 'todos',
      columns: { id: State.SQLite.text({ primaryKey: true }) },
    })
    const schema = makeSchema({
      projectionRevision: 'state-only-import-refusal-test-v1',
      events: [],
      state: State.SQLite.makeState({ tables: { todos }, materializers: {} }),
    })
    const sqlite3 = yield* Effect.promise(() => loadSqlite3Wasm())
    const makeSqliteDb = yield* sqliteDbFactory({ sqlite3 })
    const sourceDb = yield* Effect.acquireRelease(makeSqliteDb({ _tag: 'in-memory' }), (db) =>
      Effect.sync(() => db.close()),
    )

    yield* migrateDb({ db: sourceDb, schema })
    sourceDb.execute(todos.insert({ id: 'imported' }))
    sourceDb.execute(`DROP TABLE ${SystemTables.REBUILD_META_TABLE}`)

    const exit = yield* createStore({
      schema,
      adapter: makeInMemoryAdapter({ importSnapshot: sourceDb.export() }),
      storeId: 'import-snapshot-without-completion-marker',
    }).pipe(Effect.exit)

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit) === true) expect(Cause.pretty(exit.cause)).toContain('LiveDatabaseImportRefusedError')
    expect(sourceDb.select(todos)).toEqual([{ id: 'imported' }])
  }).pipe(Effect.provide(PlatformNode.NodeFileSystem.layer), Vitest.withTestCtx(test)),
)

Vitest.live('rejects a snapshot carrying an invalidated persistence fence', (test) =>
  Effect.gen(function* () {
    const schema = makeSchema({
      projectionRevision: 'state-only-import-refusal-test-v1',
      events: [],
      state: State.SQLite.makeState({ tables: [], materializers: {} }),
    })
    const sqlite3 = yield* Effect.promise(() => loadSqlite3Wasm())
    const makeSqliteDb = yield* sqliteDbFactory({ sqlite3 })
    const source = yield* Effect.acquireRelease(makeSqliteDb({ _tag: 'in-memory' }), (db) =>
      Effect.sync(() => db.close()),
    )
    yield* migrateDb({ db: source, schema })
    expect(source.select(SystemTables.rebuildMetaTable)).toEqual([])
    const exit = yield* createStore({
      schema,
      adapter: makeInMemoryAdapter({ importSnapshot: source.export() }),
      storeId: 'reject-incomplete-import',
    }).pipe(Effect.exit)
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit) === true) expect(Cause.pretty(exit.cause)).toContain('LiveDatabaseImportRefusedError')
    expect(source.select(SystemTables.rebuildMetaTable)).toEqual([])
  }).pipe(Effect.provide(PlatformNode.NodeFileSystem.layer), Vitest.withTestCtx(test)),
)

Vitest.live('refuses even empty state-only input instead of treating it as a fresh source', (test) =>
  Effect.gen(function* () {
    const schema = makeSchema({
      projectionRevision: 'empty-import-refusal-test-v1',
      events: [],
      state: State.SQLite.makeState({ tables: [], materializers: {} }),
    })
    const exit = yield* createStore({
      schema,
      adapter: makeInMemoryAdapter({ importSnapshot: new Uint8Array() }),
      storeId: 'reject-empty-state-import',
    }).pipe(Effect.exit)
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit) === true) expect(Cause.pretty(exit.cause)).toContain('LiveDatabaseImportRefusedError')
  }).pipe(Effect.provide(PlatformNode.NodeFileSystem.layer), Vitest.withTestCtx(test)),
)
