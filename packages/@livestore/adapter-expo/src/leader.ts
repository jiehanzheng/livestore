import {
  ClientSessionLeaderThreadProxy,
  EventlogSqliteDb,
  MaterializationJournal,
  StateSnapshot,
  toAdapterError,
  openSnapshotSession,
  StateHead,
  StateSqliteDb,
  type AdapterArgs,
  type SyncOptions,
} from '@livestore/common'
import { LeaderThreadCtx, makeLeaderThreadLayer, streamEventsWithSyncState } from '@livestore/common/leader-thread'
import { fromSyncSource, initializeSource } from '@livestore/common/source-db'
import { Effect, Exit, FetchHttpClient, Fiber, Layer, Queue, Stream } from '@livestore/utils/effect'

import { expoPersistencePaths, type ExpoStorage } from './paths.ts'
import { createExpoShutdownChannel } from './shutdown.ts'
import { allocateExpoSource } from './source-layout.ts'
import type { createSqliteFactory } from './sqlite.ts'

type Options = { clientId: string; storage?: ExpoStorage; sync?: SyncOptions }

export const createExpoLeader = function (
  args: AdapterArgs,
  options: Options,
  makeSqliteDb: ReturnType<typeof createSqliteFactory>['makeSqliteDb'],
) {
  return Effect.gen(function* () {
    const paths = expoPersistencePaths(args.storeId, args.schema, options.storage)
    const allocation = yield* Effect.tryPromise({ try: () => allocateExpoSource(paths), catch: toAdapterError })
    const dbEventlog = yield* Effect.acquireRelease(
      Effect.gen(function* () {
        const native = yield* makeSqliteDb({
          _tag: 'file',
          databaseName: paths.eventlogDatabaseName,
          directory: paths.directory,
          sourceOwner: 'exclusive',
          ...(allocation.kind === 'new' ? { sourceAllocation: allocation.allocation } : {}),
        })
        return yield* Effect.gen(function* () {
          const lease = native.metadata.sourceLease
          if (lease === undefined) return yield* toAdapterError('Native SOURCE exclusive lease is unavailable')
          return yield* fromSyncSource(native, native.metadata.sourceCreation, lease.isHeld)
        }).pipe(
          Effect.onExit((exit) => (Exit.isFailure(exit) === true ? Effect.sync(() => native.close()) : Effect.void)),
        )
      }),
      (owner) => owner.close.pipe(Effect.orDie),
    )
    const initializedSource = yield* initializeSource(dbEventlog)
    const dbState = yield* Effect.acquireRelease(
      makeSqliteDb({ _tag: 'file', databaseName: paths.stateDatabaseName, directory: paths.directory }),
      (db) => Effect.sync(() => db.close()),
    )
    const shutdownChannel = yield* createExpoShutdownChannel(args.shutdown)
    const databases = Layer.mergeAll(StateSqliteDb.layer(dbState), EventlogSqliteDb.layer(dbEventlog))
    const stateServices = Layer.mergeAll(StateHead.layer, MaterializationJournal.layer).pipe(
      Layer.provideMerge(databases),
    )
    const layer = yield* Layer.build(
      makeLeaderThreadLayer({
        storeId: args.storeId,
        clientId: options.clientId,
        schema: args.schema,
        makeSqliteDb,
        initializedSource,
        syncOptions: options.sync,
        syncPayloadEncoded: args.syncPayloadEncoded,
        syncPayloadSchema: args.syncPayloadSchema,
        devtoolsOptions: { enabled: false },
        shutdownChannel,
        params: args.params,
      }).pipe(Layer.provide(stateServices), Layer.provideMerge(FetchHttpClient.layer)),
    )
    return yield* Effect.gen(function* () {
      const {
        syncProcessor,
        extraIncomingMessagesQueue,
        exportSnapshot,
        initialState,
        bootStatusQueue,
        networkStatus,
      } = yield* LeaderThreadCtx
      const bootStatusFiber = yield* Stream.fromQueue(bootStatusQueue).pipe(
        Stream.runForEach((status) => Queue.offer(args.bootStatusQueue, status)),
        Effect.interruptible,
        Effect.forkScoped,
      )
      yield* Queue.await(args.bootStatusQueue).pipe(Effect.andThen(Fiber.interrupt(bootStatusFiber)), Effect.forkScoped)
      // Admission and queue attachment are one core transition. Exporting first
      // and subscribing later can omit a concurrent rebase, even at the same head.
      const { sqliteDb, pull, migrationsReport } = yield* openSnapshotSession({
        candidate: undefined,
        expectedProjection: StateSnapshot.getProjectionIdentity(args.schema),
        makeSqliteDb,
        open: (request) =>
          Effect.gen(function* () {
            const { admission, queue } = yield* syncProcessor.openSession(request)
            return Stream.concat(
              Stream.succeed({ ...admission, migrationsReport: initialState.migrationsReport }),
              Stream.fromQueue(queue).pipe(Stream.map((item) => ({ _tag: 'Pull' as const, item }))),
            )
          }).pipe(Stream.unwrap),
      })
      const stateHead = yield* StateHead.make.pipe(Effect.provideService(StateSqliteDb.StateSqliteDb, sqliteDb))
      const leaderHead = yield* stateHead.get
      const leaderThread = ClientSessionLeaderThreadProxy.of({
        events: {
          pull: () => pull,
          push: (batch) => syncProcessor.push(batch),
          stream: (options) =>
            streamEventsWithSyncState({ dbEventlog, syncState: syncProcessor.syncState, options }).pipe(
              Stream.mapError(toAdapterError),
            ),
        },
        initialState: { leaderHead, migrationsReport, storageMode: 'persisted' },
        export: exportSnapshot,
        getEventlogData:
          dbEventlog.image === undefined
            ? Effect.fail(toAdapterError('SOURCE image export is unavailable'))
            : dbEventlog.image.export.pipe(
                Effect.map((bytes) => bytes.slice()),
                Effect.mapError(toAdapterError),
              ),
        syncState: syncProcessor.syncState,
        sendDevtoolsMessage: (message) => Queue.offer(extraIncomingMessagesQueue, message),
        networkStatus,
      })
      return { leaderThread, sqliteDb }
    }).pipe(Effect.provide(layer))
  })
}
