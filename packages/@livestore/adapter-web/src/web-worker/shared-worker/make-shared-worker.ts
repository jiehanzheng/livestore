import type { LogConfig } from '@livestore/common'
import { Devtools, liveStoreVersion, UnknownError } from '@livestore/common'
import { isDevEnv, LS_DEV } from '@livestore/utils'
import {
  Cause,
  Deferred,
  Effect,
  Exit,
  FetchHttpClient,
  identity,
  Layer,
  References,
  RpcClient,
  RpcServer,
  RpcWorker,
  Schema,
  Scope,
  Semaphore,
  Stream,
  TaskTracing,
} from '@livestore/utils/effect'
import { BrowserWorker, BrowserWorkerRunner } from '@livestore/utils/effect/browser'
import * as WebmeshWorker from '@livestore/webmesh/worker'

import { dieOnRpcClientError, dieOnRpcClientErrorStream, makeWebmeshWorkerProxy } from '../common/rpc-worker.ts'
import { makeShutdownChannel } from '../common/shutdown-channel.ts'
import { makeSharedWorkerNodeName } from '../common/webmesh-node-names.ts'
import * as WorkerSchema from '../common/worker-schema.ts'
import { makeLeaderGenerations } from './leader-generations.ts'

// Extract from `livestore-shared-worker-${storeId}`
const storeId = self.name.replace('livestore-shared-worker-', '')

// We acquire a lock that is held as long as this shared worker is alive.
// This way, when the shared worker is terminated (e.g. by the browser when the page is closed),
// the lock is released and any thread waiting for the lock can be notified.
const LIVESTORE_SHARED_WORKER_TERMINATION_LOCK = `livestore-shared-worker-termination-lock-${storeId}`
navigator.locks.request(
  LIVESTORE_SHARED_WORKER_TERMINATION_LOCK,
  { steal: true },
  // We use a never-resolving promise to hold the lock
  async () => new Promise(() => {}),
)

if (isDevEnv() === true) {
  globalThis.__debugLiveStoreUtils = {
    blobUrl: (buffer: Uint8Array<ArrayBuffer>) =>
      URL.createObjectURL(new Blob([buffer], { type: 'application/octet-stream' })),
    runSync: <A, E>(effect: Effect.Effect<A, E>) => Effect.runSync(effect),
    runFork: <A, E>(effect: Effect.Effect<A, E>) => Effect.runFork(effect),
  }
}

const makeWorkerRunner = Effect.gen(function* () {
  type LeaderWorkerContext = {
    client: RpcClient.FromGroup<typeof WorkerSchema.LeaderWorkerInnerRpcs>
    scope: Scope.Closeable
  }

  const generations = yield* makeLeaderGenerations<LeaderWorkerContext>()
  const updates = yield* Semaphore.make(1)
  const waitForWorker = generations.current

  const forwardRequest = <A, E, R>(
    tag: string,
    f: (client: RpcClient.FromGroup<typeof WorkerSchema.LeaderWorkerInnerRpcs>) => Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | UnknownError, R> =>
    // Forward the request to the active worker and convert transport errors to defects.
    waitForWorker.pipe(
      Effect.flatMap(({ client }) => f(client)),
      dieOnRpcClientError,
      Effect.interruptible,
      Effect.logWarnIfTakesLongerThan({
        label: `@livestore/adapter-web:shared-worker:forwardRequest:${tag}`,
        duration: 500,
      }),
      Effect.tapCauseLogPretty,
    )

  const forwardRequestStream = <A, E, R>(
    tag: string,
    f: (client: RpcClient.FromGroup<typeof WorkerSchema.LeaderWorkerInnerRpcs>) => Stream.Stream<A, E, R>,
  ): Stream.Stream<A, E | UnknownError, R> =>
    Effect.gen(function* () {
      yield* Effect.logDebug(`forwardRequestStream: ${tag}`)
      const { client, scope } = yield* waitForWorker
      const stream = f(client).pipe(dieOnRpcClientErrorStream)
      // It seems the request stream is not automatically interrupted when the scope shuts down
      // so we need to manually interrupt it when the scope shuts down
      const shutdownDeferred = yield* Deferred.make<void>()
      yield* Scope.addFinalizer(scope, Deferred.succeed(shutdownDeferred, undefined))

      // Here we're creating an empty stream that will finish when the scope shuts down
      const scopeShutdownStream = Effect.gen(function* () {
        yield* Deferred.await(shutdownDeferred)
        return Stream.empty
      }).pipe(Stream.unwrap)

      return Stream.merge(stream, scopeShutdownStream, { haltStrategy: 'either' })
    }).pipe(
      Effect.interruptible,
      Effect.tapCauseLogPretty,
      Stream.unwrap,
      Stream.ensuring(Effect.logDebug(`shutting down stream for ${tag}`)),
    )

  // Cache first-applied invariants to enforce stability across leader transitions
  // Per-client runtime params are intentionally excluded so a new leader can apply its own tuning.
  const InvariantsSchema = Schema.Struct({
    storeId: Schema.String,
    storageOptions: WorkerSchema.StorageType,
    syncPayloadEncoded: Schema.UndefinedOr(Schema.Json),
    liveStoreVersion: Schema.Literal(liveStoreVersion),
    devtoolsEnabled: Schema.Boolean,
  })
  type Invariants = typeof InvariantsSchema.Type
  let currentInvariants: Invariants | undefined
  const sameInvariants = Schema.toEquivalence(InvariantsSchema)

  return WorkerSchema.SharedWorkerRpcs.of({
    // Whenever the client session leader changes (and thus creates a new leader thread), the new client session leader
    // sends a new MessagePort to the shared worker which proxies messages to the new leader thread.
    UpdateMessagePort: ({ port, generationToken, initial, liveStoreVersion: clientLiveStoreVersion }) => {
      let adopted = false
      return Effect.gen(function* () {
        // Enforce configuration stability across leader transitions.
        const invariants: Invariants = {
          storeId: initial.storeId,
          storageOptions: initial.storageOptions,
          syncPayloadEncoded: initial.syncPayloadEncoded,
          liveStoreVersion: clientLiveStoreVersion,
          devtoolsEnabled: initial.devtoolsEnabled,
        }
        const prev = currentInvariants
        // Early return on mismatch to keep happy path linear
        if (prev !== undefined && sameInvariants(prev, invariants) === false) {
          const diff = Schema.debugDiff(InvariantsSchema)(prev, invariants)
          return yield* new UnknownError({
            cause: 'Store invariants changed across leader transitions',
            payload: { diff, previous: prev, next: invariants },
          })
        }
        const scope = yield* Scope.make()
        yield* generations.install(
          generationToken,
          Scope.close(scope, Exit.void),
          (generation) =>
            Effect.gen(function* () {
              yield* Scope.addFinalizer(
                scope,
                Effect.sync(() => port.close()),
              )
              adopted = true
              currentInvariants = invariants
              const shutdownChannel = yield* makeShutdownChannel(initial.storeId)
              yield* shutdownChannel.listen.pipe(
                Stream.mapEffect(Effect.fromResult),
                Stream.take(1),
                Stream.tap(() =>
                  generations.retire(generation, () => {
                    currentInvariants = undefined
                  }),
                ),
                Stream.runDrain,
                Effect.tapCauseLogPretty,
                Effect.forkScoped({ startImmediately: true, uninterruptible: false }),
              )
            }).pipe(Scope.provide(scope)),
          ({ generation, previous }) =>
            Effect.gen(function* () {
              yield* generations.awaitPredecessor(previous)
              const clientContext = yield* Layer.build(
                RpcClient.layerProtocolWorker({ size: 1, concurrency: 100 }).pipe(
                  Layer.provide(BrowserWorker.layer(() => port)),
                  Layer.provide(
                    RpcWorker.layerInitialMessage(
                      WorkerSchema.LeaderWorkerInnerInitialMessage.payloadSchema,
                      Effect.succeed(initial),
                    ),
                  ),
                ),
              )
              const client = yield* RpcClient.make(WorkerSchema.LeaderWorkerInnerRpcs).pipe(
                Effect.provide(clientContext),
                Effect.withSpan('@livestore/adapter-web:shared-worker:makeWorkerProxyFromPort'),
              )

              // Prepare the web mesh connection for leader worker to be able to connect to the devtools
              const { node } = yield* WebmeshWorker.CacheService
              const { storeId, clientId } = initial

              yield* WebmeshWorker.connectViaWorker({
                node,
                worker: makeWebmeshWorkerProxy(client),
                target: Devtools.makeNodeName.client.leader({ storeId, clientId }),
              }).pipe(Effect.tapCauseLogPretty, dieOnRpcClientError, Effect.forkScoped)

              if (
                (yield* generations.publish(generation, {
                  client: client as RpcClient.FromGroup<typeof WorkerSchema.LeaderWorkerInnerRpcs>,
                  scope,
                })) === false
              ) {
                yield* generations.assertCleanup
                return yield* new UnknownError({ cause: 'Leader retired before proxy setup completed' })
              }
            }).pipe(Scope.provide(scope)),
        )
      }).pipe(
        updates.withPermit,
        Effect.onExit((exit) =>
          Exit.isFailure(exit) === true && adopted === false ? Effect.sync(() => port.close()) : Effect.void,
        ),
        UnknownError.mapToUnknownError,
        Effect.withSpan('@livestore/adapter-web:shared-worker:updateMessagePort'),
        Effect.tapCauseLogPretty,
      )
    },

    // A normal page close announces retirement before the dedicated server can interrupt OpenSession.
    // The page still owns the physical-close receipt and election lock.
    RetireLeaderGeneration: generations.retireByToken,

    // Proxied requests
    GetSourceIncarnation: ({ writeSessionId }) =>
      generations
        .runAdmittedRead(writeSessionId, ({ client }) => client.GetSourceIncarnation({}))
        .pipe(dieOnRpcClientError),
    GetSourceBackendId: ({ writeSessionId }) =>
      generations
        .runAdmittedRead(writeSessionId, ({ client }) => client.GetSourceBackendId({}))
        .pipe(dieOnRpcClientError),
    BootStatusStream: (payload) =>
      forwardRequestStream('BootStatusStream', (client) => client.BootStatusStream(payload)),
    PushAdmittedWrite: ({ writeSessionId, batch }) =>
      generations
        .runAdmittedWrite(writeSessionId, ({ client }) => client.PushToLeader({ batch }))
        .pipe(
          dieOnRpcClientError,
          Effect.interruptible,
          Effect.withSpan('@livestore/adapter-web:shared-worker:PushAdmittedWrite'),
        ),
    OpenWriteSession: ({ writeSessionId, ...payload }) =>
      generations.openSession(
        ({ client }) => dieOnRpcClientErrorStream(client.OpenSession(payload)),
        (frame) => frame._tag === 'Accepted' || frame._tag === 'StaleSnapshot',
        writeSessionId,
      ),
    PullStream: (payload) => forwardRequestStream('PullStream', (client) => client.PullStream(payload)),
    StreamEvents: (payload) => forwardRequestStream('StreamEvents', (client) => client.StreamEvents(payload)),
    Export: (payload) => forwardRequest('Export', (client) => client.Export(payload)),
    GetRecreateSnapshot: (payload) =>
      forwardRequest('GetRecreateSnapshot', (client) => client.GetRecreateSnapshot(payload)),
    ExportEventlog: (payload) => forwardRequest('ExportEventlog', (client) => client.ExportEventlog(payload)),
    GetLeaderSyncState: (payload) =>
      forwardRequest('GetLeaderSyncState', (client) => client.GetLeaderSyncState(payload)),
    SyncStateStream: (payload) => forwardRequestStream('SyncStateStream', (client) => client.SyncStateStream(payload)),
    GetLeaderHead: (payload) => forwardRequest('GetLeaderHead', (client) => client.GetLeaderHead(payload)),
    GetNetworkStatus: (payload) => forwardRequest('GetNetworkStatus', (client) => client.GetNetworkStatus(payload)),
    NetworkStatusStream: (payload) =>
      forwardRequestStream('NetworkStatusStream', (client) => client.NetworkStatusStream(payload)),
    Shutdown: (payload) => forwardRequest('Shutdown', (client) => client.Shutdown(payload)),
    ExtraDevtoolsMessage: (payload) =>
      forwardRequest('ExtraDevtoolsMessage', (client) => client.ExtraDevtoolsMessage(payload)),

    // Accept devtools connections (from leader and client sessions)
    'WebmeshWorker.CreateConnection': WebmeshWorker.CreateConnection,
  })
})

export const makeWorker = (options?: LogConfig.LoggerOptions): void => {
  const runtimeLayer = Layer.mergeAll(
    FetchHttpClient.layer,
    WebmeshWorker.CacheService.layer({ nodeName: makeSharedWorkerNodeName({ storeId }) }),
  )

  RpcServer.layer(WorkerSchema.SharedWorkerRpcs).pipe(
    Layer.provide(WorkerSchema.SharedWorkerRpcs.toLayer(makeWorkerRunner)),
    Layer.provide(RpcServer.layerProtocolWorkerRunner),
    Layer.provide(BrowserWorkerRunner.layer),
    Layer.launch,
    Effect.scoped,
    Effect.tapCauseLogPretty,
    Effect.annotateLogs({ thread: self.name }),
    Effect.provide(runtimeLayer),
    LS_DEV === true ? TaskTracing.withAsyncTaggingTracing((name) => (console as any).createTask(name)) : identity,
    Effect.provide(
      Layer.mergeAll(
        options?.logger ?? Layer.empty,
        Layer.succeed(References.MinimumLogLevel, options?.logLevel ?? (isDevEnv() === true ? 'Debug' : 'Info')),
      ),
    ),
    Effect.runFork,
  )
}

makeWorker()
