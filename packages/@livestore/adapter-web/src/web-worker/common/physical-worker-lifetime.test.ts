import { afterEach, expect, it, vi } from 'vitest'

import { Deferred, Effect, Exit, Fiber, Scope } from '@livestore/utils/effect'

import { makePhysicalWorkerLifetime, withPhysicalWorkerLifetime } from './physical-worker-lifetime.ts'

afterEach(() => vi.unstubAllGlobals())

it('closes an untransferred initialization without invoking physical work', () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const lifetime = yield* makePhysicalWorkerLifetime
      yield* lifetime.close
      yield* lifetime.close
      expect(Exit.isFailure(yield* Effect.exit(lifetime.initialPort))).toBe(true)
    }),
  ))

it('never invents an ACK for a silent peer and fails a detected message error', () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const NativeChannel = MessageChannel
        let observed: MessageChannel | undefined
        vi.stubGlobal(
          'MessageChannel',
          class extends NativeChannel {
            constructor() {
              super()
              observed = { port1: this.port1, port2: this.port2 }
            }
          },
        )
        const lifetime = yield* makePhysicalWorkerLifetime
        const peer = yield* lifetime.initialPort
        const sent = yield* Deferred.make<void>()
        peer.onmessage = () => Deferred.doneUnsafe(sent, Effect.void)
        peer.start()
        const ownerScope = yield* Scope.make()
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            observed!.port1.dispatchEvent(new MessageEvent('messageerror'))
            yield* Scope.close(ownerScope, Exit.void)
            peer.close()
          }),
        )
        const closing = yield* Effect.exit(lifetime.close).pipe(Effect.forkIn(ownerScope))
        yield* Deferred.await(sent)
        expect(closing.pollUnsafe()).toBeUndefined()
        observed!.port1.dispatchEvent(new MessageEvent('messageerror'))
        expect(Exit.isFailure(yield* Fiber.join(closing))).toBe(true)
        expect(Exit.isFailure(yield* Effect.exit(lifetime.close))).toBe(true)
      }),
    ),
  ))

it('queues close before receiver initialization and acknowledges only its joined scope', () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const lifetime = yield* makePhysicalWorkerLifetime
        const receiverPort = yield* lifetime.initialPort
        const ownerScope = yield* Scope.make()
        const receiverScope = yield* Scope.make()
        let acquired = 0
        let finalized = 0
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            yield* Effect.exit(Scope.close(receiverScope, Exit.void))
            yield* Effect.exit(Scope.close(ownerScope, Exit.void))
          }),
        )
        const closing = yield* lifetime.close.pipe(Effect.forkIn(ownerScope))
        const receiver = yield* withPhysicalWorkerLifetime(
          receiverPort,
          Effect.gen(function* () {
            yield* Effect.acquireRelease(
              Effect.sync(() => {
                acquired++
              }),
              () =>
                Effect.sync(() => {
                  finalized++
                }),
            )
            return yield* Effect.never
          }),
        ).pipe(Effect.forkIn(receiverScope))
        yield* Fiber.join(closing)
        yield* Fiber.await(receiver)
        // A queued close may cancel before acquisition starts. Every resource that
        // actually acquired must still be closed before the acknowledgement arrives.
        expect(finalized).toBe(acquired)
        expect(acquired).toBeLessThanOrEqual(1)
      }),
    ),
  ))
