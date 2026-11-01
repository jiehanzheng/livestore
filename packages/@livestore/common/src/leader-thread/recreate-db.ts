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
import * as SourceIdentity from '../SourceIdentity.ts'
import * as StateHead from '../StateHead.ts'
import * as StateSnapshot from '../StateSnapshot.ts'
import * as StateSqliteDb from '../StateSqliteDb.ts'
import { configureConnection, execSql } from './connection.ts'
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
  { schema, sourceIdentity }: { schema: LiveStoreSchema; sourceIdentity: SourceIdentity.SourceIdentity },
): Effect.Effect<void, SqliteError> =>
  Effect.try({
    try: () =>
      StateSnapshot.writeProvenance(db, {
        proofVersion: StateSnapshot.PROOF_VERSION,
        ownerId: nanoid(),
        transitionId: nanoid(),
        sourceIncarnation: sourceIdentity.incarnation,
        projection: StateSnapshot.getProjectionIdentity(schema),
      }),
    catch: (cause) => new SqliteError({ cause }),
  })

export const recreateDb = ({
  schema,
  bootStatusQueue,
  materializeEvent,
  stateRebuildBatchSize = STATE_REBUILD_BATCH_SIZE_DEFAULT,
}: {
  schema: LiveStoreSchema
  bootStatusQueue: Queue.Queue<BootStatus>
  materializeEvent: MaterializeEvent
  stateRebuildBatchSize?: number
}): Effect.Effect<
  { migrationsReport: MigrationsReport },
  UnknownError | MaterializeError | MaterializationJournal.MaterializationJournalError | SqliteError,
  EventlogSqliteDb.EventlogSqliteDb | StateSqliteDb.StateSqliteDb
> =>
  Effect.gen(function* () {
    const dbState = yield* StateSqliteDb.StateSqliteDb
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
      EventSequenceNumber.Client.Composite.make({ global: Eventlog.getBackendHeadFromDb(dbEventlog), client: 0 }),
    )

    // @effect-diagnostics-next-line anyUnknownInErrorContext:off -- user hook errors are immediately normalized to LiveStore UnknownError
    yield* Effect.trySyncOrPromiseOrEffect(() => hooks?.post?.(dbState)).pipe(UnknownError.mapToUnknownError)

    // Keep this out of finalizers, which also run on failure and interruption.
    yield* markStateAsCompleted(dbState, {
      schema,
      sourceIdentity: SourceIdentity.read(yield* EventlogSqliteDb.EventlogSqliteDb),
    })

    return { migrationsReport }
  }).pipe(
    Effect.scoped, // NOTE we're closing the scope here so finalizers are called when the effect is done
    Effect.withSpan('@livestore/common:leader-thread:recreateDb'),
    Effect.withPerformanceMeasure('@livestore/common:leader-thread:recreateDb'),
  )
