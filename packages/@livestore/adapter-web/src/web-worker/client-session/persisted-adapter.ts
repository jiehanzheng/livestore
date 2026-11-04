import { mapToAdapterError } from '@livestore/common'
import { openSnapshotSession, StateSnapshot } from '@livestore/common'
import type { Adapter, ClientSession } from '@livestore/common'
import {
  IntentionalShutdownCause,
  makeClientSession,
  StateSqliteDb,
  StateHead,
  StoreInterrupted,
  UnknownError,
} from '@livestore/common'
// TODO bring back - this currently doesn't work due to https://github.com/vitejs/vite/issues/8427
// NOTE We're using a non-relative import here for Vite to properly resolve the import during app builds
// import LiveStoreSharedWorker from '@livestore/adapter-web/internal-shared-worker?sharedworker'
import { inMemorySqliteDbFactory } from '@livestore/sqlite-wasm/browser'
import { isDevEnv, omitUndefineds, tryAsFunctionAndNew } from '@livestore/utils'
import { Cause, Deferred, Effect, Exit, Fiber, Queue, Schema, Stream, Subscribable } from '@livestore/utils/effect'
import { Opfs } from '@livestore/utils/effect/browser'

import { makeSingleTabAdapter } from '../../single-tab/single-tab-adapter.ts'
import { checkOpfsAvailability, ensureBrowserRequirements, getPersistedId } from '../common/browser-environment.ts'
import {
  readPersistedStateDbFromClientSession,
  resetPersistedDataFromClientSession,
} from '../common/persisted-sqlite.ts'
import {
  type WithoutRpcClientError,
  dieOnRpcClientError,
  dieOnRpcClientErrorStream,
  makeWebmeshWorkerProxy,
} from '../common/rpc-worker.ts'
import { makeShutdownChannel } from '../common/shutdown-channel.ts'
import { makeWorkerDisconnectChannel } from '../common/worker-disconnect-channel.ts'
import * as WorkerSchema from '../common/worker-schema.ts'
import { connectWebmeshNodeClientSession } from './client-session-devtools.ts'
import type { WebAdapterOptions } from './persisted-adapter-options.ts'
import { loadInMemorySqlite3 } from './sqlite-loader.ts'
import { makeWorkerLeadership } from './worker-leadership.ts'

/**
 * Checks if SharedWorker API is available in the current browser context.
 *
 * Returns false on Android Chrome and other browsers without SharedWorker support.
 *
 * @see https://github.com/livestorejs/livestore/issues/321
 * @see https://issues.chromium.org/issues/40290702
 */
export const canUseSharedWorker = (): boolean => typeof SharedWorker !== 'undefined'

if (isDevEnv() === true) {
  globalThis.__debugLiveStoreUtils = {
    ...globalThis.__debugLiveStoreUtils,
    opfs: Opfs.debugUtils,
  }
}

export type { WebAdapterOptions } from './persisted-adapter-options.ts'

/**
 * Creates a web adapter with persistent storage (currently only supports OPFS).
 * Requires both a web worker and a shared worker.
 *
 * On browsers without SharedWorker support (e.g. Android Chrome), this adapter
 * automatically falls back to single-tab mode. In single-tab mode:
 * - Each tab runs independently with its own leader worker
 * - Multi-tab synchronization is not available
 * - Devtools are not supported
 *
 * @see https://github.com/livestorejs/livestore/issues/321 - SharedWorker tracking issue
 * @see https://issues.chromium.org/issues/40290702 - Chromium SharedWorker bug
 *
 * @example
 * ```ts
 * import { makePersistedAdapter } from '@livestore/adapter-web'
 * import LiveStoreWorker from './livestore.worker.ts?worker'
 * import LiveStoreSharedWorker from '@livestore/adapter-web/shared-worker?sharedworker'
 *
 * const adapter = makePersistedAdapter({
 *   worker: LiveStoreWorker,
 *   sharedWorker: LiveStoreSharedWorker,
 *   storage: { type: 'opfs' },
 * })
 * ```
 */
export const makePersistedAdapter =
  (options: WebAdapterOptions): Adapter =>
  (adapterArgs) =>
    Effect.gen(function* () {
      // Check SharedWorker availability first and fall back to single-tab mode if unavailable
      if (canUseSharedWorker() === false) {
        yield* Effect.logWarning(
          '[@livestore/adapter-web] SharedWorker unavailable (e.g. Android Chrome). ' +
            'Falling back to single-tab mode. Multi-tab synchronization and devtools are disabled. ' +
            'See: https://github.com/livestorejs/livestore/issues/321',
        )

        return yield* makeSingleTabAdapter({
          worker: options.worker,
          storage: options.storage,
          ...omitUndefineds({
            resetPersistence: options.resetPersistence,
            clientId: options.clientId,
            sessionId: options.sessionId,
            experimental: options.experimental,
          }),
        })(adapterArgs)
      }

      const {
        schema,
        storeId,
        devtoolsEnabled,
        debugInstanceId,
        bootStatusQueue,
        shutdown,
        syncPayloadSchema: _syncPayloadSchema,
        syncPayloadEncoded,
        params,
      } = adapterArgs

      // NOTE: The schema travels with the worker bundle (developers call
      // `makeWorker({ schema, syncPayloadSchema })`). We only keep the
      // destructured value here to document availability on the client session
      // side—structured cloning the Effect schema into the worker is not
      // possible, so we intentionally do not forward it.
      void _syncPayloadSchema

      yield* ensureBrowserRequirements

      yield* Queue.offer(bootStatusQueue, { stage: 'loading' })

      const sqlite3 = yield* Effect.promise(() => loadInMemorySqlite3())
      const makeSqliteDb = yield* inMemorySqliteDbFactory({ sqlite3 })

      const storageOptions = yield* Schema.decodeEffect(WorkerSchema.StorageType)(options.storage)

      const shutdownChannel = yield* makeShutdownChannel(storeId)

      // Check OPFS availability early and notify user if storage is unavailable (e.g. private browsing)
      const opfsWarning = yield* checkOpfsAvailability
      if (opfsWarning !== undefined) {
        yield* Effect.logWarning('[@livestore/adapter-web:client-session] OPFS unavailable', opfsWarning)
      }

      if (options.resetPersistence === true && opfsWarning === undefined) {
        yield* shutdownChannel.send(IntentionalShutdownCause.make({ reason: 'adapter-reset' }))

        yield* resetPersistedDataFromClientSession({ storageOptions, storeId })
      } else if (options.resetPersistence === true) {
        yield* Effect.logWarning(
          '[@livestore/adapter-web:client-session] Skipping persistence reset because storage is unavailable',
          opfsWarning,
        )
      }

      // Note on fast-path booting:
      // Instead of waiting for the leader worker to boot and then get a database snapshot from it,
      // we're here trying to get the snapshot directly from storage
      // we usually speeds up the boot process by a lot.
      // We need to be extra careful though to not run into any race conditions or inconsistencies.
      const dataFromFile =
        options.experimental?.disableFastPath === true || opfsWarning !== undefined
          ? undefined
          : yield* readPersistedStateDbFromClientSession({ storageOptions, storeId, schema, makeSqliteDb }).pipe(
              Effect.tapError((error) =>
                Effect.logDebug('[@livestore/adapter-web:client-session] Could not read persisted state db', error, {
                  storeId,
                }),
              ),
              // If we get any error here, we return `undefined` to fall back to the slow path
              Effect.orElseSucceed(() => undefined),
            )

      // The same across all client sessions (i.e. tabs, windows)
      const clientId = options.clientId ?? getPersistedId(`clientId:${storeId}`, 'local')
      // Unique per client session (i.e. tab, window)
      const sessionId = options.sessionId ?? getPersistedId(`sessionId:${storeId}`, 'session')

      const workerDisconnectChannel = yield* makeWorkerDisconnectChannel(storeId)

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

      const sharedWebWorker = tryAsFunctionAndNew(options.sharedWorker, { name: `livestore-shared-worker-${storeId}` })

      const leadership = yield* makeWorkerLeadership({
        options,
        adapterArgs,
        clientId,
        sessionId,
        storageOptions,
        sharedWebWorker,
        workerDisconnectChannel,
      })
      const { sharedWorker, lockStatus, waitForSharedWorkerInitialized } = leadership

      const runInWorker = <A, E, R>(
        tag: string,
        effect: Effect.Effect<A, E, R>,
      ): Effect.Effect<A, WithoutRpcClientError<E>, R> =>
        Deferred.await(waitForSharedWorkerInitialized).pipe(
          // NOTE we need to wait for the shared worker to be initialized before we can send requests to it
          Effect.andThen(effect),
          dieOnRpcClientError,
          // NOTE we want to treat worker requests as atomic and therefore not allow them to be interrupted
          // Interruption usually only happens during leader re-election or store shutdown
          // Effect.uninterruptible,
          Effect.logWarnIfTakesLongerThan({
            label: `@livestore/adapter-web:client-session:runInWorker:${tag}`,
            duration: 2000,
          }),
          Effect.withSpan(`@livestore/adapter-web:client-session:runInWorker:${tag}`),
        )

      const runInWorkerStream = <A, E, R>(
        tag: string,
        stream: Stream.Stream<A, E, R>,
      ): Stream.Stream<A, WithoutRpcClientError<E>, R> =>
        Effect.gen(function* () {
          yield* Deferred.await(waitForSharedWorkerInitialized)
          return stream.pipe(
            dieOnRpcClientErrorStream,
            Stream.withSpan(`@livestore/adapter-web:client-session:runInWorkerStream:${tag}`),
          )
        }).pipe(Stream.unwrap)

      const bootStatusFiber = yield* runInWorkerStream('BootStatusStream', sharedWorker.BootStatusStream({})).pipe(
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

      // TODO maybe bring back transfering the initially created in-memory db snapshot instead of
      // re-exporting the db
      const { sqliteDb, snapshotByteLength, migrationsReport, pull } = yield* openSnapshotSession({
        expectedProjection: StateSnapshot.getProjectionIdentity(schema),
        candidate: dataFromFile,
        makeSqliteDb,
        open: (request) => runInWorkerStream('OpenSession', sharedWorker.OpenSession(request)),
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

      // console.debug('[@livestore/adapter-web:client-session] initialLeaderHead', initialLeaderHead)

      yield* Effect.addFinalizer((ex: Exit.Exit<unknown, unknown>) =>
        Effect.gen(function* () {
          if (Exit.isFailure(ex) === true) {
            const cause = ex.cause
            const shouldLogAsError =
              Exit.hasInterrupts(ex) === false &&
              Schema.is(IntentionalShutdownCause)(Cause.squash(cause)) === false &&
              Schema.is(StoreInterrupted)(Cause.squash(cause)) === false

            if (shouldLogAsError === true) {
              yield* Effect.logError('[@livestore/adapter-web:client-session] client-session shutdown', cause)
            } else {
              yield* Effect.logDebug(
                '[@livestore/adapter-web:client-session] client-session shutdown',
                leadership.isLeader,
                ex,
              )
            }
          } else {
            yield* Effect.logDebug(
              '[@livestore/adapter-web:client-session] client-session shutdown',
              leadership.isLeader,
              ex,
            )
          }
        }).pipe(Effect.tapCauseLogPretty, Effect.orDie),
      )

      const leaderThread: ClientSession['leaderThread'] = {
        export: runInWorker('Export', sharedWorker.Export({})).pipe(
          Effect.timeoutOrDie(10_000),
          Effect.withSpan('@livestore/adapter-web:client-session:export'),
        ),

        events: {
          pull: () => pull,
          push: (batch) =>
            runInWorker('PushToLeader', sharedWorker.PushToLeader({ batch })).pipe(
              Effect.withSpan('@livestore/adapter-web:client-session:pushToLeader', {
                attributes: { batchSize: batch.length },
              }),
            ),
          stream: (options) =>
            runInWorkerStream('StreamEvents', sharedWorker.StreamEvents(options)).pipe(
              Stream.withSpan('@livestore/adapter-web:client-session:streamEvents'),
              Stream.orDie,
            ),
        },

        initialState: {
          leaderHead: initialLeaderHead,
          migrationsReport,
          storageMode: opfsWarning === undefined ? 'persisted' : 'in-memory',
        },

        getEventlogData: runInWorker('ExportEventlog', sharedWorker.ExportEventlog({})).pipe(
          Effect.timeoutOrDie(10_000),
          Effect.withSpan('@livestore/adapter-web:client-session:getEventlogData'),
        ),

        syncState: Subscribable.make({
          get: runInWorker('GetLeaderSyncState', sharedWorker.GetLeaderSyncState({})).pipe(
            Effect.withSpan('@livestore/adapter-web:client-session:getLeaderSyncState'),
          ),
          changes: runInWorkerStream('SyncStateStream', sharedWorker.SyncStateStream({})).pipe(Stream.orDie),
        }),

        sendDevtoolsMessage: (message) =>
          runInWorker('ExtraDevtoolsMessage', sharedWorker.ExtraDevtoolsMessage({ message })).pipe(
            Effect.withSpan('@livestore/adapter-web:client-session:devtoolsMessageForLeader'),
          ),
        networkStatus: Subscribable.make({
          get: runInWorker('GetNetworkStatus', sharedWorker.GetNetworkStatus({})),
          changes: runInWorkerStream('NetworkStatusStream', sharedWorker.NetworkStatusStream({})),
        }),
      }

      const clientSession = yield* makeClientSession({
        ...adapterArgs,
        sqliteDb,
        lockStatus,
        clientId,
        sessionId,
        isLeader: leadership.isLeader,
        leaderThread,
        webmeshMode: 'direct',
        // Can be undefined in Node.js
        origin: globalThis.location?.origin,
        connectWebmeshNode: ({ sessionInfo, webmeshNode }) =>
          connectWebmeshNodeClientSession({
            webmeshNode,
            sessionInfo,
            sharedWorker: makeWebmeshWorkerProxy(sharedWorker),
            devtoolsEnabled,
            schema,
          }),
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
