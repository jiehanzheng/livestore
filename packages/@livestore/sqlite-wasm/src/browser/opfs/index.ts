import { UnknownError } from '@livestore/common'
import { Effect, Exit, Semaphore, Scope } from '@livestore/utils/effect'
import { Opfs } from '@livestore/utils/effect/browser'
import type { SQLiteAPI } from '@livestore/wa-sqlite'
import { SQLITE_OPEN_READWRITE } from '@livestore/wa-sqlite/src/sqlite-constants.js'

import { AccessHandlePoolVFS } from './AccessHandlePoolVFS.ts'
import {
  consumeOpfsSourceInventory,
  creationFromOpfsAssociation,
  type OpfsSourceCreation,
  type OpfsSourceInventory,
} from './source-allocation.ts'

type OpenOpfsDb = (input: {
  directory: string
  fileName: string
  sourceInventory?: OpfsSourceInventory
  sourceOpenMode?: 'retained-maintenance'
}) => Effect.Effect<
  { dbPointer: number; vfs: AccessHandlePoolVFS; sourceCreation?: OpfsSourceCreation },
  never,
  Opfs.Opfs
>

export const makeOpfsRegistry = ({
  sqlite3,
  scope,
  isOpen,
  onUncertainOpen,
}: {
  sqlite3: SQLiteAPI
  scope: Scope.Closeable
  isOpen: () => boolean
  onUncertainOpen: (cause: unknown) => void
}): OpenOpfsDb => {
  const semaphore = Semaphore.make(1).pipe(Effect.runSync)
  const pools = new Map<string, AccessHandlePoolVFS>()
  const maintenanceModes = new Map<string, boolean>()
  let service: Effect.Success<typeof Opfs.Opfs> | undefined
  let registration = 0
  return ({ directory, fileName, sourceInventory, sourceOpenMode }) =>
    Effect.gen(function* () {
      if (isOpen() === false) return yield* Effect.interrupt
      // Inventory/authority must be checked before the pool can repair malformed metadata.
      const inventory =
        sourceInventory === undefined ? undefined : consumeOpfsSourceInventory(sourceInventory, directory)
      if (inventory !== undefined && fileName !== 'eventlog.db')
        return yield* Effect.die(new UnknownError({ cause: 'Source inventory cannot authorize another SQLite file' }))
      if (sourceOpenMode === 'retained-maintenance' && (inventory === undefined || inventory.sourceWasAbsent === true))
        return yield* Effect.die(
          new Error('Retained OPFS maintenance requires existing-source inventory under its namespace lease'),
        )
      const native = yield* Opfs.Opfs
      if (service !== undefined && service !== native) {
        return yield* Effect.die(new UnknownError({ cause: 'A physical SQLite owner cannot mix OPFS services' }))
      }
      service = native
      let vfs = pools.get(directory)
      if (vfs !== undefined && maintenanceModes.get(directory) !== (sourceOpenMode === 'retained-maintenance'))
        return yield* Effect.die(new Error('An OPFS factory cannot mix maintenance and ordinary pool startup'))
      if (vfs === undefined) {
        // Exact directory keys preserve identity; owner-local names cannot alias sanitized paths.
        const name = `opfs-${registration++}`
        vfs = yield* AccessHandlePoolVFS.create(
          name,
          directory,
          (sqlite3 as any).module,
          sourceOpenMode === 'retained-maintenance',
        ).pipe(Scope.provide(scope))
        if (isOpen() === false) return yield* Effect.interrupt
        sqlite3.vfs_register(vfs, false)
        pools.set(directory, vfs)
        maintenanceModes.set(directory, sourceOpenMode === 'retained-maintenance')
      }
      if (isOpen() === false) return yield* Effect.interrupt
      const pool = vfs
      return yield* Effect.sync(() => {
        const dbPointer = sqlite3.open_v2Sync(
          fileName,
          sourceOpenMode === 'retained-maintenance' ? SQLITE_OPEN_READWRITE : undefined,
          pool.name,
        )
        const association = pool.takeCreatedSourceAssociation(fileName)
        const sourceCreation = inventory === undefined ? undefined : creationFromOpfsAssociation(inventory, association)
        return { dbPointer, vfs: pool, ...(sourceCreation === undefined ? {} : { sourceCreation }) }
      }).pipe(
        Effect.onExit((exit) =>
          Effect.sync(() => {
            // Native open may hide its pointer, including a failure before allocation metadata can be returned.
            if (Exit.isFailure(exit) === true) onUncertainOpen(exit.cause)
          }),
        ),
      )
    }).pipe(semaphore.withPermits(1))
}
