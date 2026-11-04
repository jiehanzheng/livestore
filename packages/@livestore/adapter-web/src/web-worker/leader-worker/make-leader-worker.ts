import type * as otel from '@opentelemetry/api'

import { mapToAdapterError } from '@livestore/common'
import type { BootStatus, BootWarningReason, LogConfig, SqliteDb, SyncOptions } from '@livestore/common'
import { MaterializationJournal } from '@livestore/common'
import { Devtools, EventlogSqliteDb, StateHead, StateSqliteDb, UnknownError } from '@livestore/common'
import type { DevtoolsOptions, StreamEventsOptions } from '@livestore/common/leader-thread'
import {
  configureConnection,
  Eventlog,
  LeaderThreadCtx,
  makeLeaderThreadLayer,
  streamEventsWithSyncState,
} from '@livestore/common/leader-thread'
import { LiveStoreEvent, type LiveStoreSchema } from '@livestore/common/schema'
import { fromSyncSource, type SourceOwner } from '@livestore/common/source-db'
import { sqliteDbFactory } from '@livestore/sqlite-wasm/browser'
import { loadSqlite3Wasm } from '@livestore/sqlite-wasm/load-wasm'
import { isDevEnv, LS_DEV } from '@livestore/utils'
import {
  Deferred,
  Effect,
  FetchHttpClient,
  identity,
  Layer,
  OtelTracer,
  Queue,
  References,
  RpcSerialization,
  RpcServer,
  RpcWorker,
  type Schema,
  Scope,
  Stream,
  TaskTracing,
} from '@livestore/utils/effect'
import { BrowserWorkerRunner, Opfs, WebError } from '@livestore/utils/effect/browser'
import * as WebmeshWorker from '@livestore/webmesh/worker'

import { checkOpfsAvailability } from '../common/browser-environment.ts'
import {
  cleanupOldStateDbFiles,
  discoverPersistedSource,
  getStateDbFileName,
  sanitizeOpfsDir,
} from '../common/persisted-sqlite.ts'
import { withPhysicalWorkerLifetime } from '../common/physical-worker-lifetime.ts'
import { makeShutdownChannel } from '../common/shutdown-channel.ts'
import { acquireSourceNamespace } from '../common/source-namespace.ts'
import * as WorkerSchema from '../common/worker-schema.ts'
import { closeSqliteDb } from './close-sqlite-db.ts'
import { makeDevtoolsOptions } from './devtools-options.ts'
import { makeMessagePortRpcServerProtocol } from './message-port-rpc-protocol.ts'

export type WorkerOptions = {
  /**
   * Optional outer RPC transport paired with the adapter's worker factory port.
   * Closing this endpoint releases SDK resources without closing the worker global,
   * so its application owner can join makeWorkerEffect before terminating the Worker.
   * Omit to use the ambient worker transport. Inner session ports are unchanged.
   */
  transport?: MessagePort
  schema: LiveStoreSchema
  sync?: SyncOptions
  syncPayloadSchema?: Schema.Top
  otelOptions?: {
    tracer?: otel.Tracer
  }
} & LogConfig.LoggerOptions

if (isDevEnv() === true) {
  globalThis.__debugLiveStoreUtils = {
    opfs: Opfs.debugUtils,
    blobUrl: (buffer: Uint8Array<ArrayBuffer>) =>
      URL.createObjectURL(new Blob([buffer], { type: 'application/octet-stream' })),
    runSync: <A, E>(effect: Effect.Effect<A, E>) => Effect.runSync(effect),
    runFork: <A, E>(effect: Effect.Effect<A, E>) => Effect.runFork(effect),
  }
}

export const makeWorker = (options: WorkerOptions) => {
  Effect.runFork(makeWorkerEffect(options))
}

export const makeWorkerEffect = (options: WorkerOptions) => {
  const TracingLive =
    options.otelOptions?.tracer !== undefined
      ? OtelTracer.layerWithoutOtelTracer.pipe(
          Layer.provideMerge(Layer.succeed(OtelTracer.OtelTracer, options.otelOptions.tracer)),
        )
      : Layer.empty

  const runtimeLayer = Layer.mergeAll(
    FetchHttpClient.layer,
    TracingLive,
    Layer.succeed(References.MaxOpsBeforeYield, 4096),
  )

  return makeWorkerRunnerOuter(options).pipe(
    Effect.provide(
      Layer.provideMerge(
        RpcServer.layerProtocolWorkerRunner,
        options.transport === undefined
          ? BrowserWorkerRunner.layer
          : BrowserWorkerRunner.layerMessagePort(options.transport),
      ),
    ),
    Effect.scoped,
    Effect.tapCauseLogPretty,
    Effect.annotateLogs({ thread: self.name }),
    Effect.provide(runtimeLayer),
    LS_DEV === true ? TaskTracing.withAsyncTaggingTracing((name) => (console as any).createTask(name)) : identity,
    Effect.provide(
      Layer.mergeAll(
        options.logger ?? Layer.empty,
        Layer.succeed(References.MinimumLogLevel, options.logLevel ?? (isDevEnv() === true ? 'Debug' : 'Info')),
      ),
    ),
  )
}

const makeWorkerRunnerOuter = Effect.fn('@livestore/adapter-web:worker:wrapper:InitialMessage')(function* (
  workerOptions: WorkerOptions,
) {
  // Port coming from client session and forwarded via the shared worker.
  const {
    port: incomingRequestsPort,
    lifetimePort,
    storeId,
    clientId,
  } = yield* RpcWorker.initialMessage(WorkerSchema.LeaderWorkerOuterInitialMessage.payloadSchema)

  return yield* withPhysicalWorkerLifetime(
    lifetimePort,
    RpcServer.make(WorkerSchema.LeaderWorkerInnerRpcs).pipe(
      Effect.provide(
        Layer.provideMerge(
          makeWorkerRunnerInner(workerOptions),
          makeMessagePortRpcServerProtocol(incomingRequestsPort),
        ),
      ),
      Effect.withSpan('@livestore/adapter-web:worker:wrapper:InitialMessage:innerFiber'),
      Effect.tapCauseLogPretty,
      Effect.provide(
        Layer.mergeAll(
          Opfs.layer,
          WebmeshWorker.CacheService.layer({
            nodeName: Devtools.makeNodeName.client.leader({ storeId, clientId }),
          }),
        ),
      ),
    ),
  )
})

const makeWorkerRunnerInner = ({ schema, sync: syncOptions, syncPayloadSchema }: WorkerOptions) =>
  WorkerSchema.LeaderWorkerInnerRpcs.toLayer(
    Effect.gen(function* () {
      const leaderThreadScope = yield* Scope.make()
      yield* Effect.addFinalizer((exit) => Scope.close(leaderThreadScope, exit))

      const leaderThreadContextOnce = yield* Effect.cached(
        Effect.gen(function* () {
          const { storageOptions, storeId, clientId, devtoolsEnabled, debugInstanceId, syncPayloadEncoded, params } =
            yield* RpcWorker.initialMessage(WorkerSchema.LeaderWorkerInnerInitialMessage.payloadSchema)

          const sqlite3 = yield* Effect.promise(() => loadSqlite3Wasm())
          const makeSqliteDb = yield* sqliteDbFactory({ sqlite3 })
          const services = yield* Effect.context()

          // Check OPFS availability and determine storage mode
          const opfsCheck = yield* checkOpfsAvailability
          const useOpfs = opfsCheck === undefined

          // Track boot warning to emit later
          let bootWarning: BootStatus | undefined
          if (useOpfs === false) {
            yield* Effect.logWarning(
              '[@livestore/adapter-web:worker] OPFS unavailable, using in-memory storage',
              opfsCheck,
            )
            bootWarning = { stage: 'warning', ...opfsCheck }
          }

          const opfsDirectory = useOpfs === true ? yield* sanitizeOpfsDir(storageOptions.directory, storeId) : undefined

          const namespace =
            useOpfs === true
              ? yield* acquireSourceNamespace({ directory: opfsDirectory!, closePhysicalOwner: makeSqliteDb.close })
              : undefined
          const discovery =
            namespace === undefined ? undefined : yield* discoverPersistedSource({ storageOptions, storeId, namespace })

          let sourceOwner: SourceOwner | undefined
          const releaseSource = (database: SqliteDb) =>
            sourceOwner === undefined ? closeSqliteDb(database) : sourceOwner.close.pipe(Effect.orDie)

          const makeOpfsDb = (kind: 'state' | 'eventlog') =>
            Effect.acquireRelease(
              makeSqliteDb({
                _tag: 'opfs',
                ...(kind === 'eventlog' && discovery?.inventory !== undefined
                  ? { sourceInventory: discovery.inventory }
                  : {}),
                opfsDirectory: opfsDirectory!,
                fileName: kind === 'state' ? getStateDbFileName(schema) : 'eventlog.db',
                configureDb: (db) =>
                  configureConnection(db, {
                    //  The persisted databases use the AccessHandlePoolVFS which always uses a single database connection.
                    //  Multiple connections are not supported. This means that we can use the exclusive locking mode to
                    //  avoid unnecessary system calls and enable the use of the WAL journal mode without the use of shared memory.
                    // TODO bring back exclusive locking mode when `WAL` is working properly
                    // lockingMode: 'EXCLUSIVE',
                    foreignKeys: true,
                  }).pipe(Effect.runSyncWith(services)),
              }),
              (database) => (kind === 'eventlog' ? releaseSource(database) : closeSqliteDb(database)),
            )

          const makeInMemoryDb = (isSource = false) =>
            Effect.acquireRelease(
              makeSqliteDb({
                _tag: 'in-memory',
                configureDb: (db) => configureConnection(db, { foreignKeys: true }).pipe(Effect.runSyncWith(services)),
              }),
              (database) => (isSource === true ? releaseSource(database) : closeSqliteDb(database)),
            )

          // Validate authoritative source before opening any derived database.
          const nativeSource = yield* useOpfs === true ? makeOpfsDb('eventlog') : makeInMemoryDb(true)
          const creation =
            nativeSource.metadata._tag === 'opfs'
              ? nativeSource.metadata.sourceCreation
              : {
                  kind: 'new-memory-connection' as const,
                  storageName: nativeSource.metadata.persistenceInfo.fileName,
                  isHeld: () => true,
                }
          const dbEventlog = yield* fromSyncSource(nativeSource, creation, namespace?.isHeld)
          sourceOwner = dbEventlog
          const initializedSource = yield* Eventlog.initializeSource(dbEventlog)
          const dbState = yield* useOpfs === true ? makeOpfsDb('state') : makeInMemoryDb()

          // Clean up old state database files after successful database creation
          // This prevents OPFS file pool capacity exhaustion from accumulated state db files after schema changes/migrations
          if (dbState.metadata._tag === 'opfs') {
            yield* cleanupOldStateDbFiles({
              vfs: dbState.metadata.vfs,
              currentSchema: schema,
              opfsDirectory: dbState.metadata.persistenceInfo.opfsDirectory,
            })
          }

          const devtoolsOptions = yield* makeDevtoolsOptions({ devtoolsEnabled, dbState, dbEventlog: nativeSource })
          const shutdownChannel = yield* makeShutdownChannel(storeId)
          const sqliteDbLayer = Layer.mergeAll(StateSqliteDb.layer(dbState), EventlogSqliteDb.layer(dbEventlog))
          const stateServicesLayer = Layer.mergeAll(StateHead.layer, MaterializationJournal.layer).pipe(
            Layer.provide(sqliteDbLayer),
          )

          const leaderThreadLayer = makeLeaderThreadLayer({
            schema,
            initializedSource,
            storeId,
            clientId,
            makeSqliteDb,
            syncOptions,
            devtoolsOptions,
            shutdownChannel,
            syncPayloadEncoded,
            syncPayloadSchema: syncPayloadSchema as Schema.Decoder<Schema.Json, never> | undefined,
            params,
            ...(bootWarning !== undefined ? { bootWarning } : {}),
          }).pipe(Layer.provide(Layer.mergeAll(sqliteDbLayer, stateServicesLayer)))

          return yield* Layer.buildWithScope(Layer.mergeAll(leaderThreadLayer, sqliteDbLayer), leaderThreadScope)
        }).pipe(
          Scope.provide(leaderThreadScope),
          Effect.tapCauseLogPretty,
          mapToAdapterError,
          Effect.withPerformanceMeasure('@livestore/adapter-web:worker:InitialMessage'),
          Effect.withSpan('@livestore/adapter-web:worker:InitialMessage'),
        ),
      )

      const provideLeaderThread = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        Effect.gen(function* () {
          const leaderThreadContext = yield* leaderThreadContextOnce
          return yield* effect.pipe(Effect.provide(leaderThreadContext))
        })
      const provideLeaderThreadStream = <A, E, R>(stream: Stream.Stream<A, E, R>) =>
        Stream.unwrap(
          Effect.gen(function* () {
            const leaderThreadContext = yield* leaderThreadContextOnce
            return stream.pipe(Stream.provide(leaderThreadContext))
          }),
        )

      return WorkerSchema.LeaderWorkerInnerRpcs.of({
        GetRecreateSnapshot: () =>
          Effect.gen(function* () {
            const workerCtx = yield* LeaderThreadCtx

            // NOTE we can only return the cached snapshot once as it's transferred (i.e. disposed), so we need to set it to undefined
            // const cachedSnapshot =
            //   result._tag === 'Recreate' ? yield* Ref.getAndSet(result.snapshotRef, undefined) : undefined

            // return cachedSnapshot ?? workerCtx.db.export()

            const snapshot = yield* workerCtx.exportSnapshot
            return { snapshot, migrationsReport: workerCtx.initialState.migrationsReport }
          }).pipe(provideLeaderThread),
        OpenSession: (request) =>
          Effect.gen(function* () {
            const { syncProcessor, initialState } = yield* LeaderThreadCtx
            const { admission, queue } = yield* syncProcessor.openSession(request)
            return Stream.concat(
              Stream.succeed({ ...admission, migrationsReport: initialState.migrationsReport }),
              Stream.fromQueue(queue).pipe(Stream.map((item) => ({ _tag: 'Pull' as const, item }))),
            )
          }).pipe(provideLeaderThread, Stream.unwrap),
        PullStream: ({ cursor }) =>
          Effect.gen(function* () {
            const { syncProcessor } = yield* LeaderThreadCtx // <- syncState comes from here
            return syncProcessor.pull({ cursor })
          }).pipe(
            provideLeaderThread,
            Stream.unwrap,
            // For debugging purposes
            // Stream.tapLogWithLabel('@livestore/adapter-web:worker:PullStream'),
          ),
        PushToLeader: ({ batch }) =>
          Effect.andThen(LeaderThreadCtx, ({ syncProcessor }) => syncProcessor.push(batch)).pipe(
            provideLeaderThread,
            Effect.uninterruptible,
            Effect.withSpan('@livestore/adapter-web:worker:PushToLeader'),
          ),
        StreamEvents: (options) =>
          Effect.gen(function* () {
            const { syncProcessor } = yield* LeaderThreadCtx
            const dbEventlog = yield* EventlogSqliteDb.EventlogSqliteDb
            return streamEventsWithSyncState({
              dbEventlog,
              syncState: syncProcessor.syncState,
              options: options as StreamEventsOptions,
            }).pipe(Stream.mapError((cause) => UnknownError.make({ cause })))
          }).pipe(provideLeaderThread, Stream.unwrap, Stream.withSpan('@livestore/adapter-web:worker:StreamEvents')),
        Export: () =>
          LeaderThreadCtx.pipe(
            Effect.flatMap((ctx) => ctx.exportSnapshot),
            provideLeaderThread,
            Effect.withSpan('@livestore/adapter-web:worker:Export'),
          ),
        ExportEventlog: () =>
          EventlogSqliteDb.EventlogSqliteDb.pipe(
            Effect.flatMap((dbEventlog) =>
              dbEventlog.image === undefined
                ? Effect.die(new Error('SOURCE image export is unsupported by this provider'))
                : dbEventlog.image.export.pipe(
                    Effect.map((bytes) => new Uint8Array(bytes)),
                    UnknownError.mapToUnknownError,
                  ),
            ),
            provideLeaderThread,
            Effect.withSpan('@livestore/adapter-web:worker:ExportEventlog'),
          ),
        BootStatusStream: () =>
          LeaderThreadCtx.pipe(
            Effect.map((_) => Stream.fromQueue(_.bootStatusQueue)),
            provideLeaderThread,
            Stream.unwrap,
          ),
        GetLeaderHead: () =>
          Effect.gen(function* () {
            const dbEventlog = yield* EventlogSqliteDb.EventlogSqliteDb
            return yield* Eventlog.getClientHeadFromDb(dbEventlog.handle).pipe(UnknownError.mapToUnknownError)
          }).pipe(provideLeaderThread),
        GetLeaderSyncState: () =>
          Effect.gen(function* () {
            const workerCtx = yield* LeaderThreadCtx
            return yield* workerCtx.syncProcessor.syncState
          }).pipe(provideLeaderThread),
        SyncStateStream: () =>
          Effect.gen(function* () {
            const workerCtx = yield* LeaderThreadCtx
            return workerCtx.syncProcessor.syncState.changes
          }).pipe(provideLeaderThread, Stream.unwrap),
        GetNetworkStatus: () =>
          Effect.gen(function* () {
            const workerCtx = yield* LeaderThreadCtx
            return yield* workerCtx.networkStatus
          }).pipe(provideLeaderThread),
        NetworkStatusStream: () =>
          Effect.gen(function* () {
            const workerCtx = yield* LeaderThreadCtx
            return workerCtx.networkStatus.changes
          }).pipe(provideLeaderThread, Stream.unwrap),
        Shutdown: Effect.fn('@livestore/adapter-web:worker:Shutdown')(function* () {
          yield* Effect.logDebug('[@livestore/adapter-web:worker] Shutdown')

          // Buy some time for Otel to flush
          // TODO find a cleaner way to do this
          yield* Effect.sleep(300)
        }),
        ExtraDevtoolsMessage: ({ message }) =>
          Effect.andThen(LeaderThreadCtx, (_) => Queue.offer(_.extraIncomingMessagesQueue, message)).pipe(
            provideLeaderThread,
            Effect.asVoid,
            Effect.withSpan('@livestore/adapter-web:worker:ExtraDevtoolsMessage'),
          ),
        'WebmeshWorker.CreateConnection': (payload) =>
          WebmeshWorker.CreateConnection(payload).pipe(provideLeaderThreadStream),
      })
    }),
  )
