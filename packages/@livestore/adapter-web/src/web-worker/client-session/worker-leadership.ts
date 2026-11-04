import { liveStoreVersion, mapToAdapterError, type AdapterArgs, type LockStatus } from '@livestore/common'
import { tryAsFunctionAndNew } from '@livestore/utils'
import {
  Deferred,
  Effect,
  Exit,
  Layer,
  RpcClient,
  type RpcClientError,
  RpcWorker,
  SubscriptionRef,
} from '@livestore/utils/effect'
import { BrowserWorker, WebLock } from '@livestore/utils/effect/browser'

import { makePhysicalWorkerLifetime, type PhysicalWorkerLifetime } from '../common/physical-worker-lifetime.ts'
import {
  DedicatedWorkerDisconnectBroadcast,
  type makeWorkerDisconnectChannel,
} from '../common/worker-disconnect-channel.ts'
import * as WorkerSchema from '../common/worker-schema.ts'
import { makeLeaderElectionLock } from './leader-election-lock.ts'
import type { WebAdapterOptions } from './persisted-adapter-options.ts'

type WorkerLeadership = {
  sharedWorker: RpcClient.FromGroup<typeof WorkerSchema.SharedWorkerRpcs, RpcClientError.RpcClientError>
  lockStatus: SubscriptionRef.SubscriptionRef<LockStatus>
  waitForSharedWorkerInitialized: Deferred.Deferred<void>
  readonly isLeader: boolean
}

export const makeWorkerLeadership = Effect.fn(function* ({
  options,
  adapterArgs,
  clientId,
  sessionId,
  storageOptions,
  sharedWebWorker,
  workerDisconnectChannel,
}: {
  options: WebAdapterOptions
  adapterArgs: AdapterArgs
  clientId: string
  sessionId: string
  storageOptions: WorkerSchema.StorageType
  sharedWebWorker: SharedWorker
  workerDisconnectChannel: Effect.Success<ReturnType<typeof makeWorkerDisconnectChannel>>
}) {
  const { storeId, shutdown, devtoolsEnabled, debugInstanceId, syncPayloadEncoded, params } = adapterArgs
  const LIVESTORE_TAB_LOCK = `livestore-tab-lock-${storeId}`
  const LIVESTORE_SHARED_WORKER_TERMINATION_LOCK = `livestore-shared-worker-termination-lock-${storeId}`
  if (options.experimental?.awaitSharedWorkerTermination === true) {
    // Relying on the lock being available is currently the only mechanism we're aware of
    // to know whether the shared worker has terminated.
    yield* Effect.addFinalizer(() => WebLock.waitForLock(LIVESTORE_SHARED_WORKER_TERMINATION_LOCK))
  }

  const sharedWorkerContext = yield* Layer.build(
    RpcClient.layerProtocolWorker({ size: 1, concurrency: 100 }).pipe(
      Layer.provide(BrowserWorker.layer(() => sharedWebWorker)),
    ),
  )
  const sharedWorker = yield* RpcClient.make(WorkerSchema.SharedWorkerRpcs).pipe(
    Effect.provide(sharedWorkerContext),
    Effect.tapCauseLogPretty,
    mapToAdapterError,
    Effect.tapCause((cause) => shutdown(Exit.failCause(cause))),
    Effect.withSpan('@livestore/adapter-web:client-session:setupSharedWorker'),
  )

  let physicalLifetime: PhysicalWorkerLifetime | undefined
  const electionLock = yield* makeLeaderElectionLock(LIVESTORE_TAB_LOCK, () => physicalLifetime?.close ?? Effect.void)
  // It's important that we resolve the leader election in a blocking way, so there's always a leader.
  // Otherwise events could end up being dropped.
  //
  // Sorry for this pun ...
  let gotLocky = yield* electionLock.tryAcquire
  const lockStatus = yield* SubscriptionRef.make<LockStatus>(gotLocky === true ? 'has-lock' : 'no-lock')

  // Ideally we can come up with a simpler implementation that doesn't require this
  const waitForSharedWorkerInitialized = yield* Deferred.make<void>()
  if (gotLocky === false) {
    // Don't need to wait if we're not the leader
    yield* Deferred.succeed(waitForSharedWorkerInitialized, undefined)
  }

  const runLocked = Effect.gen(function* () {
    yield* Effect.logDebug(
      `[@livestore/adapter-web:client-session] ✅ Got lock '${LIVESTORE_TAB_LOCK}' (clientId: ${clientId}, sessionId: ${sessionId}).`,
    )

    yield* Effect.addFinalizer(() =>
      Effect.logDebug(`[@livestore/adapter-web:client-session] Releasing lock for '${LIVESTORE_TAB_LOCK}'`),
    )

    yield* SubscriptionRef.set(lockStatus, 'has-lock')

    const mc = new MessageChannel()

    // Adopt the close obligation before cancellation can escape acquisition.
    const lifetime = yield* makePhysicalWorkerLifetime.pipe(
      Effect.tap((owner) =>
        Effect.sync(() => {
          physicalLifetime = owner
        }),
      ),
      Effect.uninterruptible,
    )

    // NOTE we're adding the `storeId` to the worker name to make it unique
    // and adding the `sessionId` to make it easier to debug which session a worker belongs to in logs
    const worker = tryAsFunctionAndNew(options.worker, { name: `livestore-worker-${storeId}-${sessionId}` })

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
      Effect.withSpan('@livestore/adapter-web:client-session:setupDedicatedWorker'),
      Effect.tapCauseLogPretty,
    )

    // An older worker must not open native storage without the join protocol.
    yield* lifetime.ready

    yield* workerDisconnectChannel.send(DedicatedWorkerDisconnectBroadcast.make({}))

    yield* sharedWorker
      .UpdateMessagePort({
        port: mc.port2,
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
      .pipe(
        mapToAdapterError,
        Effect.tapCause((cause) => shutdown(Exit.failCause(cause))),
      )

    yield* Deferred.succeed(waitForSharedWorkerInitialized, undefined)

    return yield* Effect.never
  }).pipe(Effect.withSpan('@livestore/adapter-web:client-session:lock'))

  // TODO take/give up lock when tab becomes active/passive
  if (gotLocky === false) {
    yield* Effect.logDebug(
      `[@livestore/adapter-web:client-session] ⏳ Waiting for lock '${LIVESTORE_TAB_LOCK}' (sessionId: ${sessionId})`,
    )

    // TODO find a cleaner implementation for the lock handling as we don't make use of the deferred properly right now
    yield* electionLock.wait.pipe(
      Effect.andThen(() => {
        gotLocky = true
        return runLocked
      }),
      Effect.interruptible,
      Effect.tapCauseLogPretty,
      Effect.forkScoped,
    )
  } else {
    yield* runLocked.pipe(Effect.interruptible, Effect.tapCauseLogPretty, Effect.forkScoped)
  }

  const result: WorkerLeadership = {
    sharedWorker,
    lockStatus,
    waitForSharedWorkerInitialized,
    get isLeader() {
      return gotLocky
    },
  }
  return result
})
