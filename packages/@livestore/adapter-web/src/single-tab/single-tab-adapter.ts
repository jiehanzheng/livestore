import { mapToAdapterError, openSnapshotSession, StateSnapshot } from '@livestore/common'
/**
 * Single-tab adapter for browsers without SharedWorker support (e.g. Android Chrome).
 *
 * This adapter is a fallback for browsers that don't support the SharedWorker API.
 * It provides the same OPFS persistence as the regular persisted adapter, but without
 * multi-tab synchronization capabilities.
 *
 * **IMPORTANT**: This code is intended to be removed once SharedWorker support is
 * available in Android Chrome. Track progress at:
 * - LiveStore issue: https://github.com/livestorejs/livestore/issues/321
 * - Chromium bug: https://issues.chromium.org/issues/40290702
 *
 * @module
 */
import type { Adapter, ClientSession, LockStatus } from '@livestore/common'
import {
  IntentionalShutdownCause,
  makeClientSession,
  StateSqliteDb,
  StateHead,
  StoreInterrupted,
  UnknownError,
} from '@livestore/common'
import { inMemorySqliteDbFactory } from '@livestore/sqlite-wasm/browser'
import { tryAsFunctionAndNew } from '@livestore/utils'
import {
  Cause,
  Effect,
  Exit,
  Fiber,
  Layer,
  Queue,
  RpcClient,
  RpcWorker,
  Schema,
  Stream,
  Subscribable,
  SubscriptionRef,
} from '@livestore/utils/effect'
import { BrowserWorker, Opfs } from '@livestore/utils/effect/browser'

import { makeLeaderElectionLock } from '../web-worker/client-session/leader-election-lock.ts'
import { loadInMemorySqlite3 } from '../web-worker/client-session/sqlite-loader.ts'
import {
  checkOpfsAvailability,
  ensureBrowserRequirements,
  getPersistedId,
} from '../web-worker/common/browser-environment.ts'
import {
  readPersistedStateDbFromClientSession,
  resetPersistedDataFromClientSession,
} from '../web-worker/common/persisted-sqlite.ts'
import * as PhysicalWorker from '../web-worker/common/physical-worker-lifetime.ts'
import {
  type WithoutRpcClientError,
  dieOnRpcClientError,
  dieOnRpcClientErrorStream,
} from '../web-worker/common/rpc-worker.ts'
import { makeShutdownChannel } from '../web-worker/common/shutdown-channel.ts'
import * as WorkerSchema from '../web-worker/common/worker-schema.ts'
import type { SingleTabAdapterOptions } from './single-tab-adapter-options.ts'

export type { SingleTabAdapterOptions } from './single-tab-adapter-options.ts'

/**
 * Creates a single-tab web adapter with OPFS persistence.
 *
 * **This adapter is a fallback for browsers without SharedWorker support** (notably Android Chrome).
 * It provides the same persistence capabilities as `makePersistedAdapter`, but without multi-tab
 * synchronization. Each browser tab runs its own independent leader worker.
 *
 * In most cases, you should use `makePersistedAdapter` instead, which automatically falls back
 * to this adapter when SharedWorker is unavailable.
 *
 * **Limitations**:
 * - No multi-tab synchronization (each tab operates independently)
 * - No devtools support (requires SharedWorker)
 * - A second store with the same storeId is refused while its physical owner is active
 *
 * @see https://github.com/livestorejs/livestore/issues/321 - LiveStore tracking issue
 * @see https://issues.chromium.org/issues/40290702 - Chromium SharedWorker bug
 *
 * @example
 * ```ts
 * import { makeSingleTabAdapter } from '@livestore/adapter-web'
 * import LiveStoreWorker from './livestore.worker.ts?worker'
 *
 * // Only use this directly if you specifically need single-tab mode.
 * // Prefer makePersistedAdapter which auto-detects SharedWorker support.
 * const adapter = makeSingleTabAdapter({
 *   worker: LiveStoreWorker,
 *   storage: { type: 'opfs' },
 * })
 * ```
 */
export const makeSingleTabAdapter =
  (options: SingleTabAdapterOptions): Adapter =>
  (adapterArgs) =>
    Effect.gen(function* () {
      const { schema, storeId, bootStatusQueue, shutdown, syncPayloadEncoded, params } = adapterArgs
      // Note: devtoolsEnabled is ignored in single-tab mode (devtools require SharedWorker)

      yield* ensureBrowserRequirements

      // This mode cannot join an existing owner. Refuse immediately instead of waiting
      // forever behind a private worker, while sharing the normal physical owner lock.
      let physicalLifetime: PhysicalWorker.PhysicalWorkerLifetime | undefined
      const ownership = yield* makeLeaderElectionLock(
        `livestore-tab-lock-${storeId}`,
        () => physicalLifetime?.close ?? Effect.void,
      )
      if ((yield* ownership.tryAcquire) === false) {
        return yield* new UnknownError({
          cause: 'Single-tab storage already has an active owner; close it before opening another store',
        })
      }

      yield* Queue.offer(bootStatusQueue, { stage: 'loading' })

      const sqlite3 = yield* Effect.promise(() => loadInMemorySqlite3())
      const makeSqliteDb = yield* inMemorySqliteDbFactory({ sqlite3 })

      const storageOptions = yield* Schema.decodeEffect(WorkerSchema.StorageType)(options.storage)

      const shutdownChannel = yield* makeShutdownChannel(storeId)

      // Check OPFS availability early and notify user if storage is unavailable (e.g. private browsing)
      const opfsWarning = yield* checkOpfsAvailability
      if (opfsWarning !== undefined) {
        yield* Effect.logWarning('[@livestore/adapter-web:single-tab] OPFS unavailable', opfsWarning)
      }

      if (options.resetPersistence === true && opfsWarning === undefined) {
        yield* shutdownChannel.send(IntentionalShutdownCause.make({ reason: 'adapter-reset' }))
        yield* resetPersistedDataFromClientSession({ storageOptions, storeId })
      } else if (options.resetPersistence === true) {
        yield* Effect.logWarning(
          '[@livestore/adapter-web:single-tab] Skipping persistence reset because storage is unavailable',
          opfsWarning,
        )
      }

      // Fast-path: try to load snapshot directly from storage
      const dataFromFile =
        options.experimental?.disableFastPath === true || opfsWarning !== undefined
          ? undefined
          : yield* readPersistedStateDbFromClientSession({ storageOptions, storeId, schema, makeSqliteDb }).pipe(
              Effect.tapError((error) =>
                Effect.logDebug('[@livestore/adapter-web:single-tab] Could not read persisted state db', error, {
                  storeId,
                }),
              ),
              Effect.orElseSucceed(() => undefined),
            )

      const clientId = options.clientId ?? getPersistedId(`clientId:${storeId}`, 'local')
      const sessionId = options.sessionId ?? getPersistedId(`sessionId:${storeId}`, 'session')

      yield* shutdownChannel.listen.pipe(
        Stream.mapEffect(Effect.fromResult),
        Stream.tap((cause) =>
          shutdown(cause._tag === 'IntentionalShutdownCause' ? Exit.succeed(cause) : Exit.fail(cause)),
        ),
        Stream.runDrain,
        Effect.interruptible,
        Effect.tapCauseLogPretty,
        Effect.forkScoped,
      )

      // In single-tab mode, we always have the lock (we're always the leader)
      const lockStatus = yield* SubscriptionRef.make<LockStatus>('has-lock')

      // Create MessageChannel for direct communication with the dedicated worker
      const mc = new MessageChannel()

      const lifetime = yield* PhysicalWorker.makePhysicalWorkerLifetime.pipe(
        Effect.tap((owner) =>
          Effect.sync(() => {
            physicalLifetime = owner
          }),
        ),
        Effect.uninterruptible,
      )

      // Create the dedicated worker directly (no SharedWorker proxy)
      const worker = tryAsFunctionAndNew(options.worker, { name: `livestore-worker-${storeId}-${sessionId}` })

      // Set up communication with the dedicated worker via the outer protocol
      const outerWorkerContext = yield* Layer.build(
        RpcClient.layerProtocolWorker({ size: 1 }).pipe(
          Layer.provide(BrowserWorker.layer(() => worker)),
          Layer.provide(
            RpcWorker.layerInitialMessage(
              WorkerSchema.LeaderWorkerOuterInitialMessage.payloadSchema,
              lifetime.initialPort.pipe(
                Effect.map((lifetimePort) => ({ port: mc.port1, lifetimePort, storeId, clientId })),
              ),
            ),
          ),
        ),
      )
      yield* RpcClient.make(WorkerSchema.LeaderWorkerOuterRpcs).pipe(
        Effect.provide(outerWorkerContext),
        mapToAdapterError,
        Effect.tapCause((cause) => shutdown(Exit.failCause(cause))),
        Effect.withSpan('@livestore/adapter-web:single-tab:setupDedicatedWorker'),
        Effect.tapCauseLogPretty,
      )

      yield* lifetime.ready

      // Set up the inner worker communication via port2 (like SharedWorker would do)
      // BrowserWorker.layer accepts a MessagePort as well as a Worker
      const innerWorkerContext = yield* Layer.build(
        RpcClient.layerProtocolWorker({ size: 1, concurrency: 100 }).pipe(
          Layer.provide(BrowserWorker.layer(() => mc.port2)),
          Layer.provide(
            RpcWorker.layerInitialMessage(
              WorkerSchema.LeaderWorkerInnerInitialMessage.payloadSchema,
              Effect.succeed({
                storageOptions,
                storeId,
                clientId,
                // Devtools disabled in single-tab mode (requires SharedWorker)
                devtoolsEnabled: false,
                debugInstanceId: adapterArgs.debugInstanceId,
                syncPayloadEncoded,
                params,
              }),
            ),
          ),
        ),
      )
      const innerWorker = yield* RpcClient.make(WorkerSchema.LeaderWorkerInnerRpcs).pipe(
        Effect.provide(innerWorkerContext),
        Effect.tapCauseLogPretty,
        mapToAdapterError,
        Effect.tapCause((cause) => shutdown(Exit.failCause(cause))),
        Effect.withSpan('@livestore/adapter-web:single-tab:setupInnerWorker'),
      )

      // Helper to run requests against the worker
      const runInWorker = <A, E, R>(
        tag: string,
        effect: Effect.Effect<A, E, R>,
      ): Effect.Effect<A, WithoutRpcClientError<E>, R> =>
        effect.pipe(
          dieOnRpcClientError,
          Effect.logWarnIfTakesLongerThan({
            label: `@livestore/adapter-web:single-tab:runInWorker:${tag}`,
            duration: 2000,
          }),
          Effect.withSpan(`@livestore/adapter-web:single-tab:runInWorker:${tag}`),
        )

      const runInWorkerStream = <A, E, R>(
        tag: string,
        stream: Stream.Stream<A, E, R>,
      ): Stream.Stream<A, WithoutRpcClientError<E>, R> =>
        stream.pipe(
          dieOnRpcClientErrorStream,
          Stream.withSpan(`@livestore/adapter-web:single-tab:runInWorkerStream:${tag}`),
        )

      // Forward boot status from worker
      const bootStatusFiber = yield* runInWorkerStream('BootStatusStream', innerWorker.BootStatusStream({})).pipe(
        Stream.tap((_) => Queue.offer(bootStatusQueue, _)),
        Stream.runDrain,
        Effect.tapCause((cause) =>
          Cause.hasInterruptsOnly(cause) === true ? Effect.void : shutdown(Exit.failCause(cause)),
        ),
        Effect.interruptible,
        Effect.tapCauseLogPretty,
        Effect.forkScoped,
      )

      yield* Queue.await(bootStatusQueue).pipe(
        Effect.andThen(Fiber.interrupt(bootStatusFiber)),
        Effect.interruptible,
        Effect.tapCauseLogPretty,
        Effect.forkScoped,
      )

      // Get initial snapshot (either from fast-path or from worker)
      const { sqliteDb, snapshotByteLength, migrationsReport, pull } = yield* openSnapshotSession({
        expectedProjection: StateSnapshot.getProjectionIdentity(schema),
        candidate: dataFromFile,
        makeSqliteDb,
        open: (request) => runInWorkerStream('OpenSession', innerWorker.OpenSession(request)),
      })

      const numberOfTables =
        sqliteDb.select<{ count: number }>(`select count(*) as count from sqlite_master`)[0]?.count ?? 0
      if (numberOfTables === 0) {
        return yield* UnknownError.make({
          cause: `Encountered empty or corrupted database`,
          payload: { snapshotByteLength, storageOptions: options.storage },
        })
      }

      // The state snapshot carries its own cursor, so the fast path does not
      // need to export or transfer the eventlog database.
      const stateHead = yield* StateHead.make.pipe(Effect.provideService(StateSqliteDb.StateSqliteDb, sqliteDb))
      const initialLeaderHead = yield* stateHead.get

      yield* Effect.addFinalizer((ex: Exit.Exit<unknown, unknown>) =>
        Effect.gen(function* () {
          if (Exit.isFailure(ex) === true) {
            const cause = ex.cause
            if (
              Exit.hasInterrupts(ex) === false &&
              Schema.is(IntentionalShutdownCause)(Cause.squash(cause)) === false &&
              Schema.is(StoreInterrupted)(Cause.squash(cause)) === false
            ) {
              yield* Effect.logError('[@livestore/adapter-web:single-tab] client-session shutdown', cause)
              return
            }
          }

          yield* Effect.logDebug('[@livestore/adapter-web:single-tab] client-session shutdown', ex)
        }).pipe(Effect.tapCauseLogPretty, Effect.orDie),
      )

      const leaderThread: ClientSession['leaderThread'] = {
        export: runInWorker('Export', innerWorker.Export({})).pipe(
          Effect.timeoutOrDie(10_000),
          Effect.withSpan('@livestore/adapter-web:single-tab:export'),
        ),

        events: {
          pull: () => pull,
          push: (batch) =>
            runInWorker('PushToLeader', innerWorker.PushToLeader({ batch })).pipe(
              Effect.withSpan('@livestore/adapter-web:single-tab:pushToLeader', {
                attributes: { batchSize: batch.length },
              }),
            ),
          stream: (options) =>
            runInWorkerStream('StreamEvents', innerWorker.StreamEvents(options)).pipe(
              Stream.withSpan('@livestore/adapter-web:single-tab:streamEvents'),
              Stream.orDie,
            ),
        },

        initialState: {
          leaderHead: initialLeaderHead,
          migrationsReport,
          storageMode: opfsWarning === undefined ? 'persisted' : 'in-memory',
        },

        getEventlogData: runInWorker('ExportEventlog', innerWorker.ExportEventlog({})).pipe(
          Effect.timeoutOrDie(10_000),
          Effect.withSpan('@livestore/adapter-web:single-tab:getEventlogData'),
        ),

        syncState: Subscribable.make({
          get: runInWorker('GetLeaderSyncState', innerWorker.GetLeaderSyncState({})).pipe(
            Effect.withSpan('@livestore/adapter-web:single-tab:getLeaderSyncState'),
          ),
          changes: runInWorkerStream('SyncStateStream', innerWorker.SyncStateStream({})).pipe(Stream.orDie),
        }),

        sendDevtoolsMessage: (_message) =>
          // Devtools not supported in single-tab mode
          Effect.void,

        networkStatus: Subscribable.make({
          get: runInWorker('GetNetworkStatus', innerWorker.GetNetworkStatus({})).pipe(Effect.orDie),
          changes: runInWorkerStream('NetworkStatusStream', innerWorker.NetworkStatusStream({})).pipe(Stream.orDie),
        }),
      }

      const clientSession = yield* makeClientSession({
        ...adapterArgs,
        sqliteDb,
        lockStatus,
        clientId,
        sessionId,
        isLeader: true, // Always leader in single-tab mode
        leaderThread,
        webmeshMode: 'direct',
        origin: globalThis.location?.origin,
        // No webmesh connection in single-tab mode (devtools disabled)
        connectWebmeshNode: () => Effect.void,
        registerBeforeUnload: (onBeforeUnload) => {
          if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
            window.addEventListener('beforeunload', onBeforeUnload)
            return () => window.removeEventListener('beforeunload', onBeforeUnload)
          }
          return () => {}
        },
      })

      return clientSession
    }).pipe(Effect.provide(Opfs.layer), mapToAdapterError)

/** Persists clientId/sessionId to storage */
