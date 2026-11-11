import { mapToAdapterError, type AdapterError } from '@livestore/common'
import { Deferred, Effect, Layer, RpcClientError, RpcWorker, Schema, Stream, Worker } from '@livestore/utils/effect'
import { BrowserWorker } from '@livestore/utils/effect/browser'
import type * as WebmeshWorker from '@livestore/webmesh/worker'

import type { PhysicalWorkerLifetime } from './physical-worker-lifetime.ts'
import { LeaderWorkerOuterInitialMessage } from './worker-schema.ts'

/** The outer channel only sends bootstrap. Own its send failure directly, before any inner RPC exists. */
export const startDedicatedWorker = (
  {
    transport,
    lifetime,
    close,
  }: {
    readonly transport: MessagePort | globalThis.Worker
    readonly lifetime: Pick<PhysicalWorkerLifetime, 'initialPort' | 'start'>
    readonly close: Effect.Effect<void>
  },
  { storeId, clientId }: { readonly storeId: string; readonly clientId: string },
) =>
  Effect.gen(function* () {
    const channel = yield* Effect.acquireRelease(
      Effect.sync(() => new MessageChannel()),
      ({ port1, port2 }) =>
        Effect.sync(() => {
          port1.close()
          port2.close()
        }),
    )
    const transportContext = yield* Layer.build(BrowserWorker.layer(() => transport))
    // This is the same pinned platform the RPC layer uses. Bootstrap needs its send result before any request IDs exist.
    // @effect-diagnostics-next-line unstableApiUsage:off
    const sender = yield* Worker.WorkerPlatform.use((platform) =>
      platform.spawn<unknown, RpcWorker.InitialMessage.Encoded>(0),
    ).pipe(Effect.provide(transportContext))
    const failed = yield* Deferred.make<never, AdapterError>()
    const sendInitial = RpcWorker.makeInitialMessage(
      LeaderWorkerOuterInitialMessage.payloadSchema,
      lifetime.initialPort.pipe(
        Effect.map((lifetimePort) => ({ port: channel.port1, lifetimePort, storeId, clientId })),
      ),
    ).pipe(
      Effect.flatMap(([value, transfers]) => sender.send({ _tag: 'InitialMessage', value }, transfers)),
      Effect.orDie,
    )
    yield* sender
      .run(() => Effect.void, { onSpawn: sendInitial })
      .pipe(
        mapToAdapterError,
        Effect.tapCause((cause) => Deferred.failCause(failed, cause)),
        Effect.forkScoped,
      )
    // Join physical close before the sender scope tells the receiver to stop.
    yield* Effect.addFinalizer(() => close)
    yield* Effect.raceFirst(lifetime.start, Deferred.await(failed))
    return channel.port2
  }).pipe(mapToAdapterError)

export type WebmeshWorkerProxy = Parameters<typeof WebmeshWorker.connectViaWorker>[0]['worker']
export type WithoutRpcClientError<E> = E extends { readonly _tag: infer Tag }
  ? 'RpcClientError' extends Tag
    ? never
    : E
  : E
export type WebmeshWorkerRpcClient = {
  readonly ['WebmeshWorker.CreateConnection']: (
    request: typeof WebmeshWorker.Schema.CreateConnection.Type,
  ) => Stream.Stream<{}, RpcClientError.RpcClientError | AdapterError>
}

export const isRpcClientError = (error: unknown): error is RpcClientError.RpcClientError =>
  Schema.is(RpcClientError.RpcClientError)(error)

export const dieOnRpcClientError = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, WithoutRpcClientError<E>, R> =>
  (effect as Effect.Effect<A, RpcClientError.RpcClientError | WithoutRpcClientError<E>, R>).pipe(
    Effect.catchIf(isRpcClientError, (error) => Effect.die(error)),
  ) as Effect.Effect<A, WithoutRpcClientError<E>, R>

export const dieOnRpcClientErrorStream = <A, E, R>(
  stream: Stream.Stream<A, E, R>,
): Stream.Stream<A, WithoutRpcClientError<E>, R> =>
  (stream as Stream.Stream<A, RpcClientError.RpcClientError | WithoutRpcClientError<E>, R>).pipe(
    Stream.catchIf(
      isRpcClientError,
      (error) => Stream.die(error),
      (error) => Stream.fail(error),
    ),
  ) as Stream.Stream<A, WithoutRpcClientError<E>, R>

export const makeWebmeshWorkerProxy = (client: WebmeshWorkerRpcClient): WebmeshWorkerProxy => ({
  // Webmesh channels have a terminal defect contract; boot/admission RPCs preserve their typed refusals separately.
  execute: (request) => dieOnRpcClientErrorStream(client['WebmeshWorker.CreateConnection'](request)).pipe(Stream.orDie),
})
