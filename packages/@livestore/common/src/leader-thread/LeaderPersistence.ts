import type { Schema } from '@livestore/utils/effect'
import { Context, Effect, Option, Semaphore } from '@livestore/utils/effect'
import { nanoid } from '@livestore/utils/nanoid'

import { MaterializeError, ProjectionMismatchError, SqliteError, type SqliteDb } from '../adapter-types.ts'
import * as MaterializationJournal from '../MaterializationJournal.ts'
import { EventSequenceNumber, LiveStoreEvent, SystemTables } from '../schema/mod.ts'
import type { LiveStoreSchema } from '../schema/mod.ts'
import * as SourceIdentity from '../source-db/identity.ts'
import { sourceLifecycle } from '../source-db/lifecycle.ts'
import { SourceContext, type SourceOwner } from '../source-db/owner.ts'
import { SourceDbError } from '../source-db/role.ts'
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
    const source = yield* SourceContext
    if (
      (source.persistence.kind === 'native-shared-host' && dbState.transactionHost !== source.persistence.host) ||
      (source.persistence.kind === 'independent' && dbState.transactionHost !== undefined)
    ) {
      return yield* Effect.die('SOURCE and STATE must share the same physical transaction host')
    }
    const materializationJournal = yield* MaterializationJournal.MaterializationJournal
    const stateHead = yield* StateHead.StateHead
    const sourceEpoch = source.handle[sourceLifecycle].epoch
    const sourceIdentity = yield* SourceIdentity.read(source.handle)
    const projection = StateSnapshot.getProjectionIdentity(schema)
    const prior = StateSnapshot.readProvenance(dbState)
    if (
      source.handle[sourceLifecycle].epoch !== sourceEpoch ||
      source.handle[sourceLifecycle].phase !== 'open' ||
      prior === undefined ||
      prior.sourceIncarnation !== sourceIdentity.incarnation ||
      StateSnapshot.isSameProjection(prior.projection, projection) === false ||
      EventSequenceNumber.Client.isEqual(
        StateHead.readFromDb(dbState),
        yield* Eventlog.getClientHeadFromDb(source.handle),
      ) === false
    ) {
      return yield* Effect.die('Leader persistence requires a completed source-bound projection')
    }
    const fence: PersistenceFence = {
      failed: false,
      sourceEpoch,
      proofVersion: StateSnapshot.PROOF_VERSION,
      ownerId: nanoid(),
      transitionId: nanoid(),
      sourceIncarnation: sourceIdentity.incarnation,
      projection,
    }
    // A new owner cannot inherit another process's admission/catch-up identity.
    yield* Effect.sync(() => StateSnapshot.writeProvenance(dbState, provenanceFor(fence)))
    const semaphore = yield* Semaphore.make(1)

    const outsideNativeFrame =
      (operation: string) =>
      <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        Effect.gen(function* () {
          if (
            source.persistence.kind === 'native-shared-host' &&
            (yield* source.persistence.host.inTransaction) === true
          ) {
            fence.failed = true
            // Reenter only to taint the borrowed frame: catching this refusal must not let its host commit.
            return yield* source.persistence.host
              .runTransaction(
                Effect.fail(
                  MaterializeError.make({
                    cause: new SqliteError({ cause: 'Leader persistence requires its own outer native host boundary' }),
                    note: operation,
                  }),
                ),
              )
              .pipe(
                Effect.mapError((cause) => (cause instanceof SqliteError ? MaterializeError.make({ cause }) : cause)),
              )
          }
          return yield* effect
        })

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
          const { hash } = yield* materializeEvent(event, { syncMetadata }).pipe(
            Effect.mapError((cause) =>
              cause instanceof SourceDbError ? MaterializeError.make({ cause: new SqliteError({ cause }) }) : cause,
            ),
          )
          return LiveStoreEvent.Client.MaterializerHash.make({ eventNum: event.seqNum, hash })
        }),
      )

    const persistLocal: Service['persistLocal'] = ({ events }) =>
      withCoordinatedTransactions(
        { dbState, source, fence },
        Effect.gen(function* () {
          const materializerHashes = yield* materializeEvents(events)
          const persistedStateHead = yield* stateHead.get.pipe(
            Effect.mapError((cause) =>
              MaterializeError.make({ cause: cause instanceof SourceDbError ? new SqliteError({ cause }) : cause }),
            ),
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
        outsideNativeFrame('persistLocal'),
        Effect.withSpan('@livestore/common:LeaderPersistence:persistLocal', {
          attributes: { batchSize: events.length },
        }),
      )

    const persistUpstream: Service['persistUpstream'] = (plan) =>
      withCoordinatedTransactions(
        { dbState, source, fence },
        Effect.gen(function* () {
          const rollbackEventNums = plan.rollbackEvents.map((event) => event.seqNum)

          if (rollbackEventNums.length > 0) {
            // A rebase first restores the old materialized state, then removes the events that no longer belong
            // in the eventlog. The replacement events can then be applied from the restored head.
            const headAfterRollback = plan.rollbackEvents[0]!.parentSeqNum
            yield* materializationJournal.rollback(rollbackEventNums)
            yield* stateHead
              .set(headAfterRollback)
              .pipe(
                Effect.mapError((cause) =>
                  MaterializeError.make({ cause: cause instanceof SourceDbError ? new SqliteError({ cause }) : cause }),
                ),
              )
            yield* Eventlog.deleteEvents(yield* SourceContext, rollbackEventNums).pipe(
              Effect.mapError((cause) =>
                MaterializeError.make({ cause: cause instanceof SourceDbError ? new SqliteError({ cause }) : cause }),
              ),
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
            yield* Eventlog.updateSyncMetadataForDb(yield* SourceContext, confirmedPulledEvents).pipe(
              Effect.mapError((cause) =>
                MaterializeError.make({ cause: cause instanceof SourceDbError ? new SqliteError({ cause }) : cause }),
              ),
            )
          }

          // Once the backend has reached this head, journal entries before it are no longer needed for a future rebase.
          yield* materializationJournal.discardUpTo(plan.backendHead)

          // The backend head and the corresponding event inserts share this eventlog transaction.
          yield* Eventlog.updateBackendHead(yield* SourceContext, plan.backendHead).pipe(
            Effect.mapError((cause) =>
              MaterializeError.make({ cause: cause instanceof SourceDbError ? new SqliteError({ cause }) : cause }),
            ),
          )

          const persistedStateHead = yield* stateHead.get.pipe(
            Effect.mapError((cause) =>
              MaterializeError.make({ cause: cause instanceof SourceDbError ? new SqliteError({ cause }) : cause }),
            ),
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
        outsideNativeFrame('persistUpstream'),
        Effect.withSpan('@livestore/common:LeaderPersistence:persistUpstream', {
          attributes: {
            batchSize: plan.events.length,
            rollbackCount: plan.rollbackEvents.length,
            confirmedCount: plan.confirmedEvents.length,
          },
        }),
      )

    const assertCompleted = () =>
      Effect.gen(function* () {
        if (
          isSourceCurrent(source, fence) === false ||
          StateSnapshot.isEqual(StateSnapshot.readProvenance(dbState), fence) === false ||
          (yield* SourceIdentity.read(source.handle)).incarnation !== fence.sourceIncarnation ||
          EventSequenceNumber.Client.isEqual(
            StateHead.readFromDb(dbState),
            yield* Eventlog.getClientHeadFromDb(source.handle),
          ) === false
        ) {
          throw new Error('Cannot export inconsistent leader state; reopen from the eventlog')
        }
        if (isSourceCurrent(source, fence) === false) throw new Error('SOURCE changed during snapshot validation')
      })
    // Native bootstrap may stage snapshot bytes inside its host frame; the adapter releases that bundle only after commit.
    const exportSnapshot = Effect.gen(function* () {
      yield* assertCompleted().pipe(Effect.orDie)
      return dbState.export()
    }).pipe(semaphore.withPermits(1))
    const admitSnapshot: Service['admitSnapshot'] = ({ expectedProjection, candidate }) =>
      Effect.gen(function* () {
        if (StateSnapshot.isSameProjection(expectedProjection, projection) === false) {
          return yield* ProjectionMismatchError.make({ expected: expectedProjection, actual: projection })
        }
        yield* assertCompleted().pipe(Effect.orDie)
        return yield* Effect.sync(() => {
          const provenance = provenanceFor(fence)
          return StateSnapshot.isEqual(candidate, provenance) === true
            ? { _tag: 'Accepted' as const, provenance }
            : { _tag: 'StaleSnapshot' as const, provenance, snapshot: dbState.export() }
        })
      }).pipe(semaphore.withPermits(1))

    const reset = Effect.gen(function* () {
      fence.failed = true
      // Invalidate this image before the source transaction; alternate caches mismatch the rotated incarnation.
      yield* executeStatement(dbState, `DELETE FROM ${SystemTables.REBUILD_META_TABLE}`)
      yield* source
        .write((transaction) =>
          Effect.gen(function* () {
            yield* transaction.execute(`DELETE FROM ${SystemTables.EVENTLOG_META_TABLE}`)
            yield* transaction.execute(`DELETE FROM ${SystemTables.SYNC_STATUS_TABLE}`)
            yield* transaction.execute(`INSERT INTO ${SystemTables.SYNC_STATUS_TABLE} (head) VALUES (0)`)
            yield* SourceIdentity.rotate(transaction)
          }),
        )
        .pipe(
          Effect.mapError((cause) =>
            MaterializeError.make({ cause: cause instanceof SourceDbError ? new SqliteError({ cause }) : cause }),
          ),
        )
      const tables = dbState.select<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
      )
      for (const { name } of tables) yield* executeStatement(dbState, `DROP TABLE "${name.replaceAll('"', '""')}"`)
    })
    const resetSource = (
      source.persistence.kind === 'native-shared-host' ? source.persistence.host.runTransaction(reset) : reset
    ).pipe(
      Effect.mapError((cause) => (cause instanceof SqliteError ? MaterializeError.make({ cause }) : cause)),
      semaphore.withPermits(1),
      outsideNativeFrame('resetSource'),
    )

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
  // Epoch belongs to this live owner; persisted projections must survive a fresh owner with a new lifecycle.
  sourceEpoch: number
  proofVersion: typeof StateSnapshot.PROOF_VERSION
  ownerId: string
  transitionId: string
  sourceIncarnation: string
  projection: StateSnapshot.ProjectionIdentity
}

const provenanceFor = ({ failed: _failed, sourceEpoch: _sourceEpoch, ...provenance }: PersistenceFence) => provenance

const isSourceCurrent = (source: SourceOwner, fence: PersistenceFence) =>
  fence.failed === false &&
  source.handle[sourceLifecycle].phase === 'open' &&
  source.handle[sourceLifecycle].epoch === fence.sourceEpoch

const withCoordinatedTransactions = <A, R>(
  { dbState, source, fence }: { dbState: SqliteDb; source: SourceOwner; fence: PersistenceFence },
  effect: Effect.Effect<A, PersistError, R>,
): Effect.Effect<A, PersistError, Exclude<R, SourceContext>> => {
  const host = source.persistence.kind === 'native-shared-host' ? source.persistence.host : undefined
  const sameHost = host === dbState.transactionHost
  let stateTransactionOpen = false

  const rollbackState = Effect.suspend(() =>
    stateTransactionOpen === true ? executeStatement(dbState, 'ROLLBACK').pipe(Effect.ignore) : Effect.void,
  )
  const assertCurrent = (attemptedTransitionId?: string): void => {
    if (isSourceCurrent(source, fence) === true) return
    const failure = new SqliteError({ cause: 'SOURCE changed during leader persistence; reopen before publication' })
    if (attemptedTransitionId !== undefined) {
      try {
        // This attempted publication cannot leave a durable proof for bytes replaced before its linearization point.
        const statement = `DELETE FROM ${SystemTables.REBUILD_META_TABLE} WHERE id = 1 AND transitionId = ?`
        dbState.execute(statement, prepareBindValues([attemptedTransitionId], statement))
      } catch (cleanup) {
        throw new AggregateError(
          [failure, cleanup],
          'SOURCE changed and its attempted STATE proof could not be removed',
          { cause: cleanup },
        )
      }
    }
    throw failure
  }
  const requireCurrent = Effect.try({
    try: () => assertCurrent(),
    catch: (cause) => MaterializeError.make({ cause: new SqliteError({ cause }) }),
  })
  const writeCompletion = Effect.try({
    try: () => {
      const transitionId = nanoid()
      assertCurrent()
      StateSnapshot.writeProvenance(dbState, { ...provenanceFor(fence), transitionId })
      return transitionId
    },
    catch: (cause) => MaterializeError.make({ cause: new SqliteError({ cause }) }),
  })
  const transaction = Effect.gen(function* () {
    if (sameHost === false || isSourceCurrent(source, fence) === false) {
      return yield* MaterializeError.make({
        cause: new SqliteError({ cause: 'Leader persistence is fenced until reopen' }),
      })
    }
    // Invalidate before any transition. A crash must rebuild STATE from retained authoritative SOURCE.
    yield* executeStatement(dbState, `DELETE FROM ${SystemTables.REBUILD_META_TABLE}`)
    const result = yield* source.write((transaction) =>
      Effect.gen(function* () {
        // Owner admission can wait behind an image replacement; validate the acquired generation before touching STATE.
        yield* requireCurrent
        yield* executeStatement(dbState, 'BEGIN TRANSACTION')
        stateTransactionOpen = true
        const scoped: SourceOwner = { ...source, handle: transaction, write: (use) => use(transaction) }
        const result = yield* effect.pipe(Effect.provideService(SourceContext, scoped))
        // Independent databases commit STATE first. SOURCE owns its commit and any truthful cleanup itself.
        yield* requireCurrent
        yield* executeStatement(dbState, 'COMMIT')
        stateTransactionOpen = false
        return result
      }).pipe(Effect.ensuring(rollbackState)),
    )
    // An independent SOURCE commit has now settled; native work remains inside the shared host frame.
    yield* requireCurrent
    const transitionId = yield* writeCompletion
    return { result, transitionId }
  })
  return (host === undefined ? transaction : host.runTransaction(transaction)).pipe(
    Effect.mapError((error) =>
      error instanceof SourceDbError
        ? MaterializeError.make({ cause: new SqliteError({ cause: error }) })
        : error instanceof SqliteError
          ? MaterializeError.make({ cause: error })
          : error,
    ),
    Effect.flatMap(({ result, transitionId }) =>
      Effect.try({
        try: () => {
          // Check and publish synchronously: an Effect scheduling boundary here could otherwise admit a replacement.
          assertCurrent(transitionId)
          fence.transitionId = transitionId
          return result
        },
        catch: (cause) => MaterializeError.make({ cause: new SqliteError({ cause }) }),
      }),
    ),
    Effect.onExit((exit) =>
      Effect.sync(() => {
        if (exit._tag === 'Failure') fence.failed = true
      }),
    ),
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
