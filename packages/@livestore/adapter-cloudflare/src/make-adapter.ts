import {
  type Adapter,
  ClientSessionLeaderThreadProxy,
  EventlogSqliteDb,
  type LockStatus,
  liveStoreStorageFormatVersion,
  makeClientSession,
  MaterializationJournal,
  mapToAdapterError,
  SourceIdentity,
  type SqliteDb,
  type SqliteTransactionHost,
  toAdapterError,
  StateSqliteDb,
  type SyncOptions,
  UnknownError,
  StateHead,
} from '@livestore/common'
import type { CfTypes } from '@livestore/common-cf'
import {
  type DevtoolsOptions,
  Eventlog,
  LeaderThreadCtx,
  makeLeaderThreadLayer,
  streamEventsWithSyncState,
} from '@livestore/common/leader-thread'
import { getStateDbBaseName } from '@livestore/common/schema'
import { LiveStoreEvent } from '@livestore/livestore'
import { CF_SQL_VFS_REQUIRED_PRAGMAS, sqliteDbFactory } from '@livestore/sqlite-wasm/cf'
import { loadSqlite3Wasm } from '@livestore/sqlite-wasm/load-wasm'
import { Effect, FetchHttpClient, Layer, Queue, SubscriptionRef, WebChannel } from '@livestore/utils/effect'

import { makeSqliteDb as makeDoSqliteDb } from './make-sqlite-db.ts'
import * as StateFiles from './state-files.ts'
import { makeTransactionHost } from './transaction-host.ts'

export const makeAdapter =
  ({
    storage,
    clientId,
    syncOptions,
    sessionId,
    resetPersistence = false,
  }: {
    storage: CfTypes.DurableObjectStorage
    clientId: string
    syncOptions: SyncOptions
    sessionId: string
    resetPersistence?: boolean
  }): Adapter =>
  (adapterArgs) =>
    Effect.gen(function* () {
      const {
        storeId,
        /* devtoolsEnabled, shutdown, bootStatusQueue,  */
        syncPayloadEncoded,
        syncPayloadSchema,
        schema,
        params,
      } = adapterArgs

      const devtoolsOptions = { enabled: false } as DevtoolsOptions

      // Storage.sql also contains application/KV data; only retained SDK storage disproves a new source.
      const sourceIsNew = yield* Effect.try({
        try: () =>
          !storage.sql
            .exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
            .toArray()
            .some(
              ({ name }) =>
                name === 'eventlog' ||
                name.startsWith('__livestore_') ||
                name === 'vfs_pages' ||
                name === 'vfs_files' ||
                name === 'vfs_blocks',
            ),
        catch: toAdapterError,
      })
      let stateToClose: SqliteDb | undefined
      const transactionHost = makeTransactionHost(storage, () => stateToClose?.close())
      const dbEventlog = yield* Effect.acquireRelease(
        makeDoSqliteDb({
          _tag: 'file',
          db: storage.sql,
          configureDb: () => {},
        }),
        (db) => Effect.sync(() => db.close()),
      ).pipe(mapToAdapterError)
      dbEventlog.transactionHost = transactionHost
      let initializedSource = yield* Eventlog.initializeSource(dbEventlog, { sourceIsNew })
      if (resetPersistence === true) {
        yield* resetDurableObjectPersistence({ storage, storeId, dbEventlog, transactionHost })
        initializedSource = yield* Eventlog.initializeSource(dbEventlog, { sourceIsNew: false })
      }

      const sqlite3 = yield* Effect.promise(() => loadSqlite3Wasm())
      const makeSqliteDb = sqliteDbFactory({ sqlite3 })
      const syncInMemoryDb = yield* Effect.acquireRelease(
        makeSqliteDb({ _tag: 'in-memory', configureDb: () => {} }),
        (db) => Effect.sync(() => db.close()),
      ).pipe(mapToAdapterError)

      const stateFileName = `${getStateDbBaseName(schema)}@${liveStoreStorageFormatVersion}.db`
      const { leaderThread, initialSnapshot } = yield* transactionHost.runTransaction(
        Effect.gen(function* () {
          yield* StateFiles.register(storage, stateFileName).pipe(UnknownError.mapToUnknownError)

          const dbState = yield* Effect.acquireRelease(
            makeSqliteDb({
              _tag: 'storage',
              storage,
              fileName: stateFileName,
              configureDb: (db) =>
                db.execute([...CF_SQL_VFS_REQUIRED_PRAGMAS, 'cache_size=-8000'].map((p) => `PRAGMA ${p}`).join(';\n')),
            }),
            (db) => Effect.sync(() => db.close()),
          ).pipe(mapToAdapterError)
          stateToClose = dbState
          dbState.transactionHost = transactionHost

          const shutdownChannel = yield* WebChannel.noopChannel<any, any>()
          const sqliteDbLayer = Layer.mergeAll(StateSqliteDb.layer(dbState), EventlogSqliteDb.layer(dbEventlog))
          const stateServicesLayer = Layer.mergeAll(StateHead.layer, MaterializationJournal.layer).pipe(
            Layer.provide(sqliteDbLayer),
          )

          const layer = yield* Layer.build(
            makeLeaderThreadLayer({
              initializedSource,
              schema,
              storeId,
              clientId,
              makeSqliteDb,
              syncOptions,
              devtoolsOptions,
              shutdownChannel,
              syncPayloadEncoded,
              syncPayloadSchema,
              params,
            }).pipe(Layer.provide(Layer.mergeAll(sqliteDbLayer, stateServicesLayer))),
          )

          return yield* Effect.gen(function* () {
            const { syncProcessor, extraIncomingMessagesQueue, initialState, networkStatus, exportSnapshot } =
              yield* LeaderThreadCtx

            const initialLeaderHead = Eventlog.getClientHeadFromDb(dbEventlog)
            // const initialLeaderHead = EventSequenceNumber.ROOT

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
                  storageMode: 'persisted',
                },
                export: exportSnapshot,
                getEventlogData: Effect.sync(() => dbEventlog.export()),
                syncState: syncProcessor.syncState,
                sendDevtoolsMessage: (message) => Queue.offer(extraIncomingMessagesQueue, message),
                networkStatus,
              },
              {
                // overrides: testing?.overrides?.clientSession?.leaderThreadProxy
              },
            )

            const initialSnapshot = yield* exportSnapshot

            return { leaderThread, initialSnapshot }
          }).pipe(Effect.provide(layer))
        }),
      )

      syncInMemoryDb.import(initialSnapshot)

      const lockStatus = yield* SubscriptionRef.make<LockStatus>('has-lock')

      const clientSession = yield* makeClientSession({
        ...adapterArgs,
        sqliteDb: syncInMemoryDb,
        webmeshMode: 'proxy',
        connectWebmeshNode: Effect.fnUntraced(function* ({ webmeshNode }) {
          if (devtoolsOptions.enabled === true) {
            console.log('connectWebmeshNode', { webmeshNode })
            //   yield* Webmesh.connectViaWebSocket({
            //     node: webmeshNode,
            //     url: `ws://${devtoolsOptions.host}:${devtoolsOptions.port}`,
            //     openTimeout: 500,
            //   }).pipe(Effect.tapCauseLogPretty, Effect.forkScoped)
          }
        }),
        leaderThread,
        lockStatus,
        clientId,
        sessionId,
        isLeader: true,
        // Not really applicable for node as there is no "reload the app" concept
        registerBeforeUnload: (_onBeforeUnload) => () => {},
        origin: undefined,
      })

      yield* StateFiles.cleanup(storage, stateFileName).pipe(
        Effect.catch((cause) => Effect.logWarning('Failed to clean up obsolete state databases', cause)),
      )

      return clientSession
    }).pipe(
      Effect.withSpan('@livestore/adapter-cloudflare:makeAdapter', { attributes: { clientId, sessionId } }),
      Effect.provide(FetchHttpClient.layer),
      mapToAdapterError,
    )

const resetDurableObjectPersistence = ({
  storage,
  storeId,
  dbEventlog,
  transactionHost,
}: {
  storage: CfTypes.DurableObjectStorage
  storeId: string
  dbEventlog: SqliteDb
  transactionHost: SqliteTransactionHost
}) =>
  transactionHost
    .runTransaction(
      Effect.try({
        try: () => {
          // Source was validated before this destructive option; identity rotation invalidates every old derived image.
          safeSqlExec(storage, 'DELETE FROM vfs_pages')
          safeSqlExec(storage, 'DELETE FROM __livestore_state_files')
          dbEventlog.execute('DELETE FROM eventlog')
          dbEventlog.execute('DELETE FROM __livestore_sync_status')
          dbEventlog.execute('INSERT INTO __livestore_sync_status (head) VALUES (0)')
          SourceIdentity.rotateWithinTransaction(dbEventlog)
        },
        catch: toAdapterError,
      }),
    )
    .pipe(Effect.withSpan('@livestore/adapter-cloudflare:resetPersistence', { attributes: { storeId } }))

const safeSqlExec = (storage: CfTypes.DurableObjectStorage, query: string, binding?: string) => {
  try {
    binding !== undefined ? storage.sql.exec(query, binding) : storage.sql.exec(query)
  } catch (error) {
    if (isMissingTableError(error) === true) {
      return
    }

    throw error
  }
}

const isMissingTableError = (error: unknown): boolean =>
  error instanceof Error && error.message.toLowerCase().includes('no such table')
