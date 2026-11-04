import type { Effect, Schema } from '@livestore/utils/effect'

import type { BootStatus, MakeInMemorySqliteDb } from '../adapter-types.ts'
import type { LiveStoreEvent, LiveStoreSchema } from '../schema/mod.ts'
import type * as SourceIdentity from '../SourceIdentity.ts'
import type { SyncOptions } from '../sync/sync.ts'
import type { ShutdownChannel } from './shutdown-channel.ts'
import type { DevtoolsOptions } from './types.ts'

export interface MakeLeaderThreadLayerParams {
  /** SDK-owned source phase must complete before constructing the derived database. */
  initializedSource: SourceIdentity.InitializedSource
  storeId: string
  syncPayloadSchema: Schema.Decoder<Schema.Json> | undefined
  syncPayloadEncoded: Schema.Json | undefined
  clientId: string
  schema: LiveStoreSchema
  makeSqliteDb: MakeInMemorySqliteDb
  syncOptions: SyncOptions | undefined
  devtoolsOptions: DevtoolsOptions
  shutdownChannel: ShutdownChannel
  /** Boot warning to emit (e.g., OPFS unavailable in private browsing) */
  bootWarning?: BootStatus
  params?: {
    localPushBatchSize?: number
    backendPushBatchSize?: number
    stateRebuildBatchSize?: number
  }
  testing?: {
    syncProcessor?: {
      delays?: {
        localPushProcessing?: Effect.Effect<void>
        backendPullReconnect?: (fallbackMs: number) => number
      }
      hooks?: {
        localPushAdmitted?: (events: ReadonlyArray<LiveStoreEvent.Client.Encoded>) => Effect.Effect<void>
        backendPullReconnectWait?: (state: { isConnected: boolean; fallbackMs: number }) => Effect.Effect<void>
        upstreamBatchReceived?: (events: ReadonlyArray<LiveStoreEvent.Client.Encoded>) => Effect.Effect<void>
      }
    }
  }
}
