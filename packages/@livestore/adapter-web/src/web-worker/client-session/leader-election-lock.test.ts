import { afterEach, describe, expect, it, vi } from 'vitest'

import type { BootStatus } from '@livestore/common'
import { makeSchema, State } from '@livestore/common/schema'
import { Cause, Deferred, Effect, Exit, Fiber, Queue, Scope } from '@livestore/utils/effect'

import { makePhysicalWorkerLifetime, withPhysicalWorkerLifetime } from '../common/physical-worker-lifetime.ts'
import { makeWorkerDisconnectChannel } from '../common/worker-disconnect-channel.ts'
import { makeLeaderElectionLock } from './leader-election-lock.ts'
import { makeWorkerLeadership } from './worker-leadership.ts'
import { makeWorkerShutdown } from './worker-shutdown.ts'

afterEach(() => vi.unstubAllGlobals())

describe('leader election lock lifetime', () => {
  for (const failStartup of [false, true]) {
    it(`releases an acquired lock when startup ${failStartup === true ? 'fails' : 'is interrupted'}`, () =>
      Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const locks = installLockManager()
            const ready = yield* Deferred.make<void>()
            const failure = new Error('Startup failed before snapshot admission')
            const opening = yield* Effect.scoped(
              Effect.gen(function* () {
                const lock = yield* makeLeaderElectionLock('startup')
                expect(yield* lock.tryAcquire).toBe(true)
                yield* Deferred.succeed(ready, undefined)
                if (failStartup === true) return yield* Effect.fail(failure)
                return yield* Effect.never
              }),
            ).pipe(Effect.forkChild)
            yield* Deferred.await(ready)
            if (failStartup === false) yield* Fiber.interrupt(opening)
            const exit = yield* Fiber.await(opening)
            yield* Deferred.await(locks.receipt(0).released)
            expect(locks.isHeld('startup')).toBe(false)
            expect(Exit.isFailure(exit)).toBe(true)
            if (failStartup === true && Exit.isFailure(exit) === true) expect(Cause.squash(exit.cause)).toBe(failure)
          }),
        ),
      ))
  }

  it('keeps the lock until later SDK resources have finalized', () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const locks = installLockManager()
          const order: string[] = []
          yield* Effect.scoped(
            Effect.gen(function* () {
              const lock = yield* makeLeaderElectionLock('order')
              expect(yield* lock.tryAcquire).toBe(true)
              yield* Effect.addFinalizer(() =>
                Effect.sync(() => {
                  expect(locks.isHeld('order')).toBe(true)
                  order.push('sdk-finalized')
                }),
              )
            }),
          )
          yield* Deferred.await(locks.receipt(0).released)
          order.push('lock-released')
          expect(order).toEqual(['sdk-finalized', 'lock-released'])
        }),
      ),
    ))

  it('owns a follower lock after promotion and releases it on interrupted startup', () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const locks = installLockManager()
          const leaderScope = yield* ownedScope
          const leader = yield* makeLeaderElectionLock('promotion').pipe(Scope.provide(leaderScope))
          expect(yield* leader.tryAcquire).toBe(true)
          const followerScope = yield* ownedScope
          const follower = yield* makeLeaderElectionLock('promotion').pipe(Scope.provide(followerScope))
          expect(yield* follower.tryAcquire).toBe(false)
          const promoted = yield* follower.wait.pipe(Scope.provide(followerScope), Effect.forkIn(followerScope))
          yield* Deferred.await(locks.receipt(2).requested)
          yield* Scope.close(leaderScope, Exit.void)
          yield* Deferred.await(locks.receipt(0).released)
          yield* Fiber.join(promoted)
          expect(locks.isHeld('promotion')).toBe(true)
          yield* Scope.close(followerScope, Exit.interrupt(1))
          yield* Deferred.await(locks.receipt(2).released)
          expect(locks.isHeld('promotion')).toBe(false)
        }),
      ),
    ))

  it('cancels a queued follower without releasing the current leader or acquiring later', () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const locks = installLockManager()
          const leaderScope = yield* ownedScope
          const leader = yield* makeLeaderElectionLock('queued').pipe(Scope.provide(leaderScope))
          expect(yield* leader.tryAcquire).toBe(true)
          const followerScope = yield* ownedScope
          const follower = yield* makeLeaderElectionLock('queued').pipe(Scope.provide(followerScope))
          expect(yield* follower.tryAcquire).toBe(false)
          const waiting = yield* follower.wait.pipe(Scope.provide(followerScope), Effect.forkIn(followerScope))
          yield* Deferred.await(locks.receipt(2).requested)
          yield* Scope.close(followerScope, Exit.void)
          const exit = yield* Fiber.await(waiting)
          expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
          expect(locks.isHeld('queued')).toBe(true)
          yield* Scope.close(leaderScope, Exit.void)
          yield* Deferred.await(locks.receipt(0).released)
          expect(yield* Deferred.isDone(locks.receipt(2).granted)).toBe(false)
          expect(locks.isHeld('queued')).toBe(false)
        }),
      ),
    ))

  it('releases a grant whose callback arrives after the owning scope has closed', () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const locks = installLockManager()
          const grant = Deferred.makeUnsafe<void>()
          locks.pauseNextCallback(grant)
          yield* Effect.addFinalizer(() =>
            Deferred.succeed(grant, undefined).pipe(Effect.andThen(Deferred.await(locks.receipt(0).released))),
          )
          const opening = yield* Effect.scoped(
            Effect.gen(function* () {
              const lock = yield* makeLeaderElectionLock('late-callback')
              yield* lock.tryAcquire
              return yield* Effect.never
            }),
          ).pipe(Effect.forkChild)
          yield* Deferred.await(locks.receipt(0).requested)
          yield* Fiber.interrupt(opening)
          yield* Deferred.succeed(grant, undefined)
          yield* Deferred.await(locks.receipt(0).released)
          expect(locks.isHeld('late-callback')).toBe(false)
        }),
      ),
    ))
})

it.each(['initial', 'promotion', 'native-post'] as const)(
  '%s startup reports its failure and joins release',
  (mode) => {
    const loss = new AbortController()
    return Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const locks = installLockManager()
          const lockName = 'livestore-tab-lock-failed-start'
          const previousOwner = yield* ownedScope
          if (mode === 'promotion') {
            const previous = yield* makeLeaderElectionLock(lockName).pipe(Scope.provide(previousOwner))
            expect(yield* previous.tryAcquire).toBe(true)
          }
          const owner = yield* Scope.make()
          const shared = new MessageChannel()
          const dedicated = new MessageChannel()
          const reachedInitial = yield* Deferred.make<string | undefined>()
          const shutdownRequested = yield* Deferred.make<string>()
          const releaseReached = yield* Deferred.make<string>()
          const allowRelease = yield* Deferred.make<void>()
          const run = yield* Effect.context<never>()
          const runFork = Effect.runForkWith(run)
          dedicated.port2.onmessage = ({ data }) => {
            if (data[1]?._tag !== 'InitialMessage') return
            // Receive the real transferred port, then lose the worker without arming it.
            data[1].value.lifetimePort.close()
            data[1].value.port.close()
            loss.abort()
            runFork(Deferred.succeed(reachedInitial, undefined))
          }
          if (mode === 'native-post') {
            const post = dedicated.port1.postMessage.bind(dedicated.port1)
            const intercept = vi.spyOn(dedicated.port1, 'postMessage').mockImplementationOnce(() => {
              try {
                // Ask the real MessagePort to clone a function.
                post(() => undefined)
              } catch (cause) {
                runFork(Deferred.succeed(reachedInitial, cause instanceof DOMException ? cause.name : undefined))
                throw cause
              }
            })
            yield* Effect.addFinalizer(() => Effect.sync(() => intercept.mockRestore()))
          }
          dedicated.port2.postMessage([0])
          shared.port2.postMessage([0])
          yield* Effect.addFinalizer((exit) =>
            Deferred.succeed(allowRelease, undefined).pipe(
              Effect.andThen(Scope.close(owner, exit)),
              Effect.ensuring(
                Effect.sync(() => {
                  for (const channel of [shared, dedicated]) {
                    channel.port1.close()
                    channel.port2.close()
                  }
                }),
              ),
            ),
          )
          const startup = yield* Effect.gen(function* () {
            const workerShutdown = yield* makeWorkerShutdown
            return yield* workerShutdown.run(
              Effect.gen(function* () {
                const workerDisconnectChannel = yield* makeWorkerDisconnectChannel('failed-start')
                const sharedWorker = { port: shared.port1 } as SharedWorker
                const options = {
                  storage: { type: 'opfs' } as const,
                  sharedWorker: () => sharedWorker,
                  worker: () => ({
                    port: dedicated.port1,
                    realmLost: loss.signal,
                    beforeRelease: (outcome: string) =>
                      Effect.runPromiseWith(run)(
                        Deferred.succeed(releaseReached, outcome).pipe(Effect.andThen(Deferred.await(allowRelease))),
                      ),
                  }),
                }
                return yield* makeWorkerLeadership({
                  adapterArgs: {
                    schema: makeSchema({
                      projectionRevision: 'startup-handoff-v1',
                      events: {},
                      state: State.SQLite.makeState({ tables: {}, materializers: {} }),
                    }),
                    storeId: 'failed-start',
                    params: { stateRebuildBatchSize: 100 },
                    devtoolsEnabled: false,
                    debugInstanceId: 'failed-start',
                    bootStatusQueue: yield* Queue.unbounded<BootStatus>(),
                    shutdown: (exit) =>
                      Deferred.succeed(
                        shutdownRequested,
                        Exit.isFailure(exit) === true ? Cause.pretty(exit.cause) : 'unexpected successful shutdown',
                      ),
                    connectDevtoolsToStore: () => Effect.void,
                    syncPayloadSchema: undefined,
                    syncPayloadEncoded: undefined,
                  },
                  options,
                  clientId: 'client',
                  sessionId: 'session',
                  storageOptions: options.storage,
                  sharedWebWorker: sharedWorker,
                  workerDisconnectChannel,
                  workerShutdown,
                })
              }),
            )
          }).pipe(Scope.provide(owner), Effect.exit, Effect.forkScoped)

          if (mode === 'promotion') {
            yield* Deferred.await(locks.receipt(2).requested)
            yield* Scope.close(previousOwner, Exit.void)
          }
          const nativeFailure = yield* Deferred.await(reachedInitial)
          if (mode === 'native-post') expect(nativeFailure).toBe('DataCloneError')
          const result = yield* Fiber.join(startup)
          const failure =
            mode === 'native-post' ? 'Failed to send message to worker' : 'Dedicated worker realm was witnessed lost'
          if (mode === 'promotion') {
            expect(Exit.isSuccess(result)).toBe(true)
            expect(yield* Deferred.await(shutdownRequested)).toContain(failure)
          } else {
            expect(Exit.isFailure(result) && Cause.pretty(result.cause)).toContain(failure)
            expect(yield* Deferred.isDone(shutdownRequested)).toBe(false)
          }
          const close = yield* Scope.close(owner, result).pipe(Effect.forkScoped)
          expect(yield* Deferred.await(releaseReached)).toBe(
            mode === 'native-post' ? 'never-started' : 'witnessed-realm-loss',
          )
          const follower = yield* makeLeaderElectionLock(lockName)
          expect(yield* follower.tryAcquire).toBe(false)
          yield* Deferred.succeed(allowRelease, undefined)
          yield* Fiber.join(close)
          yield* Deferred.await(locks.receipt(mode === 'promotion' ? 2 : 0).released)
          expect(yield* follower.tryAcquire).toBe(true)
        }),
      ),
    )
  },
)

const ownedScope = Effect.gen(function* () {
  const scope = yield* Scope.make()
  yield* Effect.addFinalizer((exit) => Scope.close(scope, exit))
  return scope
})

/** Deterministic browser boundary: a lock is held until its callback promise settles. */
const installLockManager = () => {
  type Receipt = {
    requested: Deferred.Deferred<void>
    granted: Deferred.Deferred<void>
    released: Deferred.Deferred<void>
  }
  type Request = {
    name: string
    id: number
    signal?: AbortSignal
    cancelled: boolean
    pause?: Deferred.Deferred<void>
    callback: (lock: { name: string; mode: 'exclusive' } | null) => unknown
    resolve(value: unknown): void
    reject(error: unknown): void
  }
  const receipts = new Map<number, Receipt>()
  const held = new Map<string, Request>()
  const pending: Request[] = []
  let nextId = 0
  let pause: Deferred.Deferred<void> | undefined
  const receipt = (id: number) => {
    let value = receipts.get(id)
    if (value === undefined) {
      value = {
        requested: Deferred.makeUnsafe<void>(),
        granted: Deferred.makeUnsafe<void>(),
        released: Deferred.makeUnsafe<void>(),
      }
      receipts.set(id, value)
    }
    return value
  }
  const signal = (ready: Deferred.Deferred<void>) => Deferred.doneUnsafe(ready, Effect.void)
  const grant = (request: Request) => {
    held.set(request.name, request)
    void (async () => {
      if (request.pause !== undefined) await Effect.runPromise(Deferred.await(request.pause))
      signal(receipt(request.id).granted)
      return request.callback({ name: request.name, mode: 'exclusive' })
    })()
      .then(request.resolve, request.reject)
      .finally(() => {
        held.delete(request.name)
        const index = pending.findIndex((entry) => entry.name === request.name && !entry.cancelled)
        if (index >= 0) grant(pending.splice(index, 1)[0]!)
        signal(receipt(request.id).released)
      })
  }
  vi.stubGlobal('navigator', {
    locks: {
      request(name: string, options: { ifAvailable?: boolean; signal?: AbortSignal }, callback: Request['callback']) {
        return new Promise((resolve, reject) => {
          const request: Request = {
            name,
            id: nextId++,
            callback,
            resolve,
            reject,
            cancelled: false,
            ...(options.signal !== undefined ? { signal: options.signal } : {}),
            ...(pause !== undefined ? { pause } : {}),
          }
          pause = undefined
          signal(receipt(request.id).requested)
          if (held.has(name) === false) grant(request)
          else if (options.ifAvailable === true) Promise.resolve(callback(null)).then(resolve, reject)
          else {
            pending.push(request)
            const abort = () => {
              if (held.get(name) === request) return
              request.cancelled = true
              reject(new DOMException('signal is aborted without reason', 'AbortError'))
            }
            options.signal?.addEventListener('abort', abort, { once: true })
            if (options.signal?.aborted === true) abort()
          }
        })
      },
    },
  })
  return {
    receipt,
    isHeld: (name: string) => held.has(name),
    pauseNextCallback: (ready: Deferred.Deferred<void>) => {
      pause = ready
    },
  }
}

it('cancels a queued follower while the real physical close acknowledgement is pending', () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const locks = installLockManager()
        const leaderScope = yield* ownedScope
        const followerScope = yield* ownedScope
        const receiverScope = yield* ownedScope
        const closingScope = yield* ownedScope
        const allowClose = yield* Deferred.make<void>()
        const started = yield* Deferred.make<void>()
        const closing = yield* Deferred.make<void>()
        yield* Effect.addFinalizer(() => Deferred.succeed(allowClose, undefined))
        const lifetime = yield* makePhysicalWorkerLifetime
        const port = yield* lifetime.initialPort
        yield* withPhysicalWorkerLifetime(
          port,
          Effect.gen(function* () {
            yield* Effect.addFinalizer(() =>
              Deferred.succeed(closing, undefined).pipe(Effect.andThen(Deferred.await(allowClose))),
            )
            yield* Deferred.succeed(started, undefined)
            return yield* Effect.never
          }),
        ).pipe(Effect.forkIn(receiverScope))
        yield* lifetime.start
        yield* Deferred.await(started)
        const leader = yield* makeLeaderElectionLock('joined-queued', () => lifetime.close).pipe(
          Scope.provide(leaderScope),
        )
        expect(yield* leader.tryAcquire).toBe(true)
        const follower = yield* makeLeaderElectionLock('joined-queued').pipe(Scope.provide(followerScope))
        const waiting = yield* follower.wait.pipe(Scope.provide(followerScope), Effect.forkIn(followerScope))
        yield* Deferred.await(locks.receipt(1).requested)
        const released = yield* Scope.close(leaderScope, Exit.void).pipe(Effect.forkIn(closingScope))
        yield* Deferred.await(closing)
        expect(locks.isHeld('joined-queued')).toBe(true)
        yield* Scope.close(followerScope, Exit.void)
        const waitingExit = yield* Fiber.await(waiting)
        expect(Exit.isFailure(waitingExit) && Cause.hasInterruptsOnly(waitingExit.cause)).toBe(true)
        yield* Deferred.succeed(allowClose, undefined)
        yield* Fiber.join(released)
        yield* Deferred.await(locks.receipt(0).released)
        expect(yield* Deferred.isDone(locks.receipt(1).granted)).toBe(false)
        expect(locks.isHeld('joined-queued')).toBe(false)
      }),
    ),
  ))

for (const mode of ['clean', 'never-started', 'loss', 'app-join-fails', 'sdk-join-fails', 'retire-fails'] as const) {
  it(`joins surviving SDK and app owners before election release: ${mode}`, () => {
    const witness = new AbortController()
    const closesPhysically = mode === 'clean' || mode === 'retire-fails'
    return Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const locks = installLockManager()
          const page = yield* Scope.make()
          const data = new MessageChannel()
          const sdkClosing = yield* Deferred.make<void>()
          const allowSdkClose = yield* Deferred.make<void>()
          const appClosing = yield* Deferred.make<void>()
          const allowAppClose = Promise.withResolvers<void>()
          const physicalClosing = yield* Deferred.make<void>()
          const retiring = yield* Deferred.make<void>()
          const allowRetire = yield* Deferred.make<void>()
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              data.port1.close()
              data.port2.close()
            }),
          )
          const owner = yield* makeWorkerShutdown.pipe(Scope.provide(page))
          yield* owner.run(
            Effect.gen(function* () {
              const lock = yield* owner.election('surviving-worker')
              expect(yield* lock.tryAcquire).toBe(true)
              yield* Effect.addFinalizer(() =>
                Effect.gen(function* () {
                  yield* Deferred.succeed(sdkClosing, undefined)
                  yield* Deferred.await(allowSdkClose)
                  if (mode === 'sdk-join-fails') return yield* Effect.die('surviving SDK close failed')
                }),
              )
              const { lifetime } = yield* owner.acquireWorker(() => ({
                port: data.port1,
                realmLost: witness.signal,
                beforeRelease: async (outcome) => {
                  expect(outcome).toBe(
                    closesPhysically === true
                      ? 'joined-clean'
                      : mode === 'never-started'
                        ? mode
                        : 'witnessed-realm-loss',
                  )
                  Deferred.doneUnsafe(appClosing, Effect.void)
                  await allowAppClose.promise
                  if (mode === 'app-join-fails') throw new Error('surviving app close failed')
                },
              }))
              if (mode === 'never-started') return
              if (closesPhysically === true) {
                owner.beforePhysicalClose(
                  Deferred.succeed(retiring, undefined).pipe(
                    Effect.andThen(Deferred.await(allowRetire)),
                    Effect.andThen(mode === 'retire-fails' ? Effect.die('coordinator retirement failed') : Effect.void),
                  ),
                )
              }
              const peer = yield* lifetime.initialPort
              yield* Effect.addFinalizer(() => Effect.sync(() => peer.close()))
              yield* Effect.addFinalizer(() => lifetime.close.pipe(Effect.orDie))
              peer.onmessage = (event) => {
                if (event.data?.type !== 'physical-close') return
                Deferred.doneUnsafe(physicalClosing, Effect.void)
                if (closesPhysically === true) peer.postMessage({ type: 'physical-closed', success: true })
              }
              peer.postMessage({ type: 'physical-armed' })
              yield* lifetime.start
              if (closesPhysically === false) witness.abort()
            }),
          )
          const close = yield* Effect.exit(Scope.close(page, Exit.void)).pipe(Effect.forkScoped)
          if (closesPhysically === true) {
            yield* Deferred.await(retiring)
            expect(locks.isHeld('surviving-worker')).toBe(true)
            expect(yield* Deferred.isDone(physicalClosing)).toBe(false)
            expect(yield* Deferred.isDone(sdkClosing)).toBe(false)
            yield* Deferred.succeed(allowRetire, undefined)
            yield* Deferred.await(physicalClosing)
          }
          yield* Deferred.await(sdkClosing)
          expect(locks.isHeld('surviving-worker')).toBe(true)
          expect(yield* Deferred.isDone(appClosing)).toBe(false)
          yield* Deferred.succeed(allowSdkClose, undefined)
          if (mode !== 'sdk-join-fails') {
            yield* Deferred.await(appClosing)
            expect(locks.isHeld('surviving-worker')).toBe(true)
            allowAppClose.resolve()
          }
          const result = yield* Fiber.join(close)
          if (mode === 'sdk-join-fails' || mode === 'app-join-fails') {
            expect(Exit.isFailure(result)).toBe(true)
            expect(locks.isHeld('surviving-worker')).toBe(true)
          } else {
            if (mode === 'retire-fails') {
              expect(Exit.isFailure(result) && Cause.pretty(result.cause)).toContain('coordinator retirement failed')
            } else {
              expect(Exit.isSuccess(result)).toBe(true)
            }
            yield* Deferred.await(locks.receipt(0).released)
            expect(locks.isHeld('surviving-worker')).toBe(false)
          }
        }),
      ),
    )
  })
}

it('interrupts and joins startup before releasing election', () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const locks = installLockManager()
        const page = yield* Scope.make()
        const ready = yield* Deferred.make<void>()
        const finalizing = yield* Deferred.make<void>()
        const allowClose = yield* Deferred.make<void>()
        const resourceClosed = yield* Deferred.make<void>()
        const owner = yield* makeWorkerShutdown.pipe(Scope.provide(page))
        const opening = yield* owner
          .run(
            Effect.gen(function* () {
              const lock = yield* owner.election('worker-startup')
              expect(yield* lock.tryAcquire).toBe(true)
              yield* Effect.addFinalizer(() => Deferred.succeed(resourceClosed, undefined))
              yield* Deferred.succeed(ready, undefined)
              return yield* Effect.never.pipe(
                Effect.ensuring(
                  Deferred.succeed(finalizing, undefined).pipe(Effect.andThen(Deferred.await(allowClose))),
                ),
              )
            }),
          )
          .pipe(Effect.forkScoped)
        yield* Deferred.await(ready)
        const close = yield* Scope.close(page, Exit.void).pipe(Effect.forkScoped)
        yield* Deferred.await(finalizing)
        expect(locks.isHeld('worker-startup')).toBe(true)
        expect(yield* Deferred.isDone(resourceClosed)).toBe(false)
        expect(close.pollUnsafe()).toBeUndefined()
        yield* Deferred.succeed(allowClose, undefined)
        yield* Fiber.join(close)
        expect(Exit.isFailure(yield* Fiber.await(opening))).toBe(true)
        expect(yield* Deferred.isDone(resourceClosed)).toBe(true)
        yield* Deferred.await(locks.receipt(0).released)
        expect(locks.isHeld('worker-startup')).toBe(false)
      }),
    ),
  ))

it('cancels and joins queued election before closing ordinary resources', () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const locks = installLockManager()
        const leaderScope = yield* Scope.make()
        const page = yield* Scope.make()
        const leader = yield* makeLeaderElectionLock('worker-election').pipe(Scope.provide(leaderScope))
        expect(yield* leader.tryAcquire).toBe(true)
        const owner = yield* makeWorkerShutdown.pipe(Scope.provide(page))
        const finalizing = yield* Deferred.make<void>()
        const allowClose = yield* Deferred.make<void>()
        const resourceClosed = yield* Deferred.make<void>()
        yield* owner.run(
          Effect.gen(function* () {
            const follower = yield* owner.election('worker-election')
            yield* follower.wait.pipe(
              Effect.ensuring(Deferred.succeed(finalizing, undefined).pipe(Effect.andThen(Deferred.await(allowClose)))),
              owner.forkStartup,
            )
            yield* Effect.addFinalizer(() => Deferred.succeed(resourceClosed, undefined))
          }),
        )
        yield* Deferred.await(locks.receipt(1).requested)
        const close = yield* Scope.close(page, Exit.void).pipe(Effect.forkScoped)
        yield* Deferred.await(finalizing)
        expect(yield* Deferred.isDone(resourceClosed)).toBe(false)
        expect(close.pollUnsafe()).toBeUndefined()
        yield* Deferred.succeed(allowClose, undefined)
        yield* Fiber.join(close)
        expect(yield* Deferred.isDone(resourceClosed)).toBe(true)
        expect(locks.isHeld('worker-election')).toBe(true)
        yield* Scope.close(leaderScope, Exit.void)
        yield* Deferred.await(locks.receipt(0).released)
        expect(yield* Deferred.isDone(locks.receipt(1).granted)).toBe(false)
        expect(locks.isHeld('worker-election')).toBe(false)
      }),
    ),
  ))
