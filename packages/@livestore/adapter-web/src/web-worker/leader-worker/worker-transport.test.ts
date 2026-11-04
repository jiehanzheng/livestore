import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest'

import { makeSchema, State } from '@livestore/common/schema'
import * as WasmLoader from '@livestore/sqlite-wasm/load-wasm'
import {
  Cause,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  RpcClient,
  RpcWorker,
  Scope,
  Worker,
} from '@livestore/utils/effect'
import { BrowserWorker } from '@livestore/utils/effect/browser'

import type { SingleTabAdapterOptions } from '../../single-tab/single-tab-adapter.ts'
import type { WebAdapterOptions } from '../client-session/persisted-adapter.ts'
import { makePhysicalWorkerLifetime } from '../common/physical-worker-lifetime.ts'
import * as WorkerSchema from '../common/worker-schema.ts'
import { makeWorkerEffect, type WorkerOptions } from './make-leader-worker.ts'

const schema = makeSchema({
  projectionRevision: 'worker-transport-fixture-v1',
  events: {},
  state: State.SQLite.makeState({ tables: {}, materializers: {} }),
})

afterEach(() => vi.unstubAllGlobals())

describe('owned worker MessagePort transport', () => {
  it('accepts port factories while preserving Worker constructors', () => {
    type Factory = (options: { name: string }) => MessagePort
    type Constructor = Extract<WebAdapterOptions['worker'], new (options: { name: string }) => unknown>
    expectTypeOf<Factory>().toExtend<WebAdapterOptions['worker']>()
    expectTypeOf<Factory>().toExtend<SingleTabAdapterOptions['worker']>()
    expectTypeOf<Constructor>().toExtend<WebAdapterOptions['worker']>()
    expectTypeOf<Constructor>().toExtend<SingleTabAdapterOptions['worker']>()
    expectTypeOf<WorkerOptions['transport']>().toEqualTypeOf<MessagePort | undefined>()
  })

  for (const { explicitTransport, failFinalizer } of [
    { explicitTransport: false, failFinalizer: false },
    { explicitTransport: true, failFinalizer: false },
    { explicitTransport: true, failFinalizer: true },
  ]) {
    it(`joins cleanup before owner completion (explicit transport: ${explicitTransport}, finalizer failure: ${failFinalizer})`, () =>
      Effect.runPromise(
        Effect.gen(function* () {
          // Node supplies real MessageChannels. Only the worker's diagnostic name is
          // stubbed; transport, RPC framing and finalization use the official layers.
          const closeGlobal = vi.fn()
          const data = new MessageChannel()
          vi.stubGlobal(
            'self',
            explicitTransport === true ? { name: 'transport-test', close: closeGlobal } : data.port2,
          )
          const inner = new MessageChannel()
          const control = new MessageChannel()
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              data.port1.close()
              data.port2.close()
              inner.port1.close()
              inner.port2.close()
              control.port1.close()
              control.port2.close()
            }),
          )
          let finalized = false
          const finalizerError = new Error('Owner initialization finalizer failed')
          const running = Effect.scoped(
            Effect.gen(function* () {
              yield* Effect.addFinalizer(() =>
                Effect.gen(function* () {
                  finalized = true
                  if (failFinalizer === true) return yield* Effect.die(finalizerError)
                }),
              )
              return yield* makeWorkerEffect({
                schema,
                ...(explicitTransport === true ? { transport: data.port2 } : {}),
                logLevel: 'None',
              })
            }),
          )
          const fiber = yield* Effect.forkScoped(running)
          const receipt = Deferred.makeUnsafe<{ finalized: boolean; failed: boolean }>()
          control.port1.onmessage = (event) => Deferred.doneUnsafe(receipt, Effect.succeed(event.data))
          control.port1.start()
          fiber.addObserver((exit) =>
            control.port2.postMessage({
              finalized,
              failed: Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause),
            }),
          )

          const parentScope = yield* Scope.make()
          yield* Effect.addFinalizer((exit) => Scope.close(parentScope, exit))
          const lifetime = yield* makePhysicalWorkerLifetime
          const outerContext = yield* Layer.buildWithScope(
            RpcClient.layerProtocolWorker({ size: 1 }).pipe(
              Layer.provide(BrowserWorker.layer(() => data.port1)),
              Layer.provide(
                RpcWorker.layerInitialMessage(
                  WorkerSchema.LeaderWorkerOuterInitialMessage.payloadSchema,
                  lifetime.initialPort.pipe(
                    Effect.map((lifetimePort) => ({
                      port: inner.port1,
                      lifetimePort,
                      storeId: 'transport-test',
                      clientId: 'client',
                    })),
                  ),
                ),
              ),
            ),
            parentScope,
          )
          yield* RpcClient.make(WorkerSchema.LeaderWorkerOuterRpcs).pipe(Effect.provide(outerContext))
          yield* lifetime.ready

          // The inner runner becomes ready only after the SDK has received and
          // decoded its normal transferable outer InitialMessage.
          const ready = yield* Deferred.make<void>()
          yield* Effect.gen(function* () {
            const platform = yield* Worker.WorkerPlatform
            const endpoint = yield* platform.spawn(0)
            return yield* endpoint.run(() => Effect.void, { onSpawn: Deferred.succeed(ready, undefined) })
          }).pipe(Effect.provide(BrowserWorker.layer(() => inner.port2)), Effect.forkScoped)
          yield* Deferred.await(ready)

          yield* Scope.close(parentScope, Exit.void)
          yield* lifetime.close
          const exit = yield* Fiber.await(fiber)
          expect(yield* Deferred.await(receipt)).toEqual({ finalized: true, failed: failFinalizer })
          expect(closeGlobal).not.toHaveBeenCalled()
          if (failFinalizer === true) {
            expect(Exit.isFailure(exit) && Cause.pretty(exit.cause)).toContain(finalizerError.message)
          }
        }).pipe(Effect.scoped),
      ))
  }
})

it('cannot begin native database boot before the outer initial message is consumed', () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const data = new MessageChannel()
        vi.stubGlobal('self', data.port2)
        const load = vi.spyOn(WasmLoader, 'loadSqlite3Wasm')
        const ready = yield* Deferred.make<void>()
        data.port1.onmessage = (event) => {
          if (event.data[0] === 0) Deferred.doneUnsafe(ready, Effect.void)
        }
        data.port1.start()
        const receiverScope = yield* Scope.make()
        yield* Effect.addFinalizer(() =>
          Scope.close(receiverScope, Exit.void).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                data.port1.close()
                data.port2.close()
                load.mockRestore()
              }),
            ),
          ),
        )
        const receiver = yield* makeWorkerEffect({ schema, transport: data.port2, logLevel: 'None' }).pipe(
          Effect.forkIn(receiverScope),
        )
        yield* Deferred.await(ready)
        const lifetime = yield* makePhysicalWorkerLifetime
        yield* lifetime.close
        expect(load).not.toHaveBeenCalled()
        // Cancel the still-uninitialized SDK runner. It has received no initial
        // payload and therefore cannot have constructed its physical owner or DB.
        yield* Scope.close(receiverScope, Exit.void)
        yield* Fiber.await(receiver)
        expect(load).not.toHaveBeenCalled()
      }),
    ),
  ))
