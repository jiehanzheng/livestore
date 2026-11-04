import type { SqliteDb } from '../sqlite-types.ts'
import type { PreparedBindValues } from '../util.ts'
import type { AsyncSourceDriver } from './role.ts'

/** Only SOURCE callers choose this boundary; synchronous STATE and public materializer queries remain unchanged. */
export const sourceDriverFromSync = (
  db: Pick<SqliteDb, 'execute' | 'select' | 'export' | 'import' | 'close'>,
  isHeld: () => boolean = () => true,
): AsyncSourceDriver => {
  const assertHeld = () => {
    if (isHeld() !== true) throw new Error('SOURCE physical namespace owner is no longer held')
  }
  return {
    execute: async (sql, bindings) => {
      assertHeld()
      db.execute(sql, bindings as PreparedBindValues | undefined)
    },
    select: async <Row extends object>(sql: string, bindings?: Parameters<AsyncSourceDriver['execute']>[1]) => {
      assertHeld()
      return db.select<Row>(sql, bindings as PreparedBindValues | undefined)
    },
    export: async () => {
      assertHeld()
      return db.export()
    },
    import: async (bytes) => {
      assertHeld()
      db.import(bytes as Uint8Array<ArrayBuffer>)
    },
    close: async () => {
      db.close()
    },
  }
}
