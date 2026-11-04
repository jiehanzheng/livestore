import { Effect, Queue } from '@livestore/utils/effect'
import { nanoid } from '@livestore/utils/nanoid'

import type { MigrationsReport } from '../defs.ts'
import * as EventlogSqliteDb from '../EventlogSqliteDb.ts'
import {
  type BootStatus,
  type MaterializeError,
  migrateDb,
  rematerializeFromEventlog,
  type SqliteDb,
  SqliteError,
  UnknownError,
} from '../index.ts'
import * as MaterializationJournal from '../MaterializationJournal.ts'
import type { LiveStoreSchema } from '../schema/mod.ts'
import { EventSequenceNumber, SystemTables } from '../schema/mod.ts'
import { sourceLifecycle } from '../source-db/lifecycle.ts'
import type { SourceDbError, SourceHandle } from '../source-db/role.ts'
import * as SourceIdentity from '../SourceIdentity.ts'
import * as StateHead from '../StateHead.ts'
import * as StateSnapshot from '../StateSnapshot.ts'
import * as StateSqliteDb from '../StateSqliteDb.ts'
import { prepareBindValues } from '../util.ts'
import { configureConnection } from './connection.ts'
import * as Eventlog from './eventlog.ts'
import type { MaterializeEvent } from './types.ts'
import { STATE_REBUILD_BATCH_SIZE_DEFAULT } from './types.ts'

export const hasCompletedState = (
  db: SqliteDb,
  {
    schema,
    sourceIdentity,
    sourceHead,
  }: {
    schema: LiveStoreSchema
    sourceIdentity: SourceIdentity.SourceIdentity
    sourceHead: EventSequenceNumber.Client.Composite
  },
): boolean => {
  try {
    const tableNames = new Set(db.select<{ name: string }>('SELECT name FROM sqlite_master').map((row) => row.name))
    if (SystemTables.stateSystemTables.every((table) => tableNames.has(table.sqliteDef.name)) === false) return false
    const provenance = StateSnapshot.readProvenance(db)
    return (
      provenance !== undefined &&
      provenance.sourceIncarnation === sourceIdentity.incarnation &&
      StateSnapshot.isSameProjection(provenance.projection, StateSnapshot.getProjectionIdentity(schema)) &&
      EventSequenceNumber.Client.isEqual(StateHead.readFromDb(db), sourceHead)
    )
  } catch {
    // Derived bytes are disposable: unreadable proof/head metadata requires replay from the validated source.
    return false
  }
}

/** Reconstruction publishes only a source-bound projection after every hook has completed. */
export const markStateAsCompleted = (
  db: SqliteDb,
  {
    schema,
    sourceIdentity,
    source,
    sourceEpoch,
  }: {
    schema: LiveStoreSchema
    sourceIdentity: SourceIdentity.SourceIdentity
    source: SourceHandle
    sourceEpoch: number
  },
): Effect.Effect<void, SqliteError> =>
  Effect.try({
    try: () => {
      const current = () => source[sourceLifecycle].phase === 'open' && source[sourceLifecycle].epoch === sourceEpoch
      const transitionId = nanoid()
      if (current() === false) throw new Error('SOURCE changed before rebuild completion')
      StateSnapshot.writeProvenance(db, {
        proofVersion: StateSnapshot.PROOF_VERSION,
        ownerId: nanoid(),
        transitionId,
        sourceIncarnation: sourceIdentity.incarnation,
        projection: StateSnapshot.getProjectionIdentity(schema),
      })
      if (current() === false) {
        const failure = new Error('SOURCE changed during rebuild completion')
        try {
          // A reentrant replacement cannot leave this attempted completion proof available to a later owner.
          const statement = `DELETE FROM ${SystemTables.REBUILD_META_TABLE} WHERE id = 1 AND transitionId = ?`
          db.execute(statement, prepareBindValues([transitionId], statement))
        } catch (cleanup) {
          throw new AggregateError([failure, cleanup], 'Rebuild SOURCE changed and attempted proof cleanup failed', {
            cause: cleanup,
          })
        }
        throw failure
      }
    },
    catch: (cause) => new SqliteError({ cause }),
  })

export const recreateDb = ({
  schema,
  initializedSource,
  bootStatusQueue,
  materializeEvent,
  stateRebuildBatchSize = STATE_REBUILD_BATCH_SIZE_DEFAULT,
}: {
  schema: LiveStoreSchema
  initializedSource: SourceIdentity.InitializedSource
  bootStatusQueue: Queue.Queue<BootStatus>
  materializeEvent: MaterializeEvent
  stateRebuildBatchSize?: number
}): Effect.Effect<
  { migrationsReport: MigrationsReport },
  UnknownError | MaterializeError | MaterializationJournal.MaterializationJournalError | SqliteError | SourceDbError,
  EventlogSqliteDb.EventlogSqliteDb | StateSqliteDb.StateSqliteDb
> =>
  Effect.gen(function* () {
    const dbState = yield* StateSqliteDb.StateSqliteDb
    const source = yield* EventlogSqliteDb.EventlogSqliteDb
    const sourceEpoch = source.handle[sourceLifecycle].epoch
    yield* SourceIdentity.assertInitialized(source.handle, initializedSource)
    const hooks = schema.state.sqlite.migrations.hooks

    yield* Effect.addFinalizer(
      Effect.fn('recreateDb:finalizer')(function* (ex) {
        if (ex._tag === 'Failure') dbState.destroy()
      }),
    )

    yield* configureConnection(dbState, { foreignKeys: true })

    // @effect-diagnostics-next-line anyUnknownInErrorContext:off -- user hook errors are immediately normalized to LiveStore UnknownError
    yield* Effect.trySyncOrPromiseOrEffect(() => hooks?.init?.(dbState)).pipe(UnknownError.mapToUnknownError)

    const migrationsReport = yield* migrateDb({
      db: dbState,
      schema,
      onProgress: ({ done, total }) => Queue.offer(bootStatusQueue, { stage: 'migrating', progress: { done, total } }),
    })

    // @effect-diagnostics-next-line anyUnknownInErrorContext:off -- user hook errors are immediately normalized to LiveStore UnknownError
    yield* Effect.trySyncOrPromiseOrEffect(() => hooks?.pre?.(dbState)).pipe(UnknownError.mapToUnknownError)

    yield* rematerializeFromEventlog({
      dbState,
      schema,
      materializeEvent,
      batchSize: stateRebuildBatchSize,
      onProgress: ({ done, total }) =>
        Queue.offer(bootStatusQueue, { stage: 'rehydrating', progress: { done, total } }),
    })

    // Replay includes confirmed source events, but only retained pending work needs rollback records.
    const dbEventlog = yield* EventlogSqliteDb.EventlogSqliteDb
    const journal = yield* MaterializationJournal.make
    yield* journal.discardUpTo(
      EventSequenceNumber.Client.Composite.make({
        global: yield* Eventlog.getBackendHeadFromDb(dbEventlog.handle),
        client: 0,
      }),
    )

    // @effect-diagnostics-next-line anyUnknownInErrorContext:off -- user hook errors are immediately normalized to LiveStore UnknownError
    yield* Effect.trySyncOrPromiseOrEffect(() => hooks?.post?.(dbState)).pipe(UnknownError.mapToUnknownError)

    // Keep this out of finalizers, which also run on failure and interruption.
    yield* markStateAsCompleted(dbState, {
      schema,
      source: source.handle,
      sourceEpoch,
      sourceIdentity: yield* SourceIdentity.assertInitialized(source.handle, initializedSource),
    })

    return { migrationsReport }
  }).pipe(
    Effect.scoped, // NOTE we're closing the scope here so finalizers are called when the effect is done
    Effect.withSpan('@livestore/common:leader-thread:recreateDb'),
    Effect.withPerformanceMeasure('@livestore/common:leader-thread:recreateDb'),
  )
