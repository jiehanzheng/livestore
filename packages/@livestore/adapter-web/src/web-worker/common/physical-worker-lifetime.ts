import { UnknownError } from '@livestore/common'
import { Cause, Deferred, Effect, Exit, Fiber, Scope } from '@livestore/utils/effect'

/** One control channel belongs to exactly one receiving physical scope. */
export const makePhysicalWorkerLifetime = Effect.gen(function* () {
  const channel = new MessageChannel()
  const outcome = yield* Deferred.make<void, UnknownError>()
  const ready = yield* Deferred.make<void, UnknownError>()
  let initialized = false
  let closing = false
  const failed = () => {
    const error = new UnknownError({ cause: 'Worker physical close failed or could not be confirmed' })
    Deferred.doneUnsafe(outcome, Effect.fail(error))
    Deferred.doneUnsafe(ready, Effect.fail(error))
  }
  channel.port1.onmessage = (event) => {
    if (event.data?.type === 'physical-ready') {
      Deferred.doneUnsafe(ready, Effect.void)
      return
    }
    if (event.data?.type !== 'physical-closed' || typeof event.data.success !== 'boolean') return
    if (event.data.success === true) Deferred.doneUnsafe(outcome, Effect.void)
    else failed()
  }
  channel.port1.onmessageerror = failed
  channel.port1.start()
  const close = yield* Effect.cached(
    Effect.uninterruptible(
      Effect.suspend(() => {
        closing = true
        // The SDK cannot open SQLite before consuming the outer InitialMessage.
        // Marking transfer before serialization is deliberately conservative on failure.
        if (initialized === false)
          return Effect.sync(() => {
            channel.port1.close()
            channel.port2.close()
          })
        return Effect.try({
          try: () => channel.port1.postMessage({ type: 'physical-close' }),
          catch: (cause) => new UnknownError({ cause }),
        }).pipe(Effect.andThen(Deferred.await(outcome)), Effect.ensuring(Effect.sync(() => channel.port1.close())))
      }),
    ),
  )
  return {
    // This only admits the protocol, not a DB snapshot or durability receipt.
    ready: Deferred.await(ready),
    initialPort: Effect.suspend(() => {
      // A late handshake cannot start a native owner after a never-started close
      // has already permitted the page to release its election lease.
      if (closing === true || initialized === true)
        return Effect.die(new UnknownError({ cause: 'Worker physical lifetime is closing or already initialized' }))
      initialized = true
      return Effect.succeed(channel.port2)
    }),
    close,
  }
})

export type PhysicalWorkerLifetime = Effect.Success<typeof makePhysicalWorkerLifetime>

/** Keep the receipt endpoint outside the scope whose first cleanup it acknowledges. */
export const withPhysicalWorkerLifetime = <A, E, R>(port: MessagePort, physical: Effect.Effect<A, E, R>) =>
  Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const requested = yield* Deferred.make<void>()
      const scope = yield* Scope.make()
      const onMessage = (event: MessageEvent) => {
        if (event.data?.type === 'physical-close') Deferred.doneUnsafe(requested, Effect.void)
      }
      port.addEventListener('message', onMessage)
      port.start()
      yield* Effect.sync(() => port.postMessage({ type: 'physical-ready' }))
      const running = yield* restore(physical).pipe(Scope.provide(scope), Effect.forkChild)
      const wait = Effect.raceFirst(
        Fiber.await(running),
        Deferred.await(requested).pipe(Effect.andThen(Fiber.interrupt(running)), Effect.andThen(Fiber.await(running))),
      )
      const waited = yield* Effect.exit(restore(wait))
      if (Exit.isFailure(waited) === true) yield* Fiber.interrupt(running)
      const body = yield* Fiber.await(running)
      // Repeated Scope.close calls do not join its first finalizer execution.
      // Only this controller closes the scope; duplicate requests share its outcome.
      const closed = yield* Effect.exit(Scope.close(scope, body))
      const success = Exit.isSuccess(closed) && (Exit.isSuccess(body) || Cause.hasInterruptsOnly(body.cause))
      yield* Effect.sync(() => {
        port.removeEventListener('message', onMessage)
        port.postMessage({ type: 'physical-closed', success })
        port.close()
      })
      if (Exit.isFailure(closed) === true) {
        return yield* Effect.failCause(
          Exit.isFailure(body) === true ? Cause.combine(body.cause, closed.cause) : closed.cause,
        )
      }
      if (Exit.isFailure(body) === true) return yield* Effect.failCause(body.cause)
      if (Exit.isFailure(waited) === true) return yield* Effect.failCause(waited.cause)
      return body.value
    }),
  )
