import { configureConnection } from '@livestore/common/leader-thread'
import { fromSyncSource, SourceIdentity } from '@livestore/common/source-db'
import {
  SourceMaintenanceError,
  type ApplicationBinding,
  type SourceMaintenanceLocationOwner,
} from '@livestore/common/source-maintenance'
import { retainedSourceMaintenanceOpener } from '@livestore/common/source-maintenance/internal'
import type { MakeNodeSqliteDb } from '@livestore/sqlite-wasm/node'
import { Effect, Exit } from '@livestore/utils/effect'

/** The application's location owner supplies exclusion through joined teardown; NodeFS supplies no OS file lock. */
export const makeNodeSourceMaintenanceOpener = ({
  binding,
  locationOwner,
  directory,
  fileName,
  makeSqliteDb,
}: {
  binding: ApplicationBinding
  locationOwner: SourceMaintenanceLocationOwner
  directory: string
  fileName: string
  makeSqliteDb: MakeNodeSqliteDb
}) =>
  retainedSourceMaintenanceOpener({
    binding,
    locationOwner,
    acquire: Effect.gen(function* () {
      const source = yield* Effect.acquireRelease(
        Effect.gen(function* () {
          const services = yield* Effect.context()
          const native = yield* makeSqliteDb({
            _tag: 'fs',
            directory,
            fileName,
            create: false,
            configureDb: (db) => configureConnection(db, { foreignKeys: true }).pipe(Effect.runSyncWith(services)),
          }).pipe(Effect.mapError((cause) => new SourceMaintenanceError('node-retained-open', cause)))
          return yield* fromSyncSource(native).pipe(
            Effect.onExit((exit) => (Exit.isFailure(exit) === true ? Effect.sync(() => native.close()) : Effect.void)),
          )
        }),
        (owner) => owner.close.pipe(Effect.orDie),
      )
      // Retained validation is read only; an empty or incompatible file never receives a creation permit.
      yield* SourceIdentity.read(source.handle)
      return source
    }),
  })
