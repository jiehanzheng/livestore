import { expect, it } from 'vitest'

import { liveStoreVersion } from '@livestore/common'
import {
  Cause,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Rpc,
  RpcClient,
  RpcGroup,
  RpcServer,
  Schema,
  Scope,
  Semaphore,
  Stream,
} from '@livestore/utils/effect'
import { BrowserWorker } from '@livestore/utils/effect/browser'

import { makePhysicalWorkerLifetime, withPhysicalWorkerLifetime } from '../common/physical-worker-lifetime.ts'
import { dieOnRpcClientErrorStream } from '../common/rpc-worker.ts'
import { SharedWorkerRetireLeaderGeneration, SharedWorkerUpdateMessagePort } from '../common/worker-schema.ts'
import { makeMessagePortRpcServerProtocol } from '../leader-worker/message-port-rpc-protocol.ts'
import { makeLeaderGenerations } from './leader-generations.ts'

class Open extends Rpc.make('Open', { success: Schema.String, error: Schema.String, stream: true }) {}
const Rpcs = RpcGroup.make(Open)
const CoordinatorRpcs = RpcGroup.make(SharedWorkerRetireLeaderGeneration, SharedWorkerUpdateMessagePort)
type OpenStream = Stream.Stream<string, string>

const makeRpc = (response: OpenStream, closePhysical = Effect.void) =>
  Effect.gen(function* () {
    const endpoints = new MessageChannel()
    const transport = yield* Scope.make()
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        endpoints.port1.close()
        endpoints.port2.close()
      }),
    )
    yield* Effect.addFinalizer((exit) => Scope.close(transport, exit))
    const lifetime = yield* makePhysicalWorkerLifetime
    const lifetimePort = yield* lifetime.initialPort
    const physical = Effect.addFinalizer(() => closePhysical).pipe(
      Effect.andThen(
        RpcServer.make(Rpcs).pipe(
          Effect.provide(
            Layer.merge(Rpcs.toLayer({ Open: () => response }), makeMessagePortRpcServerProtocol(endpoints.port2)),
          ),
        ),
      ),
    )
    yield* withPhysicalWorkerLifetime(lifetimePort, physical).pipe(Effect.forkScoped)
    yield* lifetime.start
    const protocol = yield* Layer.buildWithScope(
      RpcClient.layerProtocolWorker({ size: 1 }).pipe(Layer.provide(BrowserWorker.layer(() => endpoints.port1))),
      transport,
    )
    const client = yield* RpcClient.make(Rpcs).pipe(Effect.provide(protocol), Scope.provide(transport))
    return {
      stream: client.Open().pipe(dieOnRpcClientErrorStream),
      close: Scope.close(transport, Exit.void),
      physicalClose: lifetime.close,
    }
  })

const makeCoordinatorClient = (
  retire: ({ generationToken }: { readonly generationToken: string }) => Effect.Effect<void>,
  update: (request: typeof SharedWorkerUpdateMessagePort.payloadSchema.Type) => Effect.Effect<void> = () => Effect.void,
) =>
  Effect.gen(function* () {
    const { port1, port2 } = new MessageChannel()
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        port1.close()
        port2.close()
      }),
    )
    yield* RpcServer.make(CoordinatorRpcs).pipe(
      Effect.provide(
        Layer.merge(
          CoordinatorRpcs.toLayer({ RetireLeaderGeneration: retire, UpdateMessagePort: update }),
          makeMessagePortRpcServerProtocol(port2),
        ),
      ),
      Effect.forkScoped,
    )
    const protocol = yield* Layer.build(
      RpcClient.layerProtocolWorker({ size: 1, concurrency: 100 }).pipe(
        Layer.provide(BrowserWorker.layer(() => port1)),
      ),
    )
    return yield* RpcClient.make(CoordinatorRpcs).pipe(Effect.provide(protocol))
  })

it('acknowledges normal retirement before physical close and reopens on the successor', () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const generations = yield* makeLeaderGenerations<OpenStream>()
        const requested = yield* Deferred.make<void>()
        const receiverClosing = yield* Deferred.make<void>()
        const allowPhysicalClose = yield* Deferred.make<void>()
        const proxyClosing = yield* Deferred.make<void>()
        const oldRpc = yield* makeRpc(
          Stream.unwrap(Deferred.succeed(requested, undefined).pipe(Effect.as(Stream.never))),
          Deferred.succeed(receiverClosing, undefined).pipe(Effect.andThen(Deferred.await(allowPhysicalClose))),
        )
        const retire = yield* makeCoordinatorClient(generations.retireByToken)
        yield* Effect.addFinalizer(() => Deferred.succeed(allowPhysicalClose, undefined))
        const { generation: old } = yield* generations.reserve(
          'old',
          Deferred.succeed(proxyClosing, undefined).pipe(Effect.andThen(oldRpc.close)),
        )
        expect(yield* generations.publish(old, oldRpc.stream)).toBe(true)
        const opening = yield* generations
          .openSession(
            (stream) => stream,
            (frame) => frame === 'admitted',
            'test-session',
          )
          .pipe(Stream.runCollect, Effect.forkScoped)
        yield* Deferred.await(requested)
        yield* retire.RetireLeaderGeneration({ generationToken: 'old' })
        expect(yield* Deferred.isDone(old.retired)).toBe(true)

        const closing = yield* oldRpc.physicalClose.pipe(Effect.forkScoped)
        yield* Deferred.await(receiverClosing)
        expect(opening.pollUnsafe()).toBeUndefined()
        expect(closing.pollUnsafe()).toBeUndefined()
        yield* Deferred.succeed(allowPhysicalClose, undefined)
        yield* Fiber.join(closing)
        expect(opening.pollUnsafe()).toBeUndefined()
        expect(yield* Deferred.isDone(proxyClosing)).toBe(false)

        const nextRpc = yield* makeRpc(Stream.make('admitted', 'retained edit'))
        const { generation: next, previous } = yield* generations.reserve('next', nextRpc.close)
        yield* generations.awaitPredecessor(previous)
        expect(yield* Deferred.isDone(proxyClosing)).toBe(true)
        expect(yield* generations.publish(next, nextRpc.stream)).toBe(true)
        yield* retire.RetireLeaderGeneration({ generationToken: 'old' })
        expect(yield* generations.retire(old, () => expect.unreachable('stale broadcast reset invariants'))).toBe(false)
        expect(yield* Deferred.isDone(next.retired)).toBe(false)
        expect(yield* Fiber.join(opening)).toEqual(['admitted', 'retained edit'])
      }),
    ),
  ))

it('cancels queued and installing updates over RPC without failing a waiting opener', () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const generations = yield* makeLeaderGenerations<OpenStream>()
        const permit = yield* Semaphore.make(1)
        const firstInstalled = yield* Deferred.make<void>()
        const queuedAtPermit = yield* Deferred.make<void>()
        const queuedPrepared = yield* Deferred.make<void>()
        const peerPorts: MessagePort[] = []
        yield* Effect.addFinalizer(() => Effect.sync(() => peerPorts.forEach((port) => port.close())))
        const openUpdate = yield* makeCoordinatorClient(generations.retireByToken, ({ generationToken, port }) =>
          Effect.gen(function* () {
            let owned = false
            yield* generationToken === 'queued' ? Deferred.succeed(queuedAtPermit, undefined) : Effect.void
            yield* generations
              .install(
                generationToken,
                Effect.sync(() => port.close()),
                () =>
                  Effect.sync(() => {
                    owned = true
                  }).pipe(
                    Effect.andThen(
                      generationToken === 'queued' ? Deferred.succeed(queuedPrepared, undefined) : Effect.void,
                    ),
                    Effect.asVoid,
                  ),
                ({ generation, previous }) =>
                  generationToken === 'first'
                    ? Deferred.succeed(firstInstalled, undefined).pipe(Effect.andThen(Effect.never))
                    : generations
                        .awaitPredecessor(previous)
                        .pipe(
                          Effect.andThen(generations.publish(generation, Stream.make('admitted', 'from successor'))),
                          Effect.asVoid,
                        ),
              )
              .pipe(
                permit.withPermit,
                Effect.ensuring(
                  Effect.sync(() => {
                    if (owned === false) port.close()
                  }),
                ),
              )
          }),
        )
        const update = (generationToken: string) => {
          const { port1, port2 } = new MessageChannel()
          peerPorts.push(port1, port2)
          return openUpdate.UpdateMessagePort({
            port: port1,
            generationToken,
            liveStoreVersion,
            initial: {
              storageOptions: { type: 'opfs' },
              storeId: 'test-store',
              clientId: 'test-client',
              devtoolsEnabled: false,
              debugInstanceId: 'test-debug',
              syncPayloadEncoded: { graph: 'test' },
              params: { stateRebuildBatchSize: 100 },
            },
          })
        }
        const first = yield* update('first').pipe(Effect.forkScoped)
        yield* Deferred.await(firstInstalled)
        const opening = yield* generations
          .openSession(
            (stream) => stream,
            (frame) => frame === 'admitted',
            'test-session',
          )
          .pipe(Stream.runCollect, Effect.exit, Effect.forkScoped)
        const queued = yield* update('queued').pipe(Effect.forkScoped)
        yield* Deferred.await(queuedAtPermit)
        yield* Fiber.interrupt(queued)
        yield* openUpdate.RetireLeaderGeneration({ generationToken: 'queued' })
        yield* Fiber.interrupt(first)
        yield* openUpdate.RetireLeaderGeneration({ generationToken: 'first' })
        expect(yield* Deferred.isDone(queuedPrepared)).toBe(false)
        yield* update('successor')
        expect(yield* Deferred.isDone(queuedPrepared)).toBe(false)
        expect(yield* Fiber.join(opening)).toEqual(Exit.succeed(['admitted', 'from successor']))
      }),
    ),
  ))

for (const failure of ['interrupt', 'storage'] as const) {
  it(`preserves an independent ${failure} from the receiver without retirement`, () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const generations = yield* makeLeaderGenerations<OpenStream>()
          const requested = yield* Deferred.make<void>()
          const failRequest = yield* Deferred.make<void>()
          const rpc = yield* makeRpc(
            Stream.fromEffect(
              Deferred.succeed(requested, undefined).pipe(
                Effect.andThen(Deferred.await(failRequest)),
                Effect.andThen(failure === 'interrupt' ? Effect.interrupt : Effect.fail('storage unavailable')),
              ),
            ),
          )
          const { generation } = yield* generations.reserve('current', rpc.close)
          expect(yield* generations.publish(generation, rpc.stream)).toBe(true)
          const opening = yield* generations
            .openSession(
              (stream) => stream,
              (frame) => frame === 'admitted',
              'test-session',
            )
            .pipe(Stream.runCollect, Effect.exit, Effect.forkScoped)
          yield* Deferred.await(requested)
          yield* Deferred.succeed(failRequest, undefined)
          const exit = yield* Fiber.join(opening)
          if (failure === 'interrupt') {
            expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
          } else {
            expect(exit).toEqual(Exit.fail('storage unavailable'))
          }
          yield* rpc.physicalClose
        }),
      ),
    ))
}
