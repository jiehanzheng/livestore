import type { MakeSqliteDb, PersistenceInfo, SqliteDb } from '@livestore/common'
import { Effect, Hash, type Scope } from '@livestore/utils/effect'
import type { Opfs } from '@livestore/utils/effect/browser'
import type { SQLiteAPI } from '@livestore/wa-sqlite'
import type { MemoryVFS } from '@livestore/wa-sqlite/src/examples/MemoryVFS.js'

import { makeInMemoryDb } from '../in-memory-vfs.ts'
import { makeSqliteDb } from '../make-sqlite-db.ts'
import { claimSharedMemoryApi } from './api-ownership.ts'
import { makeFactoryOwner } from './factory-owner.ts'
import type { AccessHandlePoolVFS } from './opfs/AccessHandlePoolVFS.ts'
import type { OpfsSourceCreation, OpfsSourceInventory } from './opfs/source-allocation.ts'
export { acquireOpfsSourceNamespace } from './opfs/source-allocation.ts'
export type { OpfsSourceNamespace, OpfsSourceInventory, OpfsSourceCreation } from './opfs/source-allocation.ts'

export * from './opfs/opfs-sah-pool.ts'
export { readOpfsSourceInventory } from './opfs/inventory.ts'

type WebDatabaseReq = {
  dbPointer: number
  persistenceInfo: PersistenceInfo
}

export type WebDatabaseMetadataInMemory = {
  _tag: 'in-memory'
  vfs: MemoryVFS
  dbPointer: number
  persistenceInfo: PersistenceInfo
  deleteDb: () => void
  configureDb: (db: SqliteDb) => void
}

export type WebDatabaseMetadataOpfs = {
  _tag: 'opfs'
  sourceCreation?: OpfsSourceCreation
  vfs: AccessHandlePoolVFS
  dbPointer: number
  persistenceInfo: PersistenceInfo<{
    opfsDirectory: string
    /** Actual filename used by OPFS */
    opfsFileName: string
  }>
  deleteDb: () => void
  configureDb: (db: SqliteDb) => void
}

export type WebDatabaseMetadata = WebDatabaseMetadataInMemory | WebDatabaseMetadataOpfs

export type WebDatabaseInputInMemory = {
  _tag: 'in-memory'
  configureDb?: (db: SqliteDb) => void
}

export type WebDatabaseInputOpfs = {
  _tag: 'opfs'
  /** Filename of the database file (only used when exporting/downloading the database) */
  fileName: string
  opfsDirectory: string
  sourceInventory?: OpfsSourceInventory
  sourceOpenMode?: 'retained-maintenance'
  configureDb?: (db: SqliteDb) => void
}

type MakeInMemoryWebDatabase = MakeSqliteDb<WebDatabaseReq, WebDatabaseInputInMemory, WebDatabaseMetadataInMemory>

type MakeOpfsWebDatabase = MakeSqliteDb<
  WebDatabaseReq,
  WebDatabaseInputOpfs,
  WebDatabaseMetadataOpfs,
  Opfs.Opfs | Scope.Scope
>

export const sqliteDbFactory = ({ sqlite3 }: { sqlite3: SQLiteAPI }) =>
  Effect.gen(function* () {
    const owner = yield* makeFactoryOwner(sqlite3)
    function makeDb(input: WebDatabaseInputInMemory): ReturnType<MakeInMemoryWebDatabase>
    function makeDb(input: WebDatabaseInputOpfs): ReturnType<MakeOpfsWebDatabase>
    function makeDb(
      input: WebDatabaseInputInMemory | WebDatabaseInputOpfs,
    ): ReturnType<
      MakeSqliteDb<
        WebDatabaseReq,
        WebDatabaseInputInMemory | WebDatabaseInputOpfs,
        WebDatabaseMetadata,
        Opfs.Opfs | Scope.Scope
      >
    > {
      return owner.acquire((onCreated) =>
        Effect.gen(function* () {
          if (input._tag === 'in-memory') {
            const { dbPointer, vfs } = makeInMemoryDb(sqlite3)
            return makeSqliteDb<WebDatabaseMetadataInMemory>({
              sqlite3,
              onCreated,
              metadata: {
                _tag: 'in-memory',
                vfs,
                dbPointer,
                deleteDb: () => {},
                configureDb: input.configureDb ?? (() => {}),
                persistenceInfo: {
                  fileName: ':memory:',
                },
              },
            })
          }

          // TODO figure out the actual max length
          const MAX_DB_FILENAME_LENGTH = 60

          let dbFilename = input.fileName

          if (input.fileName.length > MAX_DB_FILENAME_LENGTH) {
            yield* Effect.logWarning(
              `dbFilename too long: '${input.fileName}'. Max ${MAX_DB_FILENAME_LENGTH} chars, got ${input.fileName.length}. Hashing...`,
            )
            dbFilename = `hash-${Hash.string(input.fileName)}.db`
          }

          const { dbPointer, vfs, sourceCreation } = yield* owner.openOpfs({
            directory: input.opfsDirectory,
            fileName: dbFilename,
            ...(input.sourceInventory === undefined ? {} : { sourceInventory: input.sourceInventory }),
            ...(input.sourceOpenMode === undefined ? {} : { sourceOpenMode: input.sourceOpenMode }),
          })

          const services = yield* Effect.context<Opfs.Opfs>()

          return makeSqliteDb<WebDatabaseMetadataOpfs>({
            sqlite3,
            onCreated,
            metadata: {
              _tag: 'opfs',
              ...(sourceCreation === undefined ? {} : { sourceCreation }),
              vfs,
              dbPointer,
              deleteDb: () => vfs.resetAccessHandle(input.fileName).pipe(Effect.runSyncWith(services)),
              configureDb: input.configureDb ?? (() => {}),
              persistenceInfo: {
                fileName: dbFilename,
                opfsDirectory: input.opfsDirectory,
                opfsFileName: yield* vfs.getOpfsFileName(dbFilename),
              },
            },
          })
        }),
      )
    }

    return Object.assign(makeDb, { close: owner.close })
  })

export type MakeWebSqliteDb = Effect.Success<ReturnType<typeof sqliteDbFactory>>

/** Memory-only callers can share an API; it must never have owned physical pools. */
export const inMemorySqliteDbFactory = ({ sqlite3 }: { sqlite3: SQLiteAPI }) =>
  Effect.sync(() => {
    claimSharedMemoryApi(sqlite3)
    const makeDb = (input: WebDatabaseInputInMemory) =>
      Effect.sync(() => {
        const { dbPointer, vfs } = makeInMemoryDb(sqlite3)
        return makeSqliteDb<WebDatabaseMetadataInMemory>({
          sqlite3,
          metadata: {
            _tag: 'in-memory',
            vfs,
            dbPointer,
            deleteDb: () => {},
            configureDb: input.configureDb ?? (() => {}),
            persistenceInfo: { fileName: ':memory:' },
          },
        })
      })
    return makeDb
  })
