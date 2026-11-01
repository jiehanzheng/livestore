import path from 'node:path'

import type { AdapterArgs, SqliteDb, SqliteError, AdapterError, SourceIdentity } from '@livestore/common'
import { liveStoreStorageFormatVersion } from '@livestore/common'
import { configureConnection, Eventlog } from '@livestore/common/leader-thread'
import { getStateDbBaseName } from '@livestore/common/schema'
import type { MakeNodeSqliteDb } from '@livestore/sqlite-wasm/node'
import { Effect, type Scope } from '@livestore/utils/effect'

import { inspectNodeStorage } from './storage-layout.ts'

export type NodeStorage = { type: 'in-memory' } | { type: 'fs'; baseDirectory: string }

export const openDatabases = (
  args: AdapterArgs,
  storage: NodeStorage,
  makeSqliteDb: MakeNodeSqliteDb,
): Effect.Effect<
  { dbState: SqliteDb; dbEventlog: SqliteDb; initializedSource: SourceIdentity.InitializedSource },
  AdapterError | SqliteError,
  Scope.Scope
> =>
  Effect.gen(function* () {
    const { sourceIsNew } =
      storage.type === 'in-memory'
        ? { sourceIsNew: true }
        : yield* Effect.promise(() => inspectNodeStorage(storage.baseDirectory, args.storeId))
    const services = yield* Effect.context()
    const open = (kind: 'state' | 'eventlog') =>
      Effect.acquireRelease(
        makeSqliteDb({
          ...(storage.type === 'in-memory'
            ? { _tag: 'in-memory' as const }
            : {
                _tag: 'fs' as const,
                directory: path.join(storage.baseDirectory, args.storeId),
                fileName:
                  kind === 'state'
                    ? `${getStateDbBaseName(args.schema)}@${liveStoreStorageFormatVersion}.db`
                    : `eventlog@${liveStoreStorageFormatVersion}.db`,
              }),
          configureDb: (db) => configureConnection(db, { foreignKeys: true }).pipe(Effect.runSyncWith(services)),
        }),
        (db) => Effect.sync(() => db.close()),
      )
    const dbEventlog = yield* open('eventlog')
    const initializedSource = yield* Eventlog.initializeSource(dbEventlog, { sourceIsNew })
    const dbState = yield* open('state')
    return { dbState, dbEventlog, initializedSource }
  })
