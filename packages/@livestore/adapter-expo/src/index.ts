import {
  makeClientSession,
  UnknownError,
  mapToAdapterError,
  type Adapter,
  type LockStatus,
  type SyncOptions,
} from '@livestore/common'
import { Effect, FetchHttpClient, Queue, SubscriptionRef } from '@livestore/utils/effect'

import { createExpoLeader } from './leader.ts'
import type { ExpoStorage } from './paths.ts'
import { createSqliteFactory } from './sqlite.ts'

export type ExpoAdapterOptions = { clientId: string; storage?: ExpoStorage; sync?: SyncOptions }

export const makeOwnedAdapter = function (options: ExpoAdapterOptions): { adapter: Adapter; assertClosed(): void } {
  const factory = createSqliteFactory()
  let started = false
  const adapter: Adapter = (args) =>
    Effect.gen(function* () {
      if (started === true) return yield* Effect.die(new Error('Native adapter lifetime is single-use.'))
      started = true
      if (args.devtoolsEnabled === true)
        return yield* new UnknownError({
          cause: 'The native adapter does not support LiveStore devtools.',
        })
      if (options.clientId.length === 0)
        return yield* new UnknownError({ cause: 'Native adapter requires a client identity.' })
      yield* Queue.offer(args.bootStatusQueue, { stage: 'loading' })
      const lockStatus = yield* SubscriptionRef.make<LockStatus>('has-lock')
      const { leaderThread, sqliteDb } = yield* createExpoLeader(args, options, factory.makeSqliteDb)
      return yield* makeClientSession({
        ...args,
        lockStatus,
        clientId: options.clientId,
        sessionId: 'static',
        isLeader: true,
        leaderThread,
        sqliteDb,
        webmeshMode: 'proxy',
        connectWebmeshNode: () => Effect.void,
        registerBeforeUnload: () => () => {},
        origin: undefined,
      })
    }).pipe(mapToAdapterError, Effect.provide(FetchHttpClient.layer))
  return { adapter, assertClosed: () => factory.assertClosed() }
}

export const makeAdapter = (options: ExpoAdapterOptions): Adapter => makeOwnedAdapter(options).adapter
