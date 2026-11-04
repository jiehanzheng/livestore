import { fromSyncSource, SourceIdentity } from '@livestore/common/source-db'
import {
  SourceMaintenanceError,
  type ApplicationBinding,
  type SourceMaintenanceLocationOwner,
} from '@livestore/common/source-maintenance'
import { retainedSourceMaintenanceOpener } from '@livestore/common/source-maintenance/internal'
import { Effect, Exit } from '@livestore/utils/effect'
import { Opfs } from '@livestore/utils/effect/browser'
import type { SQLiteAPI } from '@livestore/wa-sqlite'

import { sqliteDbFactory } from '../mod.ts'
import { readOpfsSourceInventory } from './inventory.ts'
import { acquireOpfsSourceNamespace, certifyOpfsSourceInventory } from './source-allocation.ts'

/** Caller supplies the real ordinary provider and fresh API; those resources do not authenticate application authority. */
export const makeOpfsSourceMaintenanceOpener = ({
  binding,
  locationOwner,
  directory,
  makeSqliteApi,
  opfs,
  locks,
}: {
  readonly binding: ApplicationBinding
  readonly locationOwner: SourceMaintenanceLocationOwner
  readonly directory: string
  /** Each attempt needs a fresh ordinary API because closed native VFS registrations remain registered. */
  readonly makeSqliteApi: Effect.Effect<SQLiteAPI, SourceMaintenanceError>
  readonly opfs: Effect.Success<typeof Opfs.Opfs>
  readonly locks: LockManager
}) =>
  retainedSourceMaintenanceOpener({
    binding,
    locationOwner,
    acquire: Effect.gen(function* () {
      if (
        directory
          .split('/')
          .every((part) => part.length > 0 && part !== '.' && part !== '..' && /[\\\0?#]/.test(part) === false) ===
        false
      )
        return yield* Effect.fail(
          new SourceMaintenanceError('opfs-location', 'An exact canonical root-relative namespace is required'),
        )
      const sqlite3 = yield* makeSqliteApi
      const make = yield* sqliteDbFactory({ sqlite3 })
      const namespace = yield* acquireOpfsSourceNamespace({ locks, directory, closePhysicalOwner: make.close })
      const handle = yield* Opfs.getDirectoryHandleByPath(directory, { create: false })
      const inventory = yield* readOpfsSourceInventory(handle)
      const associated = inventory.filenames.filter((name) => name !== '')
      if (
        associated.filter((name) => name === '/eventlog.db').length !== 1 ||
        new Set(associated).size !== associated.length
      )
        return yield* Effect.fail(
          new SourceMaintenanceError(
            'opfs-inventory',
            'Retained pool requires one authoritative SOURCE and unique associations',
          ),
        )
      const sourceInventory = certifyOpfsSourceInventory(namespace, directory, false)
      const source = yield* Effect.acquireRelease(
        Effect.gen(function* () {
          const native = yield* make({
            _tag: 'opfs',
            opfsDirectory: directory,
            fileName: 'eventlog.db',
            sourceInventory,
            sourceOpenMode: 'retained-maintenance',
          })
          return yield* fromSyncSource(native, undefined, namespace.isHeld).pipe(
            Effect.onExit((exit) => (Exit.isFailure(exit) === true ? Effect.sync(() => native.close()) : Effect.void)),
          )
        }),
        (owner) => owner.close.pipe(Effect.orDie),
      )
      yield* SourceIdentity.read(source.handle)
      return source
    }).pipe(
      Effect.provideService(Opfs.Opfs, opfs),
      Effect.mapError((cause) => new SourceMaintenanceError('opfs-retained-open', cause)),
    ),
  })
