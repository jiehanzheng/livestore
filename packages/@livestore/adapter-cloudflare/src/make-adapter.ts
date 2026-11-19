import {
  type Adapter,
  ClientSessionLeaderThreadProxy,
  EventlogSqliteDb,
  type LockStatus,
  liveStoreStorageFormatVersion,
  makeClientSession,
  MaterializationJournal,
  mapToAdapterError,
  type SqliteDb,
  toAdapterError,
  StateSqliteDb,
  type SyncOptions,
  UnknownError,
  StateHead,
} from '@livestore/common'
import type { CfTypes } from '@livestore/common-cf'
import { type DevtoolsOptions, prepareLeaderThread, streamEventsWithSyncState } from '@livestore/common/leader-thread'
import { getStateDbBaseName } from '@livestore/common/schema'
import { initializeSource, makeHostedSource, SourceIdentity, type SourceOwner } from '@livestore/common/source-db'
import { LiveStoreEvent } from '@livestore/livestore'
import { CF_SQL_VFS_REQUIRED_PRAGMAS, sqliteDbFactory } from '@livestore/sqlite-wasm/cf'
import { loadSqlite3Wasm } from '@livestore/sqlite-wasm/load-wasm'
import { Effect, FetchHttpClient, Queue, SubscriptionRef, Stream, WebChannel } from '@livestore/utils/effect'

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

      let stateToClose: SqliteDb | undefined
      const transactionHost = makeTransactionHost(storage, () => stateToClose?.close())
      const dbEventlog = yield* Effect.acquireRelease(
        Effect.gen(function* () {
          const native = yield* makeDoSqliteDb({
            _tag: 'file',
            db: storage.sql,
            configureDb: () => {},
          })
          return yield* makeHostedSource(native, {
            host: transactionHost,
            storageName: native.metadata.persistenceInfo.fileName,
            persistenceInfo: native.metadata.persistenceInfo,
          })
        }),
        (owner) => owner.close.pipe(Effect.orDie),
      ).pipe(mapToAdapterError)
      let initializedSource = yield* initializeSource(dbEventlog)
      if (resetPersistence === true) {
        yield* resetDurableObjectPersistence({ storage, storeId, dbEventlog })
        initializedSource = yield* initializeSource(dbEventlog)
      }

      const sqlite3 = yield* Effect.promise(() => loadSqlite3Wasm())
      const makeSqliteDb = sqliteDbFactory({ sqlite3 })
      const syncInMemoryDb = yield* Effect.acquireRelease(
        makeSqliteDb({ _tag: 'in-memory', configureDb: () => {} }),
        (db) => Effect.sync(() => db.close()),
      ).pipe(mapToAdapterError)

      const stateFileName = `${getStateDbBaseName(schema)}@${liveStoreStorageFormatVersion}.db`
      // Hosted SOURCE reads must stay on the fiber that owns the native rebuild transaction.
      // Live sync can write to the same host, so start it only after that transaction commits.
      const { start } = yield* transactionHost.runTransaction(
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
          const stateHead = yield* StateHead.make.pipe(Effect.provideService(StateSqliteDb.StateSqliteDb, dbState))
          const journal = yield* MaterializationJournal.make.pipe(
            Effect.provideService(StateSqliteDb.StateSqliteDb, dbState),
          )

          return yield* prepareLeaderThread({
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
          }).pipe(
            Effect.provideService(StateSqliteDb.StateSqliteDb, dbState),
            Effect.provideService(EventlogSqliteDb.EventlogSqliteDb, dbEventlog),
            Effect.provideService(StateHead.StateHead, stateHead),
            Effect.provideService(MaterializationJournal.MaterializationJournal, journal),
          )
        }),
      )

      const { syncProcessor, extraIncomingMessagesQueue, initialState, networkStatus, exportSnapshot } = yield* start
      syncInMemoryDb.import(yield* exportSnapshot)
      // Live sync may advance SOURCE before the session subscribes. Its cursor must describe the imported bytes.
      const initialLeaderHead = StateHead.readFromDb(syncInMemoryDb)
      const leaderThread = ClientSessionLeaderThreadProxy.of({
        events: {
          pull: ({ cursor }) => syncProcessor.pull({ cursor }),
          push: syncProcessor.push,
          stream: (options) =>
            streamEventsWithSyncState({
              dbEventlog,
              syncState: syncProcessor.syncState,
              options,
            }).pipe(Stream.mapError(toAdapterError)),
        },
        initialState: {
          leaderHead: initialLeaderHead,
          migrationsReport: initialState.migrationsReport,
          storageMode: 'persisted',
        },
        export: exportSnapshot,
        getEventlogData: Effect.fail(
          new UnknownError({ cause: 'Native Durable Object SOURCE image export is unsupported' }),
        ),
        syncState: syncProcessor.syncState,
        sendDevtoolsMessage: (message) => Queue.offer(extraIncomingMessagesQueue, message),
        networkStatus,
      })

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
}: {
  storage: CfTypes.DurableObjectStorage
  storeId: string
  dbEventlog: SourceOwner
}) =>
  dbEventlog
    .write((transaction) =>
      Effect.gen(function* () {
        // SOURCE validation precedes this option; all SDK namespace resets share the physical host transaction.
        yield* Effect.try({
          try: () => {
            safeSqlExec(storage, 'DELETE FROM vfs_pages')
            safeSqlExec(storage, 'DELETE FROM __livestore_state_files')
          },
          catch: toAdapterError,
        })
        yield* transaction.execute('DELETE FROM eventlog')
        yield* transaction.execute('DELETE FROM __livestore_sync_status')
        yield* transaction.execute('INSERT INTO __livestore_sync_status (head) VALUES (0)')
        yield* SourceIdentity.rotate(transaction)
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
