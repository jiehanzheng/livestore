import path from 'node:path'

import type { MakeInMemorySqliteDb, SqliteDb } from '@livestore/common'
import { fromSyncSource } from '@livestore/common/source-db'
import { reserveNodeSource, type MakeNodeSqliteDb } from '@livestore/sqlite-wasm/node'
import { Effect } from '@livestore/utils/effect'

import { newMemorySource } from '../leader-thread/fixture.ts'

/** SOURCE owns the raw connection's finalizer; decorators keep the real failure boundary on that connection. */
export const acquireMemorySource = (
  factory: MakeInMemorySqliteDb,
  decorate: (database: SqliteDb) => SqliteDb = (database) => database,
) =>
  Effect.acquireRelease(
    factory({ _tag: 'in-memory' }).pipe(Effect.flatMap((database) => newMemorySource(decorate(database)))),
    (source) => source.close.pipe(Effect.orDie),
  )

export const acquireNewFileSource = (
  factory: MakeNodeSqliteDb,
  { directory, fileName }: { directory: string; fileName: string },
  decorate: (database: SqliteDb) => SqliteDb = (database) => database,
) =>
  Effect.acquireRelease(
    Effect.gen(function* () {
      const sourceCreation = yield* Effect.sync(() => reserveNodeSource(path.join(directory, fileName)))
      const database = yield* factory({ _tag: 'fs', directory, fileName, sourceCreation })
      return yield* fromSyncSource(decorate(database), database.metadata.sourceCreation)
    }),
    (source) => source.close.pipe(Effect.orDie),
  )

export const acquireRetainedFileSource = (
  factory: (input: {
    _tag: 'fs'
    directory: string
    fileName: string
    create: false
  }) => ReturnType<MakeInMemorySqliteDb>,
  { directory, fileName }: { directory: string; fileName: string },
) =>
  Effect.acquireRelease(
    factory({ _tag: 'fs', directory, fileName, create: false }).pipe(
      Effect.flatMap((database) => fromSyncSource(database)),
    ),
    (source) => source.close.pipe(Effect.orDie),
  )
