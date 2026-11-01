import type { Schema } from '@livestore/utils/effect'
import { Context, Effect, Option, Semaphore } from '@livestore/utils/effect'
import { nanoid } from '@livestore/utils/nanoid'

import { MaterializeError, ProjectionMismatchError, SqliteError, type SqliteDb } from '../adapter-types.ts'
import * as EventlogSqliteDb from '../EventlogSqliteDb.ts'
import * as MaterializationJournal from '../MaterializationJournal.ts'
import { EventSequenceNumber, LiveStoreEvent, SystemTables } from '../schema/mod.ts'
import type { LiveStoreSchema } from '../schema/mod.ts'
import * as SourceIdentity from '../SourceIdentity.ts'
import * as StateHead from '../StateHead.ts'
import * as StateSnapshot from '../StateSnapshot.ts'
import * as StateSqliteDb from '../StateSqliteDb.ts'
import { prepareBindValues } from '../util.ts'
import * as Eventlog from './eventlog.ts'
import type { MaterializeEvent } from './types.ts'

export const TypeId = '~@livestore/common/LeaderPersistence' as const
export type TypeId = typeof TypeId

export interface LocalPersistPlan {
  readonly events: ReadonlyArray<LiveStoreEvent.Client.Encoded>
}

export interface PulledEvent {
  readonly event: LiveStoreEvent.Client.Encoded
  readonly syncMetadata: Option.Option<Schema.Json>
}

export interface UpstreamPersistPlan {
  /** The events received in the backend chunk, including metadata used to confirm pending events. */
  readonly pulledEvents: ReadonlyArray<PulledEvent>
  /** The merged events to materialize, including any locally rebased pending suffix. */
  readonly events: ReadonlyArray<LiveStoreEvent.Client.Encoded>
  readonly rollbackEvents: ReadonlyArray<LiveStoreEvent.Client.Encoded>
  readonly confirmedEvents: ReadonlyArray<LiveStoreEvent.Client.Encoded>
  readonly backendHead: EventSequenceNumber.Client.Composite
}

export interface LocalPersistReceipt {
  readonly _tag: 'local-persist'
  readonly persistedEvents: ReadonlyArray<LiveStoreEvent.Client.Encoded>
  readonly materializerHashes: ReadonlyArray<LiveStoreEvent.Client.MaterializerHash>
  readonly stateHead: EventSequenceNumber.Client.Composite
}

export interface UpstreamPersistReceipt {
  readonly _tag: 'upstream-persist'
  readonly persistedEvents: ReadonlyArray<LiveStoreEvent.Client.Encoded>
  readonly materializerHashes: ReadonlyArray<LiveStoreEvent.Client.MaterializerHash>
  readonly rolledBackEventNums: ReadonlyArray<EventSequenceNumber.Client.Composite>
  readonly stateHead: EventSequenceNumber.Client.Composite
  readonly backendHead: EventSequenceNumber.Client.Composite
}

export type PersistError = MaterializeError | MaterializationJournal.MaterializationJournalError

export interface Service {
  readonly [TypeId]: TypeId
  /** Snapshots wait for the persistence owner and cannot export an incomplete transition. */
  readonly exportSnapshot: Effect.Effect<Uint8Array<ArrayBuffer>>
  readonly admitSnapshot: (
    request: StateSnapshot.AdmissionRequest,
  ) => Effect.Effect<StateSnapshot.Admission, ProjectionMismatchError>
  readonly resetSource: Effect.Effect<void, MaterializeError>
  readonly persistLocal: (plan: LocalPersistPlan) => Effect.Effect<LocalPersistReceipt, PersistError>
  readonly persistUpstream: (plan: UpstreamPersistPlan) => Effect.Effect<UpstreamPersistReceipt, PersistError>
}

/**
 * Durable SQLite boundary for leader-sync transitions: rollback, materialization, journal maintenance, eventlog writes
 * and head updates. Queues, retries, publication and acknowledgements stay in `LeaderSyncProcessor`, which publishes
 * only what a successful receipt reports.
 */
export class LeaderPersistence extends Context.Service<LeaderPersistence, Service>()(
  '@livestore/common/LeaderPersistence',
) {}

export const make = ({ materializeEvent, schema }: { materializeEvent: MaterializeEvent; schema: LiveStoreSchema }) =>
  Effect.gen(function* () {
    const dbState = yield* StateSqliteDb.StateSqliteDb
    const dbEventlog = yield* EventlogSqliteDb.EventlogSqliteDb
    if (dbState.transactionHost !== dbEventlog.transactionHost) {
      return yield* Effect.die('SOURCE and STATE must share the same physical transaction host')
    }
    const materializationJournal = yield* MaterializationJournal.MaterializationJournal
    const stateHead = yield* StateHead.StateHead
    const sourceIdentity = SourceIdentity.read(dbEventlog)
    const projection = StateSnapshot.getProjectionIdentity(schema)
    const prior = StateSnapshot.readProvenance(dbState)
    if (
      prior === undefined ||
      prior.sourceIncarnation !== sourceIdentity.incarnation ||
      StateSnapshot.isSameProjection(prior.projection, projection) === false ||
      EventSequenceNumber.Client.isEqual(StateHead.readFromDb(dbState), Eventlog.getClientHeadFromDb(dbEventlog)) ===
        false
    ) {
      return yield* Effect.die('Leader persistence requires a completed source-bound projection')
    }
    const fence: PersistenceFence = {
      failed: false,
      proofVersion: StateSnapshot.PROOF_VERSION,
      ownerId: nanoid(),
      transitionId: nanoid(),
      sourceIncarnation: sourceIdentity.incarnation,
      projection,
    }
    // A new owner cannot inherit another process's admission/catch-up identity.
    yield* Effect.sync(() => StateSnapshot.writeProvenance(dbState, fence))
    const semaphore = yield* Semaphore.make(1)

    const materializeEvents = (
      events: ReadonlyArray<LiveStoreEvent.Client.Encoded>,
      pulledEvents: ReadonlyArray<PulledEvent> = [],
    ) =>
      Effect.forEach(events, (event) =>
        Effect.gen(function* () {
          const syncMetadata =
            pulledEvents.find(({ event: pulledEvent }) =>
              EventSequenceNumber.Client.isEqual(event.seqNum, pulledEvent.seqNum),
            )?.syncMetadata ?? Option.none()
          const { hash } = yield* materializeEvent(event, { syncMetadata })
          return LiveStoreEvent.Client.MaterializerHash.make({ eventNum: event.seqNum, hash })
        }),
      )

    const persistLocal: Service['persistLocal'] = ({ events }) =>
      withCoordinatedTransactions(
        { dbState, dbEventlog, fence },
        Effect.gen(function* () {
          const materializerHashes = yield* materializeEvents(events)
          const persistedStateHead = yield* stateHead.get.pipe(
            Effect.mapError((cause) => MaterializeError.make({ cause })),
          )

          return {
            _tag: 'local-persist' as const,
            persistedEvents: events,
            materializerHashes,
            stateHead: persistedStateHead,
          }
        }),
      ).pipe(
        semaphore.withPermits(1),
        Effect.withSpan('@livestore/common:LeaderPersistence:persistLocal', {
          attributes: { batchSize: events.length },
        }),
      )

    const persistUpstream: Service['persistUpstream'] = (plan) =>
      withCoordinatedTransactions(
        { dbState, dbEventlog, fence },
        Effect.gen(function* () {
          const rollbackEventNums = plan.rollbackEvents.map((event) => event.seqNum)

          if (rollbackEventNums.length > 0) {
            // A rebase first restores the old materialized state, then removes the events that no longer belong
            // in the eventlog. The replacement events can then be applied from the restored head.
            const headAfterRollback = plan.rollbackEvents[0]!.parentSeqNum
            yield* materializationJournal.rollback(rollbackEventNums)
            yield* stateHead.set(headAfterRollback).pipe(Effect.mapError((cause) => MaterializeError.make({ cause })))
            yield* Eventlog.deleteEvents(dbEventlog, rollbackEventNums).pipe(
              Effect.mapError((cause) => MaterializeError.make({ cause })),
            )
          }

          const materializerHashes = yield* materializeEvents(plan.events, plan.pulledEvents)

          if (plan.confirmedEvents.length > 0) {
            // Confirmed local events are already materialized. We only add the metadata learned from the backend.
            const confirmedPulledEvents = plan.pulledEvents.filter(({ event }) =>
              plan.confirmedEvents.some((confirmedEvent) =>
                isSameSequencePosition(event.seqNum, confirmedEvent.seqNum),
              ),
            )
            yield* Eventlog.updateSyncMetadataForDb(dbEventlog, confirmedPulledEvents).pipe(
              Effect.mapError((cause) => MaterializeError.make({ cause })),
            )
          }

          // Once the backend has reached this head, journal entries before it are no longer needed for a future rebase.
          yield* materializationJournal.discardUpTo(plan.backendHead)

          // The backend head and the corresponding event inserts share this eventlog transaction.
          yield* updateBackendHead(dbEventlog, plan.backendHead)

          const persistedStateHead = yield* stateHead.get.pipe(
            Effect.mapError((cause) => MaterializeError.make({ cause })),
          )

          return {
            _tag: 'upstream-persist' as const,
            persistedEvents: plan.events,
            materializerHashes,
            rolledBackEventNums: rollbackEventNums,
            stateHead: persistedStateHead,
            backendHead: plan.backendHead,
          }
        }),
      ).pipe(
        semaphore.withPermits(1),
        Effect.withSpan('@livestore/common:LeaderPersistence:persistUpstream', {
          attributes: {
            batchSize: plan.events.length,
            rollbackCount: plan.rollbackEvents.length,
            confirmedCount: plan.confirmedEvents.length,
          },
        }),
      )

    const assertCompleted = () => {
      if (
        fence.failed === true ||
        StateSnapshot.isEqual(StateSnapshot.readProvenance(dbState), fence) === false ||
        SourceIdentity.read(dbEventlog).incarnation !== fence.sourceIncarnation ||
        EventSequenceNumber.Client.isEqual(StateHead.readFromDb(dbState), Eventlog.getClientHeadFromDb(dbEventlog)) ===
          false
      ) {
        throw new Error('Cannot export inconsistent leader state; reopen from the eventlog')
      }
    }
    const exportSnapshot = Effect.sync(() => {
      assertCompleted()
      return dbState.export()
    }).pipe(semaphore.withPermits(1))
    const admitSnapshot: Service['admitSnapshot'] = ({ expectedProjection, candidate }) =>
      Effect.gen(function* () {
        if (StateSnapshot.isSameProjection(expectedProjection, projection) === false) {
          return yield* ProjectionMismatchError.make({ expected: expectedProjection, actual: projection })
        }
        return yield* Effect.sync(() => {
          assertCompleted()
          const { failed: _failed, ...provenance } = fence
          return StateSnapshot.isEqual(candidate, provenance) === true
            ? { _tag: 'Accepted' as const, provenance }
            : { _tag: 'StaleSnapshot' as const, provenance, snapshot: dbState.export() }
        })
      }).pipe(semaphore.withPermits(1))

    const resetSource = Effect.gen(function* () {
      fence.failed = true
      // Invalidate this image before the source transaction; alternate caches mismatch the rotated incarnation.
      yield* executeStatement(dbState, `DELETE FROM ${SystemTables.REBUILD_META_TABLE}`)
      const reset = Effect.gen(function* () {
        yield* executeStatement(dbEventlog, `DELETE FROM ${SystemTables.EVENTLOG_META_TABLE}`)
        yield* executeStatement(dbEventlog, `DELETE FROM ${SystemTables.SYNC_STATUS_TABLE}`)
        yield* executeStatement(dbEventlog, `INSERT INTO ${SystemTables.SYNC_STATUS_TABLE} (head) VALUES (0)`)
        yield* Effect.sync(() => SourceIdentity.rotateWithinTransaction(dbEventlog))
      })
      if (dbEventlog.transactionHost !== undefined) {
        yield* dbEventlog.transactionHost
          .runTransaction(reset)
          .pipe(
            Effect.mapError((error) =>
              error instanceof SqliteError ? MaterializeError.make({ cause: error }) : error,
            ),
          )
      } else {
        yield* Effect.acquireUseRelease(
          executeStatement(dbEventlog, 'BEGIN IMMEDIATE'),
          () => reset.pipe(Effect.tap(() => executeStatement(dbEventlog, 'COMMIT'))),
          (_, exit) => (exit._tag === 'Failure' ? executeStatement(dbEventlog, 'ROLLBACK') : Effect.void),
        )
      }
      const tables = dbState.select<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
      )
      for (const { name } of tables) yield* executeStatement(dbState, `DROP TABLE "${name.replaceAll('"', '""')}"`)
    }).pipe(semaphore.withPermits(1))

    return LeaderPersistence.of({
      [TypeId]: TypeId,
      persistLocal,
      persistUpstream,
      exportSnapshot,
      admitSnapshot,
      resetSource,
    })
  })

/**
 * Parent linkage identifies a position in the event chain. Rebase generation describes the version of optimistic
 * history, which the backend does not preserve, so it is not part of position identity.
 */
export const isSameSequencePosition = (
  left: EventSequenceNumber.Client.Composite,
  right: EventSequenceNumber.Client.Composite,
) => left.global === right.global && left.client === right.client

type PersistenceFence = {
  failed: boolean
  proofVersion: typeof StateSnapshot.PROOF_VERSION
  ownerId: string
  transitionId: string
  sourceIncarnation: string
  projection: StateSnapshot.ProjectionIdentity
}

const withCoordinatedTransactions = <A, E, R>(
  { dbState, dbEventlog, fence }: { dbState: SqliteDb; dbEventlog: SqliteDb; fence: PersistenceFence },
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | MaterializeError, R> => {
  const host = dbEventlog.transactionHost
  const sameHost = host === dbState.transactionHost
  // These flags let cleanup roll back whichever transaction was actually opened or left behind by a failed commit.
  let stateTransactionOpen = false
  let eventlogTransactionOpen = false

  const rollbackOpenTransactions = Effect.gen(function* () {
    if (eventlogTransactionOpen === true) {
      yield* executeStatement(dbEventlog, 'ROLLBACK').pipe(Effect.ignore)
      eventlogTransactionOpen = false
    }
    if (stateTransactionOpen === true) {
      yield* executeStatement(dbState, 'ROLLBACK').pipe(Effect.ignore)
      stateTransactionOpen = false
    }
  })

  const transaction = Effect.gen(function* () {
    if (sameHost === false || fence.failed === true) {
      return yield* MaterializeError.make({
        cause: new SqliteError({ cause: 'Leader persistence is fenced until reopen' }),
      })
    }

    // This autocommit is a write-ahead fence, not part of either transaction. A crash anywhere between
    // invalidation and completion must rebuild derived state from the retained authoritative eventlog.
    // Heads/counts cannot detect same-position rebases or confirmation-only journal changes.
    yield* executeStatement(dbState, `DELETE FROM ${SystemTables.REBUILD_META_TABLE}`)

    yield* executeStatement(dbState, 'BEGIN TRANSACTION')
    stateTransactionOpen = true
    if (host === undefined) {
      yield* executeStatement(dbEventlog, 'BEGIN TRANSACTION')
      eventlogTransactionOpen = true
    }

    const result = yield* effect

    // Independent database commits are not crash-atomic. Keep the durable fence absent until both succeed.
    yield* executeStatement(dbState, 'COMMIT')
    stateTransactionOpen = false
    if (host === undefined) {
      yield* executeStatement(dbEventlog, 'COMMIT')
      eventlogTransactionOpen = false
    }

    const transitionId = nanoid()
    yield* Effect.try({
      try: () => StateSnapshot.writeProvenance(dbState, { ...fence, transitionId }),
      catch: (cause) => MaterializeError.make({ cause: new SqliteError({ cause }) }),
    })
    return { result, transitionId }
  }).pipe(Effect.ensuring(rollbackOpenTransactions))
  return (host === undefined ? transaction : host.runTransaction(transaction)).pipe(
    Effect.mapError((error) => (error instanceof SqliteError ? MaterializeError.make({ cause: error }) : error)),
    Effect.map(({ result, transitionId }) => {
      // A host commit can fail after WASM COMMIT; publish memory only after the host confirms durability.
      fence.transitionId = transitionId
      return result
    }),
    // Even cleanup can have an ambiguous outcome. Never reuse this owner after a failed transition.
    Effect.onExit((exit) =>
      Effect.sync(() => {
        if (exit._tag === 'Failure') fence.failed = true
      }),
    ),
    // Do not allow cancellation between the two commits and the cleanup that follows a failure.
    Effect.uninterruptible,
  )
}

const executeStatement = (db: SqliteDb, statement: string) =>
  Effect.try({
    try: () => db.execute(statement),
    catch: (cause) =>
      MaterializeError.make({
        cause: new SqliteError({ cause, query: { sql: statement, bindValues: [] } }),
        note: `Leader sync transaction failed during ${statement}`,
      }),
  })

const updateBackendHead = (dbEventlog: SqliteDb, head: EventSequenceNumber.Client.Composite) =>
  Effect.try({
    try: () => Eventlog.updateBackendHead(dbEventlog, head),
    catch: (cause) =>
      MaterializeError.make({
        cause: new SqliteError({ cause }),
        note: 'Failed to persist the leader sync backend head',
      }),
  })
