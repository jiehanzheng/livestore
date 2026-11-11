import { afterEach, expect, it, vi } from 'vitest'

import { Deferred, Effect, Exit, Fiber, Scope } from '@livestore/utils/effect'

import {
  acquirePhysicalWorker,
  makePhysicalWorkerLifetime,
  makePhysicalWorkerLifetimeWithRealmLoss,
  withPhysicalWorkerLifetime,
} from './physical-worker-lifetime.ts'

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
        peer.onmessage = (event) => {
          if (event.data?.type === 'physical-close') Deferred.doneUnsafe(sent, Effect.void)
        }
        peer.start()
        peer.postMessage({ type: 'physical-armed' })
        yield* lifetime.start
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

it('fences startup when close wins after preparation', () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const lifetime = yield* makePhysicalWorkerLifetime
        const peer = yield* lifetime.initialPort
        const receiverPort = structuredClone(peer, { transfer: [peer] })
        const physical = vi.fn()
        const armed = yield* Deferred.make<void>()
        const post = receiverPort.postMessage.bind(receiverPort)
        const observeArm = vi.spyOn(receiverPort, 'postMessage').mockImplementationOnce((message) => {
          post(message)
          if (message?.type === 'physical-armed') Deferred.doneUnsafe(armed, Effect.void)
        })
        yield* Effect.addFinalizer(() => Effect.sync(() => observeArm.mockRestore()))
        const receiver = yield* withPhysicalWorkerLifetime(receiverPort, Effect.sync(physical)).pipe(Effect.forkScoped)

        yield* Deferred.await(armed)
        yield* lifetime.close
        expect(Exit.isFailure(yield* Effect.exit(lifetime.start))).toBe(true)
        yield* Fiber.join(receiver)
        expect(physical).not.toHaveBeenCalled()
      }),
    ),
  ))

it('disposes an ambient worker when setup is interrupted before RPC ownership', () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const data = new MessageChannel()
        const acquired = yield* Deferred.make<void>()
        const terminate = vi.fn(() => data.port2.close())
        const spawn = vi.fn(() => Object.assign(data.port1, { terminate }))
        yield* Effect.addFinalizer(() => Effect.sync(() => data.port1.close()))
        const setup = yield* Effect.scoped(
          Effect.gen(function* () {
            const lifetime = yield* makePhysicalWorkerLifetime
            yield* acquirePhysicalWorker(spawn, lifetime)
            yield* Deferred.succeed(acquired, undefined)
            return yield* Effect.never
          }),
        ).pipe(Effect.forkScoped)
        yield* Deferred.await(acquired)
        yield* Fiber.interrupt(setup)
        expect(spawn).toHaveBeenCalledTimes(1)
        expect(terminate).toHaveBeenCalledTimes(1)
      }),
    ),
  ))

it('leaves the caller-owned raw MessagePort open after the worker scope closes', () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const data = new MessageChannel()
        const closed = vi.spyOn(data.port1, 'close')
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            closed.mockRestore()
            data.port1.close()
            data.port2.close()
          }),
        )
        yield* Effect.scoped(
          Effect.gen(function* () {
            const lifetime = yield* makePhysicalWorkerLifetime
            expect(yield* acquirePhysicalWorker(() => data.port1, lifetime)).toBe(data.port1)
          }),
        )
        expect(closed).not.toHaveBeenCalled()
      }),
    ),
  ))

it('fences startup when the exact worker realm is witnessed lost', () => {
  const witness = new AbortController()
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const lifetime = yield* makePhysicalWorkerLifetimeWithRealmLoss(witness.signal)
        yield* lifetime.initialPort
        const starting = yield* Effect.exit(lifetime.start).pipe(Effect.forkScoped)
        witness.abort()
        expect(Exit.isFailure(yield* Fiber.join(starting))).toBe(true)
        expect(Exit.isFailure(yield* Effect.exit(lifetime.initialPort))).toBe(true)
        expect(yield* lifetime.close).toBe('witnessed-realm-loss')
      }),
    ),
  )
})

for (const mode of ['joined-clean', 'witnessed-realm-loss', 'failed'] as const) {
  it(`settles committed close from the first authoritative outcome: ${mode}`, () => {
    const witness = new AbortController()
    const unrelated = new AbortController()
    return Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const lifetime = yield* makePhysicalWorkerLifetimeWithRealmLoss(witness.signal)
          const peer = yield* lifetime.initialPort
          yield* Effect.addFinalizer(() => Effect.sync(() => peer.close()))
          const closingFrame = yield* Deferred.make<void>()
          peer.onmessage = (event) => {
            if (event.data?.type === 'physical-close') Deferred.doneUnsafe(closingFrame, Effect.void)
          }
          peer.postMessage({ type: 'physical-armed' })
          yield* lifetime.start
          const closing = yield* Effect.exit(lifetime.close).pipe(Effect.forkScoped)
          yield* Deferred.await(closingFrame)
          unrelated.abort()
          expect(closing.pollUnsafe()).toBeUndefined()
          if (mode === 'witnessed-realm-loss') witness.abort()
          else peer.postMessage({ type: 'physical-closed', success: mode === 'joined-clean' })
          const result = yield* Fiber.join(closing)
          witness.abort()
          expect(yield* Effect.exit(lifetime.close)).toEqual(result)
          if (mode === 'failed') expect(Exit.isFailure(result)).toBe(true)
          else expect(result).toEqual(Exit.succeed(mode))
        }),
      ),
    )
  })
}
