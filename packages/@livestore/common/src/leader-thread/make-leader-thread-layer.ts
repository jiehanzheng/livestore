import type { SourceOwner } from '../source-db/owner.ts'
import type { SourceHandle } from '../source-db/role.ts'
import type { MakeLeaderThreadLayerParams } from './leader-thread-options.ts'
import { makeNetworkStatusSubscribable } from './network-status.ts'
export { makeNetworkStatusSubscribable } from './network-status.ts'
import { omitUndefineds, shouldNeverHappen } from '@livestore/utils'
import {
  type HttpClient,
  type Scope,
  Deferred,
  Effect,
  KeyValueStore,
  Latch,
  Layer,
  Option,
  Queue,
  ReadonlyArray,
  Schema,
  Stream,
  Subscribable,
  SubscriptionRef,
} from '@livestore/utils/effect'

import {
  type BootStatus,
  type AdapterError,
  mapToAdapterError,
  type MakeInMemorySqliteDb,
  type MaterializerHashMismatchError,
  type SqliteDb,
  UnknownError,
} from '../adapter-types.ts'
import type { MigrationsReport } from '../defs.ts'
import type * as Devtools from '../devtools/mod.ts'
import * as EventlogSqliteDb from '../EventlogSqliteDb.ts'
import type * as MaterializationJournal from '../MaterializationJournal.ts'
import type { LiveStoreSchema } from '../schema/mod.ts'
import { EventSequenceNumber, LiveStoreEvent, SystemTables } from '../schema/mod.ts'
import * as SourceIdentity from '../SourceIdentity.ts'
import type * as StateHead from '../StateHead.ts'
import * as StateSqliteDb from '../StateSqliteDb.ts'
import type { SyncBackend, SyncOptions } from '../sync/sync.ts'
import { SyncState } from '../sync/syncstate.ts'
import { sql } from '../util.ts'
import { makeBackendIdKeyValueStore } from './backend-id-kv.ts'
import { configureConnection } from './connection.ts'
import * as Eventlog from './eventlog.ts'
import { bootDevtools } from './leader-worker-devtools.ts'
import * as LeaderPersistence from './LeaderPersistence.ts'
import * as LeaderSyncProcessor from './LeaderSyncProcessor.ts'
import { makeMaterializeEvent } from './materialize-event.ts'
import { hasCompletedState, recreateDb } from './recreate-db.ts'
import type { ShutdownChannel } from './shutdown-channel.ts'
import type {
  DevtoolsContext,
  DevtoolsOptions,
  InitialBlockingSyncContext,
  InitialSyncOptions,
  ShutdownState,
} from './types.ts'
import { LeaderThreadCtx } from './types.ts'

export type { MakeLeaderThreadLayerParams } from './leader-thread-options.ts'

export const makeLeaderThreadLayer = ({
  initializedSource,
  schema,
  storeId,
  clientId,
  syncPayloadSchema = Schema.Json,
  syncPayloadEncoded,
  makeSqliteDb,
  syncOptions,
  devtoolsOptions,
  shutdownChannel,
  bootWarning,
  params,
  testing,
}: MakeLeaderThreadLayerParams): Layer.Layer<
  LeaderThreadCtx,
  AdapterError,
  | EventlogSqliteDb.EventlogSqliteDb
  | HttpClient.HttpClient
  | MaterializationJournal.MaterializationJournal
  | Scope.Scope
  | StateHead.StateHead
  | StateSqliteDb.StateSqliteDb
> =>
  Effect.gen(function* () {
    const dbState = yield* StateSqliteDb.StateSqliteDb
    const dbEventlog = yield* EventlogSqliteDb.EventlogSqliteDb
    const syncPayloadDecoded =
      syncPayloadEncoded === undefined ? undefined : yield* Schema.decodeEffect(syncPayloadSchema)(syncPayloadEncoded)

    const bootStatusQueue = yield* Effect.acquireRelease(Queue.unbounded<BootStatus>(), Queue.shutdown)

    // Emit boot warning if present (e.g., OPFS unavailable in private browsing)
    if (bootWarning !== undefined) {
      yield* Queue.offer(bootStatusQueue, bootWarning)
    }

    const dbEventlogMissing = !(yield* hasEventlogTables(dbEventlog.handle))

    const sourceIdentity = yield* SourceIdentity.assertInitialized(dbEventlog.handle, initializedSource)
    const stateNeedsRebuild = !hasCompletedState(dbState, {
      schema,
      sourceIdentity,
      sourceHead: yield* Eventlog.getClientHeadFromDb(dbEventlog.handle),
    })

    if (stateNeedsRebuild === true) {
      // Import also clears hook-created objects while preserving the open connection.
      yield* Effect.acquireUseRelease(
        makeSqliteDb({ _tag: 'in-memory' }),
        (emptyDb) =>
          configureConnection(emptyDb, { foreignKeys: false }).pipe(
            Effect.andThen(Effect.sync(() => dbState.import(emptyDb))),
            UnknownError.mapToUnknownError,
          ),
        (emptyDb) => Effect.sync(() => emptyDb.close()),
      )
    }

    const syncBackend =
      syncOptions?.backend === undefined
        ? undefined
        : yield* syncOptions
            .backend({ storeId, clientId, payload: syncPayloadDecoded })
            .pipe(Effect.provide(Layer.succeed(KeyValueStore.KeyValueStore, makeBackendIdKeyValueStore(dbEventlog))))

    if (syncBackend !== undefined) {
      // We're already connecting to the sync backend concurrently
      yield* syncBackend.connect.pipe(Effect.tapCauseLogPretty, Effect.forkScoped)
    }

    const initialBlockingSyncContext = yield* makeInitialBlockingSyncContext({
      initialSyncOptions: syncOptions?.initialSyncOptions ?? { _tag: 'Skip' },
      bootStatusQueue,
    })

    const materializeEvent = yield* makeMaterializeEvent({ schema })

    // Recreate state database if needed BEFORE creating sync processor
    // This ensures all system tables exist before any queries are made
    const { migrationsReport } =
      stateNeedsRebuild === true
        ? yield* recreateDb({
            initializedSource,
            schema,
            bootStatusQueue,
            materializeEvent,
            ...omitUndefineds({ stateRebuildBatchSize: params?.stateRebuildBatchSize }),
          })
        : { migrationsReport: { migrations: [] } }

    const devtoolsContext =
      devtoolsOptions.enabled === true
        ? {
            enabled: true as const,
            syncBackendLatch: yield* Latch.make(true),
            syncBackendLatchState: yield* SubscriptionRef.make<{ latchClosed: boolean }>({ latchClosed: false }),
          }
        : { enabled: false as const }

    const span = yield* Effect.currentSpan.pipe(Effect.option, Effect.map(Option.getOrUndefined))
    const persistence = yield* LeaderPersistence.make({ materializeEvent, schema })

    const syncProcessor = yield* LeaderSyncProcessor.make({
      schema,
      runtime: {
        syncBackend,
        shutdownChannel,
        devtoolsLatch: devtoolsContext.enabled === true ? devtoolsContext.syncBackendLatch : undefined,
        span,
      },
      initialSyncState: yield* getInitialSyncState({ dbEventlog, dbEventlogMissing }),
      initialBlockingSyncContext,
      onError: syncOptions?.onSyncError ?? 'ignore',
      onBackendIdMismatch: syncOptions?.onBackendIdMismatch ?? 'reset',
      livePull: syncOptions?.livePull ?? true,
      params: {
        ...omitUndefineds({
          localPushBatchSize: params?.localPushBatchSize,
          backendPushBatchSize: params?.backendPushBatchSize,
        }),
      },
      testing: {
        ...omitUndefineds({ delays: testing?.syncProcessor?.delays, hooks: testing?.syncProcessor?.hooks }),
      },
    }).pipe(Effect.provideService(LeaderPersistence.LeaderPersistence, persistence))

    const extraIncomingMessagesQueue = yield* Effect.acquireRelease(
      Queue.unbounded<Devtools.Leader.MessageToApp>(),
      Queue.shutdown,
    )

    const networkStatus = yield* makeNetworkStatusSubscribable({ syncBackend, devtoolsContext })

    const ctx = {
      resetSource: persistence.resetSource,
      schema,
      bootStatusQueue,
      storeId,
      clientId,
      makeSqliteDb,
      eventSchema: LiveStoreEvent.Client.makeSchema(schema),
      shutdownStateSubRef: yield* SubscriptionRef.make<ShutdownState>('running'),
      shutdownChannel,
      syncBackend,
      syncProcessor,
      exportSnapshot: persistence.exportSnapshot,
      materializeEvent,
      extraIncomingMessagesQueue,
      devtools: devtoolsContext,
      networkStatus,
      // State will be set during `bootLeaderThread`
      initialState: {} as any as LeaderThreadCtx['Service']['initialState'],
    } satisfies LeaderThreadCtx['Service']

    // @ts-expect-error For debugging purposes
    globalThis.__leaderThreadCtx = ctx

    yield* SourceIdentity.assertInitialized(dbEventlog.handle, initializedSource)
    const layer = Layer.succeed(LeaderThreadCtx, LeaderThreadCtx.of(ctx))

    ctx.initialState = yield* bootLeaderThread({
      migrationsReport,
      initialBlockingSyncContext,
      devtoolsOptions,
    }).pipe(Effect.provide(layer))

    return layer
  }).pipe(
    Effect.withSpan('@livestore/common:leader-thread:boot'),
    Effect.withSpanScoped('@livestore/common:leader-thread'),
    mapToAdapterError,
    Effect.tapCauseLogPretty,
    Layer.unwrap,
  )

const hasEventlogTables = (db: SourceHandle) =>
  db.select<{ name: string }>(sql`select name from sqlite_master`).pipe(
    Effect.map((rows) => {
      const tableNames = new Set(rows.map((row) => row.name))
      return ReadonlyArray.every(SystemTables.eventlogSystemTables, (table) => tableNames.has(table.sqliteDef.name))
    }),
  )

const getInitialSyncState = ({
  dbEventlog,
  dbEventlogMissing,
}: {
  dbEventlog: SourceOwner
  dbEventlogMissing: boolean
}) =>
  Effect.gen(function* () {
    const initialBackendHead =
      dbEventlogMissing === true
        ? EventSequenceNumber.Client.ROOT.global
        : yield* Eventlog.getBackendHeadFromDb(dbEventlog.handle)

    const initialLocalHead =
      dbEventlogMissing === true
        ? EventSequenceNumber.Client.ROOT
        : yield* Eventlog.getClientHeadFromDb(dbEventlog.handle)

    if (initialBackendHead > initialLocalHead.global) {
      return shouldNeverHappen(
        `During boot the backend head (${initialBackendHead}) should never be greater than the local head (${initialLocalHead.global})`,
      )
    }

    return SyncState.make({
      localHead: initialLocalHead,
      upstreamHead: {
        global: initialBackendHead,
        client: EventSequenceNumber.Client.DEFAULT,
        rebaseGeneration: EventSequenceNumber.Client.REBASE_GENERATION_DEFAULT,
      },
      pending:
        dbEventlogMissing === true
          ? []
          : yield* Eventlog.getEventsSince({
              dbEventlog: dbEventlog.handle,
              since: {
                global: initialBackendHead,
                client: EventSequenceNumber.Client.DEFAULT,
                rebaseGeneration: initialLocalHead.rebaseGeneration,
              },
            }),
    })
  })

const makeInitialBlockingSyncContext = ({
  initialSyncOptions,
  bootStatusQueue,
}: {
  initialSyncOptions: InitialSyncOptions
  bootStatusQueue: Queue.Queue<BootStatus>
}) =>
  Effect.gen(function* () {
    const ctx = {
      isDone: false,
      processedEvents: 0,
      total: -1,
    }

    const blockingDeferred = initialSyncOptions._tag === 'Blocking' ? yield* Deferred.make<void>() : undefined

    if (blockingDeferred !== undefined && initialSyncOptions._tag === 'Blocking') {
      yield* Deferred.succeed(blockingDeferred, void 0).pipe(
        Effect.delay(initialSyncOptions.timeout),
        Effect.forkScoped,
      )
    }

    return {
      blockingDeferred,
      update: ({ processed, pageInfo }) =>
        Effect.gen(function* () {
          if (ctx.isDone === true) return

          if (ctx.total === -1 && pageInfo._tag === 'MoreKnown') {
            ctx.total = pageInfo.remaining + processed
          }

          ctx.processedEvents += processed
          yield* Queue.offer(bootStatusQueue, {
            stage: 'syncing',
            progress: { done: ctx.processedEvents, total: ctx.total },
          })

          if (pageInfo._tag === 'NoMore' && blockingDeferred !== undefined) {
            yield* Deferred.succeed(blockingDeferred, void 0)
            ctx.isDone = true
          }
        }),
    } satisfies InitialBlockingSyncContext
  })

/**
 * Blocks until the leader thread has finished its initial setup.
 * It also starts various background processes (e.g. syncing)
 */
const bootLeaderThread = ({
  migrationsReport,
  initialBlockingSyncContext,
  devtoolsOptions,
}: {
  migrationsReport: MigrationsReport
  initialBlockingSyncContext: InitialBlockingSyncContext
  devtoolsOptions: DevtoolsOptions
}): Effect.Effect<
  LeaderThreadCtx['Service']['initialState'],
  UnknownError | MaterializerHashMismatchError,
  | EventlogSqliteDb.EventlogSqliteDb
  | LeaderThreadCtx
  | Scope.Scope
  | HttpClient.HttpClient
  | StateSqliteDb.StateSqliteDb
> =>
  Effect.gen(function* () {
    const { bootStatusQueue, syncProcessor } = yield* LeaderThreadCtx

    // NOTE the sync processor depends on the dbs being initialized properly
    const { initialLeaderHead } = yield* syncProcessor.boot

    if (initialBlockingSyncContext.blockingDeferred !== undefined) {
      // Provides a syncing status right away before the first pull response comes in
      yield* Queue.offer(bootStatusQueue, {
        stage: 'syncing',
        progress: { done: 0, total: -1 },
      })

      yield* Deferred.await(initialBlockingSyncContext.blockingDeferred).pipe(
        Effect.withSpan('@livestore/common:leader-thread:initial-sync-blocking'),
      )
    }

    yield* Queue.offer(bootStatusQueue, { stage: 'done' })

    yield* bootDevtools(devtoolsOptions).pipe(Effect.tapCauseLogPretty, Effect.forkScoped)

    return { migrationsReport, leaderHead: initialLeaderHead }
  })
