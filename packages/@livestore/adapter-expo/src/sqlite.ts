import { Effect } from 'effect'
import * as SQLite from 'expo-sqlite'

import {
  type MakeSqliteDb,
  type SqliteDb,
  type PreparedStatement,
  SqliteDbHelper,
  SqliteError,
} from '@livestore/common'
import { EventSequenceNumber } from '@livestore/common/schema'

import { nativeBindings, normalizedRows, ownedBytes } from './binary.ts'
import { createResourceLedger, withCleanup, type ResourceLedger } from './resources.ts'
import { assertSingleBoundStatement } from './single-statement.ts'

export type NativeInput = { _tag: 'in-memory' } | { _tag: 'file'; databaseName: string; directory: string }
export type NativeMetadata = { dbPointer: number; persistenceInfo: { fileName: string } } & NativeInput
type NativeFactory = MakeSqliteDb<NativeMetadata, NativeInput, NativeMetadata>
type OwnedResource = { close(): void }

const sqliteError = function (cause: unknown, note: string) {
  return new SqliteError({ cause, note })
}

const nativeSqliteFailure = function (cause: unknown): boolean {
  const errors: unknown[] = cause instanceof AggregateError ? cause.errors : [cause]
  return (
    errors.length > 0 &&
    errors.every((error) => error instanceof Error && 'code' in error && error.code === 'ERR_INTERNAL_SQLITE_ERROR')
  )
}

const finalizeStatement = function (statement: SQLite.SQLiteStatement, reportedSqliteFailure: boolean) {
  try {
    statement.finalizeSync()
  } catch (cause) {
    // sqlite3_finalize destroys its handle even when repeating the last SQL
    // error. Forgive only that already-reported error, with public closed-handle
    // attestation; unknown or previously unreported failures remain uncertain.
    if (reportedSqliteFailure === true && nativeSqliteFailure(cause) === true) {
      try {
        statement.getColumnNamesSync()
      } catch (state) {
        if (state instanceof Error && 'code' in state && state.code === 'ERR_ACCESS_CLOSED_RESOURCE') return
      }
    }
    throw cause
  }
}

export const createSqliteFactory = function () {
  const ledger = createResourceLedger()
  // Common's generic factory promises metadata narrowed by the input tag; the
  // implementation constructs that exact discriminated metadata below.
  const makeSqliteDb = ((input: NativeInput) =>
    Effect.try({
      try: () => openSqlite(input, ledger),
      catch: (cause) => {
        // Expo can reject initialization after allocating native state without
        // returning a handle. No caller can then positively attest its closure.
        ledger.failed(cause)
        return sqliteError(cause, 'Native SQLite acquisition failed.')
      },
    })) as NativeFactory
  return { makeSqliteDb, assertClosed: ledger.assertClosed }
}

const openSqlite = function (input: NativeInput, ledger: ResourceLedger): SqliteDb<NativeMetadata> {
  // Cached native connections would let one owner's close invalidate another.
  const db =
    input._tag === 'in-memory'
      ? SQLite.openDatabaseSync(':memory:', { useNewConnection: true })
      : SQLite.openDatabaseSync(input.databaseName, { useNewConnection: true }, input.directory)
  ledger.acquire(db)
  const resources = new Set<OwnedResource>()
  let phase: 'open' | 'closing' | 'closed' | 'failed' = 'open'
  let closeFailure: unknown
  let destroyed = false
  // Common requires pointer metadata, but Expo exposes no public native pointer.
  // Engine ownership uses this wrapper's resources; native devtools are disabled.
  const metadata: NativeMetadata = {
    ...input,
    dbPointer: 0,
    persistenceInfo: { fileName: input._tag === 'file' ? `${input.directory}/${input.databaseName}` : ':memory:' },
  }
  const assertOpen = function () {
    if (phase !== 'open') throw sqliteError(closeFailure, `Native SQLite connection is ${phase}.`)
  }
  const operation = function <T>(label: string, run: () => T): T {
    assertOpen()
    try {
      return run()
    } catch (cause) {
      throw sqliteError(cause, `Native SQLite ${label} failed.`)
    }
  }
  const own = function (close: () => void): OwnedResource {
    let state: 'open' | 'closed' | 'failed' = 'open'
    let failure: unknown
    const resource: OwnedResource = {
      close() {
        if (state === 'closed') return
        if (state === 'failed') throw failure
        try {
          close()
          state = 'closed'
          resources.delete(resource)
        } catch (cause) {
          state = 'failed'
          failure = cause
          ledger.failed(cause)
          throw cause
        }
      },
    }
    resources.add(resource)
    return resource
  }
  const prepare = function (sql: string): PreparedStatement {
    return operation('prepare', () => {
      const statement = db.prepareSync(sql)
      let reportedSqliteFailure = false
      const resource = own(() => finalizeStatement(statement, reportedSqliteFailure))
      let finalized = false
      const run = function <T>(action: () => T): T {
        return operation('statement', () => {
          if (finalized === true) throw new Error('The native statement is finalized.')
          reportedSqliteFailure = false
          try {
            return action()
          } catch (cause) {
            reportedSqliteFailure = nativeSqliteFailure(cause)
            throw cause
          }
        })
      }
      return {
        sql,
        execute(values, options) {
          const changed = run(() => {
            const result = statement.executeSync(nativeBindings(values))
            return withCleanup(
              () => result.changes,
              () => result.resetSync(),
            )
          })
          options?.onRowsChanged?.(changed)
        },
        select<T>(values: Parameters<PreparedStatement['select']>[0]) {
          return run(() => {
            const result = statement.executeSync<Record<string, unknown>>(nativeBindings(values))
            return withCleanup(
              () => normalizedRows<T>(result.getAllSync()),
              () => result.resetSync(),
            )
          })
        },
        finalize() {
          finalized = true
          resource.close()
        },
      }
    })
  }
  const nativeSession = function <T>(run: (session: SQLite.SQLiteSession) => T): T {
    return operation('changeset', () => {
      const session = db.createSessionSync()
      const resource = own(() => session.closeSync())
      return withCleanup(() => run(session), resource.close)
    })
  }
  const sqlite: SqliteDb<NativeMetadata> = {
    _tag: 'SqliteDb',
    metadata,
    debug: { head: EventSequenceNumber.Client.ROOT },
    prepare,
    execute: SqliteDbHelper.makeExecute((sql, values, options) => {
      // Core connection/schema setup contains SQL scripts. prepareSync executes
      // only their first statement, silently dropping later PRAGMAs or DDL.
      if (Object.keys(values ?? {}).length === 0) {
        operation('execute script', () => {
          const total = () => sqlite.select<{ changes: number }>('SELECT total_changes() AS changes')[0]!.changes
          const before = options?.onRowsChanged !== undefined ? total() : 0
          db.execSync(sql)
          if (options?.onRowsChanged !== undefined) options.onRowsChanged(total() - before)
        })
        return
      }
      assertSingleBoundStatement(sql)
      const statement = prepare(sql)
      withCleanup(() => statement.execute(values, options), statement.finalize)
    }),
    select: SqliteDbHelper.makeSelect((sql, values) => {
      const statement = prepare(sql)
      return withCleanup(() => statement.select(values), statement.finalize)
    }),
    export: SqliteDbHelper.makeExport(() => operation('export', () => ownedBytes(db.serializeSync()))),
    import: (source) =>
      operation('import', () => {
        const bytes = ownedBytes(source instanceof Uint8Array ? source : source.export())
        let temporary: SQLite.SQLiteDatabase
        try {
          temporary = SQLite.deserializeDatabaseSync(bytes, { useNewConnection: true })
        } catch (cause) {
          ledger.failed(cause)
          throw cause
        }
        ledger.acquire(temporary)
        withCleanup(
          () => SQLite.backupDatabaseSync({ sourceDatabase: temporary, destDatabase: db }),
          () => {
            try {
              temporary.closeSync()
              ledger.release(temporary)
            } catch (cause) {
              ledger.failed(cause)
              throw cause
            }
          },
        )
      }),
    session: () =>
      operation('session', () => {
        const session = db.createSessionSync()
        const resource = own(() => session.closeSync())
        try {
          session.attachSync(null)
        } catch (cause) {
          return withCleanup((): never => {
            throw cause
          }, resource.close)
        }
        let finished = false
        return {
          changeset: () =>
            operation('changeset capture', () => {
              if (finished === true) throw new Error('The native session is finished.')
              return ownedBytes(session.createChangesetSync())
            }),
          finish() {
            finished = true
            resource.close()
          },
        }
      }),
    makeChangeset: (inputBytes) => {
      // Common changesets have no dispose method. Retain only bytes; a native
      // session exists for the duration of each operation, never for this object.
      const bytes = ownedBytes(inputBytes)
      return {
        invert: () => sqlite.makeChangeset(nativeSession((session) => ownedBytes(session.invertChangesetSync(bytes)))),
        apply: () => nativeSession((session) => session.applyChangesetSync(bytes)),
      }
    },
    close() {
      if (phase === 'closed') return
      if (phase !== 'open') throw closeFailure ?? new Error(`Native SQLite connection is ${phase}.`)
      phase = 'closing'
      const causes: unknown[] = []
      for (const resource of resources) {
        try {
          resource.close()
        } catch (cause) {
          causes.push(cause)
        }
      }
      try {
        db.closeSync()
        ledger.release(db)
      } catch (cause) {
        ledger.failed(cause)
        causes.push(cause)
      }
      if (causes.length > 0) {
        phase = 'failed'
        closeFailure = sqliteError(new AggregateError(causes), 'Native SQLite closure failed.')
        throw closeFailure
      }
      phase = 'closed'
    },
    destroy() {
      if (destroyed === true) return
      sqlite.close()
      if (input._tag === 'file') {
        try {
          SQLite.deleteDatabaseSync(input.databaseName, input.directory)
        } catch (cause) {
          ledger.failed(cause)
          throw sqliteError(cause, 'Native SQLite deletion failed.')
        }
      }
      destroyed = true
    },
  }
  return sqlite
}
