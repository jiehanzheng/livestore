import { UnknownError } from '@livestore/common'
import { Cause, Deferred, Effect, Exit, Fiber, Scope } from '@livestore/utils/effect'

export type PhysicalWorkerCloseOutcome = 'never-started' | 'joined-clean' | 'witnessed-realm-loss'

/** One control channel belongs to exactly one receiving physical scope. */
const makePhysicalWorkerLifetimeInternal = (realmLost?: AbortSignal) =>
  Effect.gen(function* () {
    const channel = new MessageChannel()
    const outcome = yield* Deferred.make<PhysicalWorkerCloseOutcome, UnknownError>()
    const armed = yield* Deferred.make<void, UnknownError>()
    let prepared = false
    let committed = false
    let closing = false
    const closed = new UnknownError({ cause: 'Worker physical lifetime is closing' })
    const failed = () => {
      const error = new UnknownError({ cause: 'Worker physical close failed or could not be confirmed' })
      Deferred.doneUnsafe(outcome, Effect.fail(error))
      Deferred.doneUnsafe(armed, Effect.fail(error))
    }
    const lost = new UnknownError({ cause: 'Dedicated worker realm was witnessed lost' })
    const onRealmLoss = () => {
      Deferred.doneUnsafe(outcome, Effect.succeed('witnessed-realm-loss'))
      Deferred.doneUnsafe(armed, Effect.fail(lost))
    }
    realmLost?.addEventListener('abort', onRealmLoss, { once: true })
    if (realmLost?.aborted === true) onRealmLoss()

    channel.port1.onmessage = (event) => {
      if (event.data?.type === 'physical-armed') {
        Deferred.doneUnsafe(armed, Effect.void)
        return
      }
      if (committed === false || event.data?.type !== 'physical-closed' || typeof event.data.success !== 'boolean')
        return
      if (event.data.success === true) Deferred.doneUnsafe(outcome, Effect.succeed('joined-clean'))
      else failed()
    }
    channel.port1.onmessageerror = failed
    channel.port1.start()

    const postClose = Effect.try({
      try: () => channel.port1.postMessage({ type: 'physical-close' }),
      catch: (cause) => new UnknownError({ cause }),
    })
    const close = yield* Effect.cached(
      Effect.uninterruptible(
        Effect.suspend(() => {
          closing = true
          Deferred.doneUnsafe(armed, Effect.fail(closed))
          // Encoding the outer RPC may buffer or fail before native delivery.
          // Without a start frame the receiver cannot open storage, even if init arrives late.
          if (committed === false) {
            const result: PhysicalWorkerCloseOutcome =
              realmLost?.aborted === true ? 'witnessed-realm-loss' : 'never-started'
            return (prepared === true && realmLost?.aborted !== true ? Effect.ignore(postClose) : Effect.void).pipe(
              Effect.as<PhysicalWorkerCloseOutcome>(result),
              Effect.ensuring(
                Effect.sync(() => {
                  channel.port1.close()
                  channel.port2.close()
                }),
              ),
            )
          }
          return (realmLost?.aborted === true ? Effect.void : postClose).pipe(
            Effect.andThen(Deferred.await(outcome)),
            Effect.ensuring(Effect.sync(() => channel.port1.close())),
          )
        }),
      ).pipe(Effect.ensuring(Effect.sync(() => realmLost?.removeEventListener('abort', onRealmLoss)))),
    )
    return {
      initialPort: Effect.suspend(() => {
        if (realmLost?.aborted === true) return Effect.die(lost)
        if (closing === true || prepared === true)
          return Effect.die(new UnknownError({ cause: 'Worker physical lifetime is closing or already prepared' }))
        prepared = true
        return Effect.succeed(channel.port2)
      }),
      start: Deferred.await(armed).pipe(
        Effect.andThen(
          Effect.try({
            try: () => {
              if (realmLost?.aborted === true) throw lost
              if (closing === true) throw closed
              if (committed === true) throw new UnknownError({ cause: 'Worker physical lifetime is already started' })
              channel.port1.postMessage({ type: 'physical-start' })
              committed = true
            },
            catch: (cause) => new UnknownError({ cause }),
          }),
        ),
      ),
      close,
    }
  })

/** The signal must attest to loss of this exact dedicated worker realm. */
export const makePhysicalWorkerLifetimeWithRealmLoss = (realmLost: AbortSignal) =>
  makePhysicalWorkerLifetimeInternal(realmLost)

// Legacy endpoints have no authoritative realm-loss signal.
export const makePhysicalWorkerLifetime = makePhysicalWorkerLifetimeInternal().pipe(
  Effect.map((lifetime) => ({ ...lifetime, close: lifetime.close.pipe(Effect.asVoid) })),
)

export type PhysicalWorkerLifetime = Effect.Success<typeof makePhysicalWorkerLifetime>

/** An ambient worker can exist before the RPC transport installs its finalizer. */
export const acquirePhysicalWorker = <Endpoint extends Worker | MessagePort | { readonly port: MessagePort }>(
  spawn: () => Endpoint,
  lifetime: Pick<PhysicalWorkerLifetime, 'close'>,
) =>
  Effect.acquireRelease(Effect.sync(spawn), (worker) =>
    'terminate' in worker
      ? lifetime.close.pipe(
          Effect.orDie,
          Effect.andThen(
            Effect.sync(() => {
              if (typeof worker.terminate === 'function') worker.terminate()
            }),
          ),
        )
      : Effect.void,
  )

/** Keep the receipt endpoint outside the scope whose first cleanup it acknowledges. */
export const withPhysicalWorkerLifetime = <A, E, R>(port: MessagePort, physical: Effect.Effect<A, E, R>) =>
  Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const command = yield* Deferred.make<'start' | 'close'>()
      const requested = yield* Deferred.make<void>()
      const onMessage = (event: MessageEvent) => {
        if (event.data?.type === 'physical-start') Deferred.doneUnsafe(command, Effect.succeed('start'))
        if (event.data?.type === 'physical-close') {
          Deferred.doneUnsafe(command, Effect.succeed('close'))
          Deferred.doneUnsafe(requested, Effect.void)
        }
      }
      return yield* Effect.gen(function* () {
        yield* Effect.sync(() => {
          port.addEventListener('message', onMessage)
          port.start()
          port.postMessage({ type: 'physical-armed' })
        })
        if ((yield* restore(Deferred.await(command))) === 'close') return

        const scope = yield* Scope.make()
        const running = yield* restore(physical).pipe(Scope.provide(scope), Effect.forkChild)
        const wait = Effect.raceFirst(
          Fiber.await(running),
          Deferred.await(requested).pipe(
            Effect.andThen(Fiber.interrupt(running)),
            Effect.andThen(Fiber.await(running)),
          ),
        )
        const waited = yield* Effect.exit(restore(wait))
        if (Exit.isFailure(waited) === true) yield* Fiber.interrupt(running)
        const body = yield* Fiber.await(running)
        // Repeated Scope.close calls do not join its first finalizer execution.
        // Only this controller closes the scope; duplicate requests share its outcome.
        const closed = yield* Effect.exit(Scope.close(scope, body))
        const success = Exit.isSuccess(closed) && (Exit.isSuccess(body) || Cause.hasInterruptsOnly(body.cause))
        yield* Effect.sync(() => port.postMessage({ type: 'physical-closed', success }))
        if (Exit.isFailure(closed) === true) {
          return yield* Effect.failCause(
            Exit.isFailure(body) === true ? Cause.combine(body.cause, closed.cause) : closed.cause,
          )
        }
        if (Exit.isFailure(body) === true) return yield* Effect.failCause(body.cause)
        if (Exit.isFailure(waited) === true) return yield* Effect.failCause(waited.cause)
        return body.value
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            port.removeEventListener('message', onMessage)
            port.close()
          }),
        ),
      )
    }),
  )
