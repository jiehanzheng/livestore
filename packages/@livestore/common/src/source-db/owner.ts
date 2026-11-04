import { Context, Effect, Layer } from '@livestore/utils/effect'

import { EventSequenceNumber } from '../schema/mod.ts'
import type { PersistenceInfo, SqliteDb, SqliteDebugInfo, SqliteTransactionHost } from '../sqlite-types.ts'
import { sourceDriverFromSync } from './bridge.ts'
import { bindFreshSource, type FreshSource, type OwnedCreationBoundary } from './freshness.ts'
import { makeSourceDb, type SourceDb, type SourceDbError, type SourceHandle, type SourceTransaction } from './role.ts'

export type SourcePersistence =
  | { readonly kind: 'independent'; readonly database: SourceDb }
  | { readonly kind: 'native-shared-host'; readonly host: SqliteTransactionHost }

export interface SourceImage {
  readonly export: Effect.Effect<Uint8Array, SourceDbError>
  /** Replacement invalidates initialization and active projection proofs; STATE needs a newly admitted owner. */
  import(bytes: Uint8Array): Effect.Effect<void, SourceDbError>
}

/** One semantic SOURCE owner, with physical transaction behavior represented explicitly. */
export interface SourceOwner {
  readonly handle: SourceHandle
  readonly persistence: SourcePersistence
  readonly fresh: FreshSource | undefined
  readonly image: SourceImage | undefined
  readonly storageName: string
  readonly persistenceInfo: PersistenceInfo | undefined
  readonly debug: SqliteDebugInfo
  readonly close: Effect.Effect<void, SourceDbError>
  /** Native-host calls inside a frame stage work; only the outer persistence boundary yields a durable receipt. */
  write<A, E, R>(
    use: (transaction: SourceTransaction) => Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | SourceDbError, R>
}

export class SourceContext extends Context.Service<SourceContext, SourceOwner>()('@livestore/common/SourceContext') {}
export const layer = (owner: SourceOwner) => Layer.succeed(SourceContext, owner)

export const fromSourceDb = (
  database: SourceDb,
  options: { fresh?: FreshSource; storageName: string; persistenceInfo?: PersistenceInfo; debug?: SqliteDebugInfo },
): SourceOwner => ({
  handle: database,
  persistence: { kind: 'independent', database },
  fresh: options.fresh,
  image: { export: database.export, import: database.import },
  storageName: options.storageName,
  persistenceInfo: options.persistenceInfo,
  debug: options.debug ?? { head: EventSequenceNumber.Client.ROOT },
  close: database.close,
  write: database.transaction,
})

/** Native synchronous SOURCE is lifted at its driver boundary; STATE retains its original synchronous object. */
export const fromSyncSource = (
  database: SqliteDb,
  creation?: OwnedCreationBoundary,
  isHeld?: () => boolean,
): Effect.Effect<SourceOwner> =>
  Effect.gen(function* () {
    if (database.transactionHost !== undefined)
      return yield* Effect.die(new Error('Shared native SOURCE requires its physical host adapter'))
    const source = yield* makeSourceDb(sourceDriverFromSync(database, isHeld ?? creation?.isHeld))
    return fromSourceDb(source, {
      storageName: creation?.storageName ?? database.metadata.persistenceInfo.fileName,
      persistenceInfo: database.metadata.persistenceInfo,
      debug: database.debug,
      ...(creation === undefined ? {} : { fresh: bindFreshSource(source, creation) }),
    })
  })
