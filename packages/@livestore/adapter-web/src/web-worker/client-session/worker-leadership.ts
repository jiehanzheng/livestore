import { liveStoreVersion, mapToAdapterError, type AdapterArgs, type LockStatus } from '@livestore/common'
import { tryAsFunctionAndNew } from '@livestore/utils'
import { Cause, Effect, Exit, Layer, RpcClient, type RpcClientError, SubscriptionRef } from '@livestore/utils/effect'
import { BrowserWorker } from '@livestore/utils/effect/browser'

import { startDedicatedWorker } from '../common/rpc-worker.ts'
import {
  DedicatedWorkerDisconnectBroadcast,
  type makeWorkerDisconnectChannel,
} from '../common/worker-disconnect-channel.ts'
import * as WorkerSchema from '../common/worker-schema.ts'
import type { WebAdapterOptions } from './persisted-adapter-options.ts'
import type { WorkerShutdown } from './worker-shutdown.ts'

type WorkerLeadership = {
  sharedWorker: RpcClient.FromGroup<typeof WorkerSchema.SharedWorkerRpcs, RpcClientError.RpcClientError>
  lockStatus: SubscriptionRef.SubscriptionRef<LockStatus>
  readonly isLeader: boolean
}

export const makeWorkerLeadership = Effect.fn(function* ({
  adapterArgs,
  options,
  clientId,
  sessionId,
  storageOptions,
  sharedWebWorker,
  workerDisconnectChannel,
  workerShutdown,
}: {
  options: WebAdapterOptions
  adapterArgs: AdapterArgs
  clientId: string
  sessionId: string
  storageOptions: WorkerSchema.StorageType
  sharedWebWorker: SharedWorker
  workerDisconnectChannel: Effect.Success<ReturnType<typeof makeWorkerDisconnectChannel>>
  workerShutdown: WorkerShutdown
}) {
  const { storeId, shutdown, devtoolsEnabled, debugInstanceId, syncPayloadEncoded, params } = adapterArgs
  const LIVESTORE_TAB_LOCK = `livestore-tab-lock-${storeId}`
  const sharedWorkerContext = yield* Layer.build(
    RpcClient.layerProtocolWorker({ size: 1, concurrency: 100 }).pipe(
      Layer.provide(BrowserWorker.layer(() => sharedWebWorker)),
    ),
  )
  const sharedWorker = yield* RpcClient.make(WorkerSchema.SharedWorkerRpcs).pipe(
    Effect.provide(sharedWorkerContext),
    Effect.tapCauseLogPretty,
    mapToAdapterError,
    Effect.withSpan('@livestore/adapter-web:client-session:setupSharedWorker'),
  )

  const electionLock = yield* workerShutdown.election(LIVESTORE_TAB_LOCK)
  // It's important that we resolve the leader election in a blocking way, so there's always a leader.
  // Otherwise events could end up being dropped.
  //
  // Sorry for this pun ...
  let gotLocky = yield* electionLock.tryAcquire
  const lockStatus = yield* SubscriptionRef.make<LockStatus>(gotLocky === true ? 'has-lock' : 'no-lock')

  const runLocked = Effect.gen(function* () {
    yield* Effect.logDebug(
      `[@livestore/adapter-web:client-session] ✅ Got lock '${LIVESTORE_TAB_LOCK}' (clientId: ${clientId}, sessionId: ${sessionId}).`,
    )

    yield* Effect.addFinalizer(() =>
      Effect.logDebug(`[@livestore/adapter-web:client-session] Releasing lock for '${LIVESTORE_TAB_LOCK}'`),
    )

    gotLocky = true
    yield* SubscriptionRef.set(lockStatus, 'has-lock')

    const worker = yield* workerShutdown.acquireWorker(() =>
      tryAsFunctionAndNew(options.worker, { name: `livestore-worker-${storeId}-${sessionId}` }),
    )
    const innerPort = yield* startDedicatedWorker(worker, { storeId, clientId }).pipe(
      Effect.withSpan('@livestore/adapter-web:client-session:setupDedicatedWorker'),
    )

    yield* workerDisconnectChannel.send(DedicatedWorkerDisconnectBroadcast.make({}))

    const generationToken = crypto.randomUUID()
    // The request may reserve the generation even if shutdown interrupts its reply.
    workerShutdown.beforePhysicalClose(sharedWorker.RetireLeaderGeneration({ generationToken }).pipe(Effect.orDie))
    yield* sharedWorker.UpdateMessagePort({
      port: innerPort,
      generationToken,
      liveStoreVersion,
      initial: {
        storageOptions,
        storeId,
        clientId,
        devtoolsEnabled,
        debugInstanceId,
        syncPayloadEncoded,
        params,
      },
    })
  }).pipe(mapToAdapterError, Effect.withSpan('@livestore/adapter-web:client-session:lock'))

  if (gotLocky === true) {
    // First open owns admission and receives the startup result directly.
    yield* runLocked
  } else {
    yield* Effect.logDebug(
      `[@livestore/adapter-web:client-session] ⏳ Waiting for lock '${LIVESTORE_TAB_LOCK}' (sessionId: ${sessionId})`,
    )

    // A follower may already have an admitted session when promotion fails.
    yield* electionLock.wait.pipe(
      Effect.andThen(runLocked),
      mapToAdapterError,
      Effect.tapCause((cause) =>
        Cause.hasInterruptsOnly(cause) === true ? Effect.void : shutdown(Exit.failCause(cause)),
      ),
      Effect.interruptible,
      Effect.tapCauseLogPretty,
      workerShutdown.forkStartup,
    )
  }

  const result: WorkerLeadership = {
    sharedWorker,
    lockStatus,
    get isLeader() {
      return gotLocky
    },
  }
  return result
})
