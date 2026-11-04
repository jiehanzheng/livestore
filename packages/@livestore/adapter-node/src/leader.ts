import {
  ClientSessionLeaderThreadProxy,
  toAdapterError,
  EventlogSqliteDb,
  MaterializationJournal,
  StateSnapshot,
  openSnapshotSession,
  StateHead,
  StateSqliteDb,
  type AdapterArgs,
  type SyncOptions,
} from '@livestore/common'
import { LeaderThreadCtx, makeLeaderThreadLayer, streamEventsWithSyncState } from '@livestore/common/leader-thread'
import type { MakeNodeSqliteDb } from '@livestore/sqlite-wasm/node'
import { Effect, Fiber, Layer, Queue, Stream } from '@livestore/utils/effect'

import { createShutdownChannel } from './shutdown.ts'
import { openDatabases, type NodeStorage } from './storage.ts'

type Options = { clientId: string; storage: NodeStorage; sync: SyncOptions | undefined }

export const createLeader = (args: AdapterArgs, options: Options, makeSqliteDb: MakeNodeSqliteDb) =>
  Effect.gen(function* () {
    const { dbState, dbEventlog, initializedSource } = yield* openDatabases(args, options.storage, makeSqliteDb)
    const shutdownChannel = yield* createShutdownChannel(args.shutdown)
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
        params: args.params,
        devtoolsOptions: { enabled: false },
        shutdownChannel,
      }).pipe(Layer.provide(stateServices)),
    )
    return yield* Effect.gen(function* () {
      const {
        syncProcessor,
        exportSnapshot,
        initialState,
        bootStatusQueue,
        extraIncomingMessagesQueue,
        networkStatus,
      } = yield* LeaderThreadCtx
      const bootStatusFiber = yield* Stream.fromQueue(bootStatusQueue).pipe(
        Stream.runForEach((status) => Queue.offer(args.bootStatusQueue, status)),
        Effect.interruptible,
        Effect.forkScoped,
      )
      yield* Queue.await(args.bootStatusQueue).pipe(Effect.andThen(Fiber.interrupt(bootStatusFiber)), Effect.forkScoped)
      // Admission and live attachment must be one owner transition; separate
      // export/pull calls can miss a same-position rebase while opening.
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
      return {
        sqliteDb,
        leaderThread: ClientSessionLeaderThreadProxy.of({
          events: {
            pull: () => pull,
            push: (batch) => syncProcessor.push(batch).pipe(Effect.uninterruptible),
            stream: (options) =>
              streamEventsWithSyncState({ dbEventlog, syncState: syncProcessor.syncState, options }).pipe(
                Stream.mapError(toAdapterError),
              ),
          },
          initialState: {
            leaderHead,
            migrationsReport,
            storageMode: options.storage.type === 'fs' ? 'persisted' : 'in-memory',
          },
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
        }),
      }
    }).pipe(Effect.provide(layer))
  })
