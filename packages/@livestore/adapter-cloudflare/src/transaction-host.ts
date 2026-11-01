import { SqliteError, type SqliteTransactionHost } from '@livestore/common'
import type { CfTypes } from '@livestore/common-cf'
import { Cause, Context, Effect, Exit, Option, Semaphore } from '@livestore/utils/effect'

type TransactionFrame = {
  host: SqliteTransactionHost
  active: boolean
  ownerFiberId: number | undefined
  tainted: Cause.Cause<SqliteError> | undefined
}

class ActiveTransaction extends Context.Service<ActiveTransaction, TransactionFrame>()(
  '@livestore/adapter-cloudflare/ActiveTransaction',
) {}

/** A failed outer commit can leave WASM's page cache ahead of durable VFS pages; that owner cannot be reused. */
export const makeTransactionHost = (
  storage: CfTypes.DurableObjectStorage,
  closeState: () => void,
): SqliteTransactionHost => {
  const semaphore = Semaphore.makeUnsafe(1)
  let failed = false
  const host: SqliteTransactionHost = {
    sourceNamespace: 'durable-object',
    runTransaction: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.gen(function* () {
        const current = yield* Effect.serviceOption(ActiveTransaction)
        const fiberId = yield* Effect.fiberId
        if (
          Option.isSome(current) === true &&
          current.value.host === host &&
          current.value.active === true &&
          current.value.ownerFiberId === fiberId
        ) {
          const frame = current.value
          return yield* effect.pipe(
            Effect.onExit((exit) =>
              Effect.sync(() => {
                if (Exit.isFailure(exit) === true) {
                  const nested = Cause.fail(
                    new SqliteError({
                      cause: exit.cause,
                      note: 'Nested host transaction failed; outer transaction must roll back',
                    }),
                  )
                  frame.tainted = frame.tainted === undefined ? nested : Cause.combine(frame.tainted, nested)
                }
              }),
            ),
          )
        }
        return yield* semaphore.withPermit(
          Effect.gen(function* () {
            if (failed === true)
              return yield* new SqliteError({ cause: 'Durable Object transaction owner is fenced until reopen' })
            const services = yield* Effect.context<R>()
            return yield* Effect.callback<A, E | SqliteError>((resume, signal) => {
              const frame: TransactionFrame = { host, active: true, ownerFiberId: undefined, tainted: undefined }
              const callbackFailed = new Error('LiveStore transaction callback failed')
              let callbackCause: Cause.Cause<E | SqliteError> | undefined
              const settled = storage
                .transaction(async () => {
                  try {
                    const exit = await Effect.runPromiseExitWith(services)(
                      Effect.gen(function* () {
                        frame.ownerFiberId = yield* Effect.fiberId
                        return yield* effect
                      }).pipe(Effect.provideService(ActiveTransaction, frame)),
                      { signal },
                    )
                    if (Exit.isFailure(exit) === true) {
                      callbackCause = exit.cause
                      throw callbackFailed
                    }
                    if (frame.tainted !== undefined) {
                      callbackCause = frame.tainted
                      throw callbackFailed
                    }
                    return exit.value
                  } finally {
                    // Child fibers never join this frame; even the owning fiber loses it once its callback completes.
                    frame.active = false
                  }
                })
                .then(async (value) => {
                  await storage.sync()
                  return Exit.succeed(value)
                })
                .catch((error: unknown): Exit.Exit<A, E | SqliteError> => {
                  failed = true
                  let cause: Cause.Cause<E | SqliteError> =
                    callbackCause === undefined
                      ? Cause.fail(
                          new SqliteError({
                            cause: error,
                            note: 'Durable Object transaction or durability confirmation failed',
                          }),
                        )
                      : error === callbackFailed
                        ? callbackCause
                        : Cause.combine(
                            callbackCause,
                            Cause.fail(
                              new SqliteError({ cause: error, note: 'Host rollback failed after callback failure' }),
                            ),
                          )
                  try {
                    closeState()
                  } catch (closeError) {
                    cause = Cause.combine(
                      cause,
                      Cause.fail(new SqliteError({ cause: closeError, note: 'Failed to close fenced WASM state' })),
                    )
                  }
                  return Exit.failCause(cause)
                })
              void settled.then((exit) =>
                resume(Exit.isSuccess(exit) === true ? Effect.succeed(exit.value) : Effect.failCause(exit.cause)),
              )
              // Cancellation aborts the nested Effect but must join native rollback and state close before releasing the permit.
              return Effect.promise(async () => {
                await settled
              })
            })
          }),
        )
      }),
  }
  return host
}
