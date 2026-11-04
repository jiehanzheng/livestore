import path from 'node:path'

import { type MakeSqliteDb, type PersistenceInfo, type SqliteDb, UnknownError } from '@livestore/common'
import { Effect, Exit, FileSystem } from '@livestore/utils/effect'
import type * as WaSqlite from '@livestore/wa-sqlite'
import type { MemoryVFS } from '@livestore/wa-sqlite/src/examples/MemoryVFS.js'
import { SQLITE_OPEN_READWRITE } from '@livestore/wa-sqlite/src/sqlite-constants.js'

import { makeInMemoryDb } from '../in-memory-vfs.ts'
import { makeSqliteDb } from '../make-sqlite-db.ts'
import { NodeFS } from './NodeFS.ts'
import { type NodeSourceCreation, type NodeSourceCreationBoundary } from './source-creation.ts'

export { NodeSourceCreation, reserveNodeSource } from './source-creation.ts'

const nodeVfsByApi = new WeakMap<WaSqlite.SQLiteAPI, Map<string, NodeFS>>()
const uncertainNodeOwners = new Set<object>()

export type NodeDatabaseMetadataInMemory = {
  _tag: 'in-memory'
  vfs: MemoryVFS
  dbPointer: number
  persistenceInfo: PersistenceInfo
  deleteDb: () => void
  configureDb: (db: SqliteDb) => void
}

export type NodeDatabaseMetadataFs = {
  _tag: 'fs'
  sourceCreation?: NodeSourceCreationBoundary
  vfs: NodeFS
  dbPointer: number
  persistenceInfo: PersistenceInfo<{ directory: string }>
  deleteDb: () => void
  configureDb: (db: SqliteDb) => void
}

export type NodeDatabaseMetadata = NodeDatabaseMetadataInMemory | NodeDatabaseMetadataFs

export type NodeDatabaseInputInMemory = {
  _tag: 'in-memory'
  configureDb?: (db: SqliteDb) => void
}

export type NodeDatabaseInputFs = {
  _tag: 'fs'
  directory: string
  fileName: string
  /** A retained source open must not create a missing main file. */
  create?: boolean
  sourceCreation?: NodeSourceCreation
  configureDb?: (db: SqliteDb) => void
}

export type NodeDatabaseInput = NodeDatabaseInputInMemory | NodeDatabaseInputFs

export type MakeNodeSqliteDb = MakeSqliteDb<
  { dbPointer: number; persistenceInfo: PersistenceInfo },
  NodeDatabaseInput,
  NodeDatabaseMetadata
>

export const sqliteDbFactory = ({
  sqlite3,
}: {
  sqlite3: SQLiteAPI
}): Effect.Effect<MakeNodeSqliteDb, never, FileSystem.FileSystem> =>
  Effect.map(
    FileSystem.FileSystem,
    (fs) => (input) =>
      Effect.gen(function* () {
        if (input._tag === 'in-memory') {
          const { dbPointer, vfs } = makeInMemoryDb(sqlite3)
          return makeSqliteDb<NodeDatabaseMetadataInMemory>({
            sqlite3,
            metadata: {
              _tag: 'in-memory',
              vfs,
              dbPointer,
              persistenceInfo: { fileName: ':memory:' },
              deleteDb: () => {},
              configureDb: input.configureDb ?? (() => {}),
            },
          }) as any
        }

        const { dbPointer, vfs, sourceCreation, assertClosed } = yield* makeNodeFsDb({
          sqlite3,
          fileName: input.fileName,
          directory: input.directory,
          fs,
          create: input.create ?? true,
          sourceCreation: input.sourceCreation,
        })

        return yield* Effect.try({
          try: () => configureNodeFsDb(sqlite3, input, dbPointer, vfs, sourceCreation, assertClosed),
          catch: (cause) => new UnknownError({ cause }),
        })
      }),
  )

const makeNodeFsDb = ({
  sqlite3,
  fileName,
  directory,
  fs,
  create,
  sourceCreation,
}: {
  sqlite3: WaSqlite.SQLiteAPI
  fileName: string
  directory: string
  fs: FileSystem.FileSystem
  create: boolean
  sourceCreation: NodeSourceCreation | undefined
}) =>
  Effect.gen(function* () {
    const databasePath = path.resolve(directory, fileName)
    let registrations = nodeVfsByApi.get(sqlite3)
    if (registrations === undefined) {
      registrations = new Map()
      nodeVfsByApi.set(sqlite3, registrations)
    }
    let vfs = registrations.get(databasePath)
    if (vfs === undefined) {
      const vfsName = `node-fs-db-${registrations.size}`
      if (sqlite3.vfs_registered.has(vfsName) === true) {
        throw new Error('Node VFS name belongs to an unknown physical owner')
      }
      if ('module' in sqlite3 === false) throw new Error('Node SQLite API lacks its owned WASM module')
      vfs = new NodeFS(vfsName, sqlite3.module, path.dirname(databasePath))
      sqlite3.vfs_register(vfs, false)
      // xOpen has no connection ID and SQLite can ignore xClose errors. One database per VFS makes every retained fd attributable.
      registrations.set(databasePath, vfs)
    }
    const vfsName = vfs.name
    if (create === true) yield* fs.makeDirectory(directory, { recursive: true })

    const FILE_NAME_MAX_LENGTH = 56
    if (fileName.length > FILE_NAME_MAX_LENGTH) {
      throw new Error(`File name ${fileName} is too long. Maximum length is ${FILE_NAME_MAX_LENGTH} characters.`)
    }

    return yield* Effect.try({
      try: () => openNodeFsDb(sqlite3, vfs, vfsName, path.basename(databasePath), create, sourceCreation),
      catch: (cause) => new UnknownError({ cause }),
    })
  }).pipe(
    Effect.onExit((exit) =>
      Exit.isFailure(exit) === true && sourceCreation !== undefined
        ? Effect.sync(() => closeUnadoptedSource(sourceCreation))
        : Effect.void,
    ),
    UnknownError.mapToUnknownError,
  )

const closeUnadoptedSource = (sourceCreation: NodeSourceCreation): void => {
  try {
    sourceCreation.closeUnadopted()
  } catch (cause) {
    // Even pre-open close failures must keep their numeric descriptor owner reachable.
    uncertainNodeOwners.add({ sourceCreation, cause })
    throw cause
  }
}

const configureNodeFsDb = (
  sqlite3: WaSqlite.SQLiteAPI,
  input: NodeDatabaseInputFs,
  dbPointer: number,
  vfs: NodeFS,
  sourceCreation: NodeSourceCreationBoundary | undefined,
  assertClosed: () => void,
) => {
  const closeState: { attempted: boolean; close: (() => void) | undefined } = { attempted: false, close: undefined }
  const filePath = path.resolve(input.directory, input.fileName)
  try {
    return makeSqliteDb<NodeDatabaseMetadataFs>({
      sqlite3,
      onCreated: (db) => {
        const closeSqlite = db.close
        let closed = false
        let failure: { cause: unknown } | undefined
        closeState.close = () => {
          if (failure !== undefined) throw failure.cause
          if (closed === true) return
          closeState.attempted = true
          try {
            closeSqlite()
            assertClosed()
            closed = true
          } catch (cause) {
            failure = { cause }
            uncertainNodeOwners.add({ sqlite3, vfs, dbPointer, cause })
            throw cause
          }
        }
        db.close = closeState.close
      },
      metadata: {
        _tag: 'fs',
        ...(sourceCreation === undefined ? {} : { sourceCreation }),
        vfs,
        dbPointer,
        persistenceInfo: { fileName: input.fileName, directory: input.directory },
        deleteDb: () => vfs.deleteDb(filePath),
        configureDb: input.configureDb ?? (() => {}),
      },
    })
  } catch (cause) {
    // A failed owned close is already quarantined; never issue another SQLite close on its freed/uncertain pointer.
    if (closeState.attempted === true) throw cause
    try {
      if (closeState.close !== undefined) closeState.close()
      else {
        sqlite3.close(dbPointer)
        assertClosed()
      }
    } catch (cleanup) {
      uncertainNodeOwners.add({ sqlite3, vfs, dbPointer, cause, cleanup })
      throw new AggregateError([cause, cleanup], 'Node SQLite configuration and closure failed', { cause: cleanup })
    }
    throw cause
  }
}

const openNodeFsDb = (
  sqlite3: WaSqlite.SQLiteAPI,
  vfs: NodeFS,
  vfsName: string,
  fileName: string,
  create: boolean,
  sourceCreation: NodeSourceCreation | undefined,
) => {
  if (sourceCreation !== undefined) vfs.registerSourceCreation(sourceCreation, fileName)
  try {
    const { dbPointer, assertClosed } = vfs.trackDatabaseOpen(fileName, () =>
      sqlite3.open_v2Sync(fileName, create === true ? undefined : SQLITE_OPEN_READWRITE, vfsName),
    )
    return { dbPointer, assertClosed, vfs, sourceCreation: sourceCreation?.opened() }
  } catch (cause) {
    // A failed open can hide SQLite's pointer. Keep its VFS and adopted descriptor, rather than guessing disposal.
    uncertainNodeOwners.add({ sqlite3, vfs, sourceCreation, cause })
    if (sourceCreation !== undefined) {
      try {
        vfs.discardUnadoptedSource(sourceCreation)
      } catch (cleanup) {
        throw new AggregateError([cause, cleanup], 'Node SQLite open and unadopted descriptor cleanup failed', {
          cause: cleanup,
        })
      }
    }
    throw cause
  }
}
