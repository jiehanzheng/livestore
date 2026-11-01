import { describe, expect, it, vi } from 'vitest'

import * as SQLite from '@livestore/wa-sqlite'
import WaSqliteFactory from '@livestore/wa-sqlite/dist/wa-sqlite.node.mjs'

import { loadSqlite3Wasm, makeInMemoryDb } from '../lib/sqlite-utils.ts'

describe('statement ownership', () => {
  it.each(['SELECT 1; nonsense', 'SELECT 1; PRAGMA function_list'])('releases partial preparation: %s', async (sql) => {
    const api = await loadSqlite3Wasm()
    const db = makeInMemoryDb(api)
    api.set_authorizer(
      db,
      (_context, action) => (action === SQLite.SQLITE_PRAGMA ? SQLite.SQLITE_DENY : SQLite.SQLITE_OK),
      null,
    )
    expect(() => api.statements(db, sql, { unscoped: true })).toThrow()
    expect(() => api.close(db)).not.toThrow()
  })

  it('scopes normal iteration and early return', async () => {
    const api = await loadSqlite3Wasm()
    const db = makeInMemoryDb(api)
    for (const stmt of api.statements(db, 'SELECT 1; SELECT 2')) expect(api.step(stmt)).toBe(SQLite.SQLITE_ROW)
    for (const stmt of api.statements(db, 'SELECT 3; SELECT 4')) {
      expect(api.step(stmt)).toBe(SQLite.SQLITE_ROW)
      break
    }
    expect(() => api.close(db)).not.toThrow()
  })

  it('transfers successful unscoped handles to the caller', async () => {
    const api = await loadSqlite3Wasm()
    const db = makeInMemoryDb(api)
    const statements = api.statements(db, 'SELECT 1; SELECT 2', { unscoped: true })
    expect(statements).toHaveLength(2)
    for (const stmt of statements) {
      expect(api.step(stmt)).toBe(SQLite.SQLITE_ROW)
      api.finalize(stmt)
    }
    expect(() => api.close(db)).not.toThrow()
  })

  it('exec releases statements on callback and step failures', async () => {
    const api = await loadSqlite3Wasm()
    const db = makeInMemoryDb(api)
    const failure = new Error('consumer failure')
    expect(() =>
      api.exec(db, 'SELECT 1', () => {
        throw failure
      }),
    ).toThrow(failure)
    expect(() =>
      api.exec(db, 'SELECT 1', () => {
        throw undefined
      }),
    ).toThrow()
    api.exec(db, 'CREATE TABLE items (id INTEGER UNIQUE)')
    api.exec(db, 'INSERT INTO items VALUES (1)')
    expect(() => api.exec(db, 'INSERT INTO items VALUES (1)')).toThrow()
    expect(() => api.close(db)).not.toThrow()
  })
  it('releases the SQL allocation on success, early return and preparation failure', async () => {
    const module: { _sqlite3_malloc: (size: number) => number; _sqlite3_free: (pointer: number) => void } =
      await WaSqliteFactory()
    const api = SQLite.Factory(module)
    const db = api.open_v2Sync(':memory:')
    const allocated = new Set<number>()
    const malloc = module._sqlite3_malloc.bind(module)
    const free = module._sqlite3_free.bind(module)
    vi.spyOn(module, '_sqlite3_malloc').mockImplementation((size: number) => {
      const pointer = malloc(size)
      allocated.add(pointer)
      return pointer
    })
    vi.spyOn(module, '_sqlite3_free').mockImplementation((pointer: number) => {
      allocated.delete(pointer)
      free(pointer)
    })
    for (const _stmt of api.statements(db, 'SELECT 1')) {
      /* exhaust the scope */
    }
    expect(allocated.size).toBe(0)
    for (const _stmt of api.statements(db, 'SELECT 1')) break
    expect(allocated.size).toBe(0)
    expect(() => api.statements(db, 'SELECT 1; nonsense', { unscoped: true })).toThrow()
    expect(allocated.size).toBe(0)
    api.close(db)
  })

  it('preserves an undefined consumer failure alongside cleanup failure', async () => {
    const api = await loadSqlite3Wasm()
    const db = makeInMemoryDb(api)
    const finalize = api.finalize.bind(api)
    const cleanupFailure = new Error('cleanup failed after real finalize')
    vi.spyOn(api, 'finalize').mockImplementation((stmt) => {
      finalize(stmt)
      throw cleanupFailure
    })
    let failure: unknown
    try {
      api.exec(db, 'SELECT 1', () => {
        throw undefined
      })
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(AggregateError)
    expect((failure as AggregateError).errors).toEqual([undefined, cleanupFailure])
    expect(() => api.close(db)).not.toThrow()
  })
})
