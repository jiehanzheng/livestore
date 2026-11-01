import {
  makeClientSession,
  type Adapter,
  type LockStatus,
  type SyncOptions,
  UnknownError,
  mapToAdapterError,
} from '@livestore/common'
import { loadSqlite3Wasm } from '@livestore/sqlite-wasm/load-wasm'
import { sqliteDbFactory } from '@livestore/sqlite-wasm/node'
import { Effect, FetchHttpClient, Layer, Queue, Scope, SubscriptionRef } from '@livestore/utils/effect'
import { PlatformNode } from '@livestore/utils/node'

import { createLeader } from './leader.ts'
import type { NodeStorage } from './storage.ts'

export type NodeAdapterOptions = {
  storage: NodeStorage
  clientId: string
  sessionId?: string
  sync?: SyncOptions
}

export const makeAdapter = function ({ storage, clientId, sessionId = 'static', sync }: NodeAdapterOptions): Adapter {
  return (args) =>
    Effect.gen(function* () {
      if (typeof clientId !== 'string' || clientId.trim().length === 0)
        return yield* new UnknownError({ cause: 'Adapter requires an explicit stable clientId.' })
      if (args.devtoolsEnabled === true)
        return yield* new UnknownError({
          cause: 'The Node validation adapter does not support LiveStore DevTools; set disableDevtools: true.',
        })
      yield* Queue.offer(args.bootStatusQueue, { stage: 'loading' })
      const sqlite3 = yield* Effect.promise(() => loadSqlite3Wasm())
      const makeSqliteDb = yield* sqliteDbFactory({ sqlite3 })
      // Register leader teardown first: Store closes its client session before
      // the co-located leader, allowing an admitted final push to finish persisting.
      const leaderScope = yield* Scope.make()
      yield* Effect.addFinalizer((exit) => Scope.close(leaderScope, exit))
      const { leaderThread, sqliteDb } = yield* createLeader(args, { storage, clientId, sync }, makeSqliteDb).pipe(
        Scope.provide(leaderScope),
      )
      const lockStatus = yield* SubscriptionRef.make<LockStatus>('has-lock')
      return yield* makeClientSession({
        ...args,
        sqliteDb,
        leaderThread,
        lockStatus,
        clientId,
        sessionId,
        isLeader: true,
        webmeshMode: 'proxy',
        connectWebmeshNode: () => Effect.void,
        registerBeforeUnload: () => () => {},
        origin: undefined,
      })
    }).pipe(mapToAdapterError, Effect.provide(Layer.mergeAll(PlatformNode.NodeFileSystem.layer, FetchHttpClient.layer)))
}
