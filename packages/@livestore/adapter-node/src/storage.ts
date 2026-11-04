import fs from 'node:fs'
import path from 'node:path'

import type { AdapterArgs, SqliteDb, SqliteError, AdapterError } from '@livestore/common'
import { liveStoreStorageFormatVersion, mapToAdapterError, toAdapterError } from '@livestore/common'
import { configureConnection } from '@livestore/common/leader-thread'
import { getStateDbBaseName } from '@livestore/common/schema'
import { fromSyncSource, initializeSource, type InitializedSource, type SourceOwner } from '@livestore/common/source-db'
import { reserveNodeSource, type MakeNodeSqliteDb } from '@livestore/sqlite-wasm/node'
import { Effect, Exit, type Scope } from '@livestore/utils/effect'

import { inspectNodeStorage } from './storage-layout.ts'

export type NodeStorage = { type: 'in-memory' } | { type: 'fs'; baseDirectory: string }

export const openDatabases = (
  args: Pick<AdapterArgs, 'schema' | 'storeId'>,
  storage: NodeStorage,
  makeSqliteDb: MakeNodeSqliteDb,
): Effect.Effect<
  { dbState: SqliteDb; dbEventlog: SourceOwner; initializedSource: InitializedSource },
  AdapterError | SqliteError,
  Scope.Scope
> =>
  Effect.gen(function* () {
    const services = yield* Effect.context()
    const configureDb = (db: SqliteDb) =>
      configureConnection(db, { foreignKeys: true }).pipe(Effect.runSyncWith(services))
    const dbEventlog = yield* Effect.acquireRelease(
      Effect.gen(function* () {
        let memoryHeld = true
        const native = yield* storage.type === 'in-memory'
          ? makeSqliteDb({ _tag: 'in-memory', configureDb })
          : Effect.gen(function* () {
              const layout = yield* Effect.tryPromise({
                try: () => inspectNodeStorage(storage.baseDirectory, args.storeId),
                catch: toAdapterError,
              })
              const directory = path.join(storage.baseDirectory, args.storeId)
              const fileName = `eventlog@${liveStoreStorageFormatVersion}.db`
              // Discovery chooses an open mode; only the exact exclusive descriptor can authorize creation.
              const sourceCreation =
                layout.sourceIsNew === false
                  ? undefined
                  : yield* Effect.try({
                      try: () => {
                        fs.mkdirSync(directory, { recursive: true })
                        return reserveNodeSource(path.join(directory, fileName))
                      },
                      catch: toAdapterError,
                    })
              return yield* makeSqliteDb({
                _tag: 'fs',
                directory,
                fileName,
                configureDb,
                create: false,
                ...(sourceCreation === undefined ? {} : { sourceCreation }),
              })
            })
        const creation =
          native.metadata._tag === 'fs'
            ? native.metadata.sourceCreation
            : {
                storageName: ':memory:',
                kind: 'new-memory-connection' as const,
                isHeld: () => memoryHeld,
              }
        const owner = yield* fromSyncSource(native, creation).pipe(
          Effect.onExit((exit) =>
            Exit.isFailure(exit) === true
              ? Effect.sync(() => {
                  native.close()
                  memoryHeld = false
                })
              : Effect.void,
          ),
        )
        return {
          owner,
          release: owner.close.pipe(
            Effect.ensuring(
              Effect.sync(() => {
                memoryHeld = false
              }),
            ),
          ),
        }
      }),
      ({ release }) => release.pipe(Effect.orDie),
    ).pipe(Effect.map(({ owner }) => owner))
    const initializedSource = yield* initializeSource(dbEventlog)
    const dbState = yield* Effect.acquireRelease(
      makeSqliteDb({
        ...(storage.type === 'in-memory'
          ? { _tag: 'in-memory' as const }
          : {
              _tag: 'fs' as const,
              directory: path.join(storage.baseDirectory, args.storeId),
              fileName: `${getStateDbBaseName(args.schema)}@${liveStoreStorageFormatVersion}.db`,
            }),
        configureDb,
      }),
      (db) => Effect.sync(() => db.close()),
    )
    return { dbState, dbEventlog, initializedSource }
  }).pipe(mapToAdapterError)
