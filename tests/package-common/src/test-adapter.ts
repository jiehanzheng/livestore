import { mapToAdapterError, type AdapterError, type SourceIdentity } from '@livestore/common'
import {
  type Adapter,
  type AdapterArgs,
  ClientSessionLeaderThreadProxy,
  type LockStatus,
  type MakeSqliteDb,
  makeClientSession,
  migrateDb,
  type SqliteDb,
  type SqliteError,
  StateHead,
  StateSnapshot,
  StateSqliteDb,
  type SyncOptions,
  UnknownError,
} from '@livestore/common'
import {
  configureConnection,
  Eventlog,
  LeaderThreadCtx,
  makeLeaderThreadLayer,
  ShutdownChannel,
  streamEventsWithSyncState,
} from '@livestore/common/leader-thread'
import type { LiveStoreSchema } from '@livestore/common/schema'
import { LiveStoreEvent } from '@livestore/common/schema'
import { loadSqlite3Wasm } from '@livestore/sqlite-wasm/load-wasm'
import { sqliteDbFactory } from '@livestore/sqlite-wasm/node'
import { omitUndefineds } from '@livestore/utils'
import {
  Effect,
  Deferred,
  Exit,
  FetchHttpClient,
  Layer,
  Queue,
  Result,
  Stream,
  SubscriptionRef,
  WebChannel,
  type Schema,
  type Scope,
} from '@livestore/utils/effect'
import { PlatformNode } from '@livestore/utils/node'

import { makeSqliteServicesLayer } from './leader-thread/fixture.ts'

export type TestingOverrides = {
  clientSession?: {
    leaderThreadProxy?: (
      original: ClientSessionLeaderThreadProxy.ClientSessionLeaderThreadProxy,
    ) => Partial<ClientSessionLeaderThreadProxy.ClientSessionLeaderThreadProxy>
  }
  makeLeaderThread?: (makeSqliteDb: MakeSqliteDb) => Effect.Effect<
    {
      dbEventlog: SqliteDb
      dbState: SqliteDb
      initializedSource: SourceIdentity.InitializedSource
    },
    AdapterError | SqliteError,
    Scope.Scope
  >
}

export const makeTestAdapter = ({
  clientId = 'test-client',
  sessionId = 'static',
  sync,
  importSnapshot,
  testing,
}: {
  clientId?: string
  sessionId?: string
  sync?: SyncOptions
  importSnapshot?: Uint8Array<ArrayBuffer>
  testing?: { overrides?: TestingOverrides; snapshotAdmission?: boolean }
} = {}): Adapter =>
  ((adapterArgs) =>
    Effect.gen(function* () {
      const { schema, storeId, syncPayloadEncoded, syncPayloadSchema, params } = adapterArgs
      const sqlite3 = yield* Effect.promise(() => loadSqlite3Wasm())
      const makeSqliteDb = yield* sqliteDbFactory({ sqlite3 })
      const shutdownChannel = yield* makeShutdownChannel(storeId)
      yield* shutdownChannel.listen.pipe(
        Stream.mapEffect(Effect.fromResult),
        Stream.tap((cause) =>
          adapterArgs.shutdown(cause._tag === 'IntentionalShutdownCause' ? Exit.succeed(cause) : Exit.fail(cause)),
        ),
        Stream.runDrain,
        Effect.interruptible,
        Effect.tapCauseLogPretty,
        Effect.forkScoped,
      )
      const syncInMemoryDb = yield* makeSqliteDb({ _tag: 'in-memory' }).pipe(Effect.orDie)
      const lockStatus = yield* SubscriptionRef.make<LockStatus>('has-lock')

      const {
        leaderThread: originalLeaderThread,
        initialSnapshot,
        openSession,
      } = yield* makeLocalLeaderThread({
        storeId,
        clientId,
        schema,
        makeSqliteDb,
        syncOptions: sync,
        syncPayloadEncoded,
        syncPayloadSchema,
        params,
        testing,
        shutdownChannel,
      }).pipe(mapToAdapterError)

      let leaderThread = originalLeaderThread
      syncInMemoryDb.import(importSnapshot ?? initialSnapshot)
      if (importSnapshot !== undefined) {
        yield* migrateDb({ db: syncInMemoryDb, schema })
      }
      if (testing?.snapshotAdmission === true) {
        // Exercise the browser's atomic owner admission without changing explicit manual-seed test semantics.
        const { admission, queue } = yield* openSession({
          expectedProjection: StateSnapshot.getProjectionIdentity(schema),
          candidate: StateSnapshot.readProvenance(syncInMemoryDb),
        })
        if (admission._tag === 'StaleSnapshot') syncInMemoryDb.import(admission.snapshot)
        const stateHead = yield* StateHead.make.pipe(Effect.provideService(StateSqliteDb.StateSqliteDb, syncInMemoryDb))
        leaderThread = {
          ...leaderThread,
          initialState: {
            ...leaderThread.initialState,
            leaderHead: yield* stateHead.get.pipe(mapToAdapterError),
          },
          events: {
            ...leaderThread.events,
            pull: () =>
              Stream.fromQueue(queue).pipe(Stream.concat(Stream.die(new Error('Admitted test leader ended')))),
          },
        }
      }
      syncInMemoryDb.debug.head = leaderThread.initialState.leaderHead

      return yield* makeClientSession({
        ...adapterArgs,
        sqliteDb: syncInMemoryDb,
        webmeshMode: 'proxy',
        connectWebmeshNode: () => Effect.void,
        leaderThread,
        lockStatus,
        clientId,
        sessionId,
        isLeader: true,
        registerBeforeUnload: () => () => {},
        origin: undefined,
      })
    }).pipe(
      Effect.withSpan('@local/tests-package-common:test-adapter'),
      Effect.provide(Layer.mergeAll(PlatformNode.NodeFileSystem.layer, FetchHttpClient.layer)),
    )) satisfies Adapter

const makeLocalLeaderThread = ({
  storeId,
  clientId,
  schema,
  makeSqliteDb,
  syncOptions,
  syncPayloadEncoded,
  syncPayloadSchema,
  params,
  testing,
  shutdownChannel,
}: {
  storeId: string
  clientId: string
  schema: LiveStoreSchema
  makeSqliteDb: MakeSqliteDb
  syncOptions: SyncOptions | undefined
  syncPayloadEncoded: Schema.Json | undefined
  syncPayloadSchema: Schema.Decoder<Schema.Json> | undefined
  params: AdapterArgs['params']
  testing?: { overrides?: TestingOverrides; snapshotAdmission?: boolean }
  shutdownChannel: ShutdownChannel.ShutdownChannel
}) =>
  Effect.gen(function* () {
    const services = yield* Effect.context()

    const databases =
      testing?.overrides?.makeLeaderThread !== undefined
        ? yield* testing.overrides.makeLeaderThread(makeSqliteDb)
        : yield* Effect.gen(function* () {
            const makeDb = () =>
              makeSqliteDb({
                _tag: 'in-memory',
                configureDb: (db: SqliteDb) =>
                  configureConnection(db, { foreignKeys: true }).pipe(Effect.runSyncWith(services)),
              })
            const dbEventlog = yield* makeDb()
            const initializedSource = yield* Eventlog.initializeSource(dbEventlog, { sourceIsNew: true })
            const dbState = yield* makeDb()
            return { dbState, dbEventlog, initializedSource }
          })
    const { dbState, dbEventlog, initializedSource } = databases

    const layer = yield* Layer.build(
      makeLeaderThreadLayer({
        initializedSource,
        schema,
        storeId,
        clientId,
        makeSqliteDb,
        syncOptions,
        devtoolsOptions: { enabled: false },
        shutdownChannel,
        syncPayloadEncoded,
        syncPayloadSchema,
        params,
      }).pipe(Layer.provide(makeSqliteServicesLayer({ dbState, dbEventlog }))),
    )

    return yield* Effect.gen(function* () {
      const { syncProcessor, extraIncomingMessagesQueue, initialState, networkStatus, exportSnapshot } =
        yield* LeaderThreadCtx

      const initialLeaderHead = Eventlog.getClientHeadFromDb(dbEventlog)

      const leaderThread = ClientSessionLeaderThreadProxy.of(
        {
          events: {
            pull: ({ cursor }) => syncProcessor.pull({ cursor }),
            push: syncProcessor.push,
            stream: (options) =>
              streamEventsWithSyncState({
                dbEventlog,
                syncState: syncProcessor.syncState,
                options,
              }),
          },
          initialState: {
            leaderHead: initialLeaderHead,
            migrationsReport: initialState.migrationsReport,
            storageMode: 'in-memory',
          },
          export: exportSnapshot,
          getEventlogData: Effect.sync(() => dbEventlog.export()),
          syncState: syncProcessor.syncState,
          sendDevtoolsMessage: (message) => Queue.offer(extraIncomingMessagesQueue, message),
          networkStatus,
        },
        { ...omitUndefineds({ overrides: testing?.overrides?.clientSession?.leaderThreadProxy }) },
      )

      return { leaderThread, initialSnapshot: dbState.export(), openSession: syncProcessor.openSession }
    }).pipe(Effect.provide(layer))
  })

const makeShutdownChannel = (storeId: string): Effect.Effect<ShutdownChannel.ShutdownChannel, never, Scope.Scope> =>
  Effect.gen(function* () {
    const queue = yield* Queue.unbounded<typeof ShutdownChannel.All.Type>()
    const closedDeferred = yield* Deferred.make<void>()

    return {
      [WebChannel.WebChannelSymbol]: WebChannel.WebChannelSymbol,
      send: (message) => Queue.offer(queue, message),
      listen: Stream.fromQueue(queue).pipe(Stream.map(Result.succeed)),
      closedDeferred,
      shutdown: Queue.shutdown(queue).pipe(Effect.asVoid),
      schema: {
        listen: ShutdownChannel.All,
        send: ShutdownChannel.All,
      },
      supportsTransferables: false,
      debugInfo: { storeId },
    } satisfies ShutdownChannel.ShutdownChannel
  }).pipe(Effect.withSpan('@local/tests-package-common:test-adapter:shutdown-channel', { attributes: { storeId } }))
