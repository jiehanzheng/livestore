import { expect, vi } from 'vitest'

import { SqliteError } from '@livestore/common'
import { loadSqlite3Wasm } from '@livestore/sqlite-wasm/load-wasm'
import { sqliteDbFactory } from '@livestore/sqlite-wasm/node'
import { Vitest } from '@livestore/utils-dev/node-vitest'
import { Effect } from '@livestore/utils/effect'
import { PlatformNode } from '@livestore/utils/node'

for (const failureMode of ['throw', 'return-error'] as const) {
  Vitest.live(`byte import closes its temporary database when deserialize ${failureMode}`, (test) =>
    Effect.gen(function* () {
      const sqlite3 = yield* Effect.promise(() => loadSqlite3Wasm())
      const makeDb = yield* sqliteDbFactory({ sqlite3 })
      const db = yield* Effect.acquireRelease(makeDb({ _tag: 'in-memory' }), (connection) =>
        Effect.sync(() => connection.close()),
      )
      db.execute('CREATE TABLE retained (value TEXT)')
      db.execute("INSERT INTO retained VALUES ('unchanged')")
      const bytes = db.export()
      const before = bytes.slice()
      const failure = new Error('Injected deserialize failure')
      let temporaryPointer: number | undefined
      const close = vi.spyOn(sqlite3, 'close')
      const deserialize = vi.spyOn(sqlite3, 'deserialize').mockImplementation((pointer) => {
        temporaryPointer = pointer
        if (failureMode === 'throw') throw failure
        return 6 // SQLITE_BUSY: a native failure before the backup can begin.
      })

      try {
        expect(() => db.import(bytes)).toThrow(failureMode === 'throw' ? failure : SqliteError)
        expect(temporaryPointer).toBeDefined()
        expect(close).toHaveBeenCalledExactlyOnceWith(temporaryPointer)
        expect(() => sqlite3.exec(temporaryPointer!, 'SELECT 1')).toThrow()
        expect(db.select('SELECT value FROM retained')).toEqual([{ value: 'unchanged' }])
        expect(bytes).toEqual(before)
      } finally {
        deserialize.mockRestore()
        close.mockRestore()
      }
    }).pipe(Effect.provide(PlatformNode.NodeFileSystem.layer), Vitest.withTestCtx(test)),
  )
}
