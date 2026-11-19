import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest'

import { StateSnapshot } from '@livestore/common'
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
  Stream,
  Worker,
} from '@livestore/utils/effect'
import { BrowserWorker, Opfs } from '@livestore/utils/effect/browser'

import type { SingleTabAdapterOptions } from '../../single-tab/single-tab-adapter.ts'
import type { WebAdapterOptions } from '../client-session/persisted-adapter.ts'
import { checkOpfsAvailability, confirmPersistedAdmission } from '../common/browser-environment.ts'
import { makeOwnedOpfsFixture } from '../common/opfs-owner.test-fixture.ts'
import { makePhysicalWorkerLifetime } from '../common/physical-worker-lifetime.ts'
import { startDedicatedWorker } from '../common/rpc-worker.ts'
import * as WorkerSchema from '../common/worker-schema.ts'
import { makeWorkerEffect, type WorkerOptions } from './make-leader-worker.ts'

const schema = makeSchema({
  projectionRevision: 'worker-transport-fixture-v1',
  events: {},
  state: State.SQLite.makeState({ tables: {}, materializers: {} }),
})

afterEach(() => vi.unstubAllGlobals())

it('requires actual worker persistence for strict admission and preserves the default fallback', () =>
  Effect.runPromise(
    Effect.forEach(
      [
        { available: false, requirePersistence: true },
        { available: false, requirePersistence: false },
        { available: true, requirePersistence: true },
      ],
      ({ available, requirePersistence }) =>
        Effect.scoped(
          Effect.gen(function* () {
            const data = new MessageChannel()
            const filesystem = makeOwnedOpfsFixture()
            const pageProbe = yield* checkOpfsAvailability.pipe(Effect.provideService(Opfs.Opfs, filesystem.service))
            expect(pageProbe).toBeUndefined()
            const getDirectory =
              available === true
                ? vi.fn().mockResolvedValue(filesystem.rootDirectory)
                : vi.fn().mockRejectedValue(new DOMException('Worker OPFS denied', 'SecurityError'))
            // Only the receiver probes navigator.storage in this test. The caller sends the normal wire payload.
            vi.stubGlobal('navigator', {
              storage: { getDirectory },
              locks: {
                request: (name: string, _options: LockOptions, use: (lock: Lock) => Promise<unknown>) =>
                  use({ name, mode: 'exclusive' }),
              },
            })
            vi.stubGlobal('self', { name: 'strict-opfs-worker' })
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                data.port1.close()
                data.port2.close()
              }),
            )
            yield* makeWorkerEffect({ schema, transport: data.port2, logLevel: 'None' }).pipe(Effect.forkScoped)
            const lifetime = yield* makePhysicalWorkerLifetime
            const storeId = `strict-opfs-worker-${requirePersistence}`
            const clientId = 'client'
            const innerPort = yield* startDedicatedWorker(
              { transport: data.port1, lifetime, close: lifetime.close.pipe(Effect.orDie) },
              { storeId, clientId },
            )
            const context = yield* Layer.build(
              RpcClient.layerProtocolWorker({ size: 1 }).pipe(
                Layer.provide(BrowserWorker.layer(() => innerPort)),
                Layer.provide(
                  RpcWorker.layerInitialMessage(
                    WorkerSchema.LeaderWorkerInnerInitialMessage.payloadSchema,
                    Effect.succeed({
                      storageOptions: { type: 'opfs', requirePersistence },
                      storeId,
                      clientId,
                      devtoolsEnabled: false,
                      debugInstanceId: 'strict-opfs-test',
                      syncPayloadEncoded: undefined,
                      params: { stateRebuildBatchSize: 100 },
                    }),
                  ),
                ),
              ),
            )
            const client = yield* RpcClient.make(WorkerSchema.LeaderWorkerInnerRpcs).pipe(Effect.provide(context))
            const open = { expectedProjection: StateSnapshot.getProjectionIdentity(schema), candidate: undefined }
            const firstFrame = (strict: boolean, requireConfirmation = strict) =>
              client
                .OpenSession({ ...open, requirePersistence: strict })
                .pipe(confirmPersistedAdmission(requireConfirmation), Stream.take(1), Stream.runCollect, Effect.exit)
            const strict = yield* firstFrame(true)
            expect(getDirectory).toHaveBeenCalled()
            if (available === true) {
              expect(Exit.isSuccess(strict) && strict.value[0]).toMatchObject({
                _tag: 'StaleSnapshot',
                persisted: true,
              })
              if (Exit.isSuccess(strict) === true && strict.value[0]?._tag === 'StaleSnapshot') {
                const incarnation = yield* client.GetSourceIncarnation({})
                expect(incarnation).toBe(strict.value[0].provenance.sourceIncarnation)
                expect(yield* client.GetSourceBackendId({})).toBeNull()
              }
            } else {
              expect(Exit.isFailure(strict) && Cause.pretty(strict.cause)).toContain(
                requirePersistence === true ? 'leader OPFS is unavailable' : 'leader uses in-memory storage',
              )
            }
            if (requirePersistence === false) {
              const fallback = yield* firstFrame(false)
              expect(Exit.isSuccess(fallback) && fallback.value[0]?._tag).toBe('StaleSnapshot')
              const ignoredRequirement = yield* firstFrame(false, true)
              expect(Exit.isFailure(ignoredRequirement) && Cause.pretty(ignoredRequirement.cause)).toContain(
                'Leader did not confirm persistent LiveStore storage',
              )
              const backend = yield* client.GetSourceBackendId({}).pipe(Effect.exit)
              expect(Exit.isFailure(backend) && Cause.pretty(backend.cause)).toContain(
                'does not expose a persisted SOURCE backend identity',
              )
              const source = yield* client.GetSourceIncarnation({}).pipe(Effect.exit)
              expect(Exit.isFailure(source) && Cause.pretty(source.cause)).toContain(
                'does not expose a persisted SOURCE incarnation',
              )
            }
          }),
        ),
    ),
  ))

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
          yield* RpcClient.make(WorkerSchema.LeaderWorkerOuterRpcs).pipe(
            Effect.provide(outerContext),
            Scope.provide(parentScope),
          )
          yield* Scope.addFinalizer(parentScope, lifetime.close.pipe(Effect.orDie))
          yield* lifetime.start

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

it('joins the real receiver without opening SQLite when its bootstrap post fails', () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const data = new MessageChannel()
        const delivered = vi.fn()
        const load = vi.spyOn(WasmLoader, 'loadSqlite3Wasm')
        vi.stubGlobal('self', { name: 'initial-send-failure' })
        const attempted = yield* Deferred.make<unknown>()
        const post = data.port1.postMessage.bind(data.port1)
        const intercept = vi.spyOn(data.port1, 'postMessage').mockImplementationOnce(() => {
          try {
            post(() => undefined)
          } catch (cause) {
            Deferred.doneUnsafe(attempted, Effect.succeed(cause))
            throw cause
          }
        })
        data.port2.addEventListener('message', (event) => {
          if (event.data?.[1]?._tag === 'InitialMessage') delivered()
        })
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            intercept.mockRestore()
            load.mockRestore()
            data.port1.close()
            data.port2.close()
          }),
        )
        const receiver = yield* makeWorkerEffect({ schema, transport: data.port2, logLevel: 'None' }).pipe(
          Effect.forkScoped,
        )
        const owner = yield* Scope.make()
        const lifetime = yield* makePhysicalWorkerLifetime
        yield* Effect.addFinalizer(() => Scope.close(owner, Exit.void))
        const result = yield* startDedicatedWorker(
          { transport: data.port1, lifetime, close: lifetime.close.pipe(Effect.orDie) },
          { storeId: 'initial-send-failure', clientId: 'client' },
        ).pipe(Scope.provide(owner), Effect.exit)
        expect(Exit.isFailure(result) && Cause.pretty(result.cause)).toContain('Failed to send message to worker')
        expect(yield* Deferred.await(attempted)).toMatchObject({ name: 'DataCloneError' })
        yield* Scope.close(owner, result)
        yield* Fiber.await(receiver)
        expect(delivered).not.toHaveBeenCalled()
        expect(load).not.toHaveBeenCalled()
      }),
    ),
  ))
