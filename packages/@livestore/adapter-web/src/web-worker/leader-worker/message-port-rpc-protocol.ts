import { Deferred, Effect, Layer, Queue, RpcSerialization, RpcServer } from '@livestore/utils/effect'

export const makeMessagePortRpcServerProtocol = (port: MessagePort): Layer.Layer<RpcServer.Protocol> =>
  Layer.effect(
    RpcServer.Protocol,
    Effect.gen(function* () {
      const disconnects = yield* Queue.unbounded<number>()
      const initialMessage = yield* Deferred.make<unknown>()
      const closed = yield* Deferred.make<void>()
      const clientIds = new Set<number>()

      return RpcServer.Protocol.of({
        disconnects,
        send: (_clientId, response, transferables) =>
          Effect.sync(() => port.postMessage([1, response], { transfer: (transferables ?? []) as Transferable[] })),
        end: () => Effect.void,
        clientIds: Effect.succeed(clientIds),
        initialMessage: Effect.asSome(Deferred.await(initialMessage)),
        supportsAck: true,
        supportsTransferables: true,
        supportsSpanPropagation: true,
        supportsNotifications: true,
        codecFor: RpcSerialization.json.codecFor,
        run: (writeRequest) =>
          Effect.gen(function* () {
            const context = yield* Effect.context<never>()
            const runFork = Effect.runForkWith(context)
            const onMessage = (event: MessageEvent) => {
              const message = event.data as readonly [0 | 1, unknown?]
              if (message[0] === 1) {
                runFork(
                  Effect.gen(function* () {
                    yield* Queue.offer(disconnects, 0)
                    yield* Deferred.succeed(closed, undefined)
                  }),
                )
                return
              }

              const request = message[1] as { readonly _tag?: string; readonly value?: unknown }
              clientIds.add(0)
              if (request._tag === 'InitialMessage') {
                runFork(Deferred.succeed(initialMessage, request.value))
              } else {
                runFork(writeRequest(0, request as never))
              }
            }

            port.addEventListener('message', onMessage)
            port.start()
            port.postMessage([0])

            return yield* Deferred.await(closed).pipe(
              Effect.andThen(Effect.interrupt),
              Effect.ensuring(
                Effect.sync(() => {
                  port.removeEventListener('message', onMessage)
                  port.close()
                }),
              ),
            )
          }),
      })
    }),
  )
