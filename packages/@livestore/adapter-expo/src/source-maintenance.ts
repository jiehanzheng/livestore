import { Directory, File } from 'expo-file-system'

import { liveStoreStorageFormatVersion } from '@livestore/common'
import { fromSyncSource, SourceIdentity } from '@livestore/common/source-db'
import {
  SourceMaintenanceError,
  type ApplicationBinding,
  type SourceMaintenanceLocationOwner,
} from '@livestore/common/source-maintenance'
import { retainedSourceMaintenanceOpener } from '@livestore/common/source-maintenance/internal'
import { Effect, Exit } from '@livestore/utils/effect'

import { createSqliteFactory } from './sqlite.ts'

/** Expo has no no-CREATE native open: the real same-realm location owner must exclude cooperating unlink/create actors. */
export const makeExpoSourceMaintenanceOpener = ({
  binding,
  locationOwner,
  directory,
}: {
  readonly binding: ApplicationBinding
  readonly locationOwner: SourceMaintenanceLocationOwner
  /** Exact existing SOURCE namespace, supplied by the application's location owner. */
  readonly directory: string
}) =>
  retainedSourceMaintenanceOpener({
    binding,
    locationOwner,
    acquire: Effect.gen(function* () {
      const databaseName = `livestore-eventlog@${liveStoreStorageFormatVersion}.db`
      yield* Effect.try({
        try: () => {
          if (
            (directory.startsWith('/') === false && directory.startsWith('file:///') === false) ||
            /[\\\0?#]/.test(directory) === true ||
            directory.split('/').some((part) => part === '.' || part === '..') === true
          )
            throw new Error('Retained native SOURCE requires an exact absolute directory')
          const parent = new Directory(directory)
          const entries = parent.list()
          const currentFamily = new Set([
            databaseName,
            ...['wal', 'shm', 'journal'].map((suffix) => `${databaseName}-${suffix}`),
          ])
          if (
            entries.some(
              (entry) => entry.name.startsWith('livestore-eventlog@') && currentFamily.has(entry.name) === false,
            ) === true
          )
            throw new Error('Retained native SOURCE contains an unsupported eventlog family')
          const candidates = entries.filter((entry) => entry.name === databaseName)
          if (
            candidates.length !== 1 ||
            !(candidates[0] instanceof File) ||
            candidates[0] instanceof Directory ||
            candidates[0].uri !== new File(parent, databaseName).uri
          )
            throw new Error('Retained native SOURCE is missing or is not one exact current-format file')
        },
        catch: (cause) => new SourceMaintenanceError('expo-retained-inventory', cause),
      })
      const factory = createSqliteFactory()
      // LIFO: the canonical SOURCE close must finish before this ledger attests all native resources closed.
      yield* Effect.addFinalizer(() => Effect.sync(factory.assertClosed))
      const owner = yield* Effect.acquireRelease(
        Effect.gen(function* () {
          const native = yield* factory.makeSqliteDb({
            _tag: 'file',
            directory,
            databaseName,
            sourceOwner: 'exclusive',
          })
          return yield* Effect.gen(function* () {
            const lease = native.metadata.sourceLease
            if (lease === undefined)
              return yield* Effect.fail(
                new SourceMaintenanceError('expo-source-lease', 'Native SOURCE exclusive ownership unavailable'),
              )
            return yield* fromSyncSource(native, undefined, lease.isHeld)
          }).pipe(
            Effect.onExit((exit) => (Exit.isFailure(exit) === true ? Effect.sync(() => native.close()) : Effect.void)),
          )
        }).pipe(Effect.mapError((cause) => new SourceMaintenanceError('expo-retained-open', cause))),
        (source) => source.close.pipe(Effect.orDie),
      )
      yield* SourceIdentity.read(owner.handle)
      return owner
    }),
  })
