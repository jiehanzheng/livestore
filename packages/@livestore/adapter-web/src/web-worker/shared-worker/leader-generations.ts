import { UnknownError } from '@livestore/common'
import { Cause, Deferred, Effect, Exit, Scope, Stream, SubscriptionRef } from '@livestore/utils/effect'

import { isRpcClientError } from '../common/rpc-worker.ts'
import { LeaderWriteUnconfirmed, StaleWriteAdmission } from '../common/write-admission-errors.ts'

type Generation<Context> = {
  readonly id: number
  readonly token: string
  readonly ready: Deferred.Deferred<Context, UnknownError>
  readonly retired: Deferred.Deferred<void>
  readonly closeRequested: Deferred.Deferred<void>
  readonly close: Effect.Effect<void>
}

const generationRetired = Symbol('Leader generation retired')

const untilRetired = <A, E, R>(effect: Effect.Effect<A, E, R>, retired: Deferred.Deferred<void>) =>
  Effect.gen(function* () {
    const result = yield* Effect.raceFirst(
      Effect.exit(effect),
      Deferred.await(retired).pipe(Effect.as<typeof generationRetired>(generationRetired)),
    )
    if (result === generationRetired) return yield* Effect.fail<typeof generationRetired>(generationRetired)
    if (Exit.isFailure(result) === true) {
      // The retired transport can interrupt its pull before the retirement waiter resumes.
      if (Cause.hasInterruptsOnly(result.cause) === true && (yield* Deferred.isDone(retired)) === true)
        return yield* Effect.fail<typeof generationRetired>(generationRetired)
      return yield* Effect.failCause(result.cause)
    }
    return result.value
  })

export const makeLeaderGenerations = <Context>() =>
  Effect.gen(function* () {
    const ownerScope = yield* Effect.scope
    const current = yield* SubscriptionRef.make<Generation<Context> | undefined>(undefined)
    const controllers = yield* Scope.make()
    const pending = new Map<number, Generation<Context>>()
    const writeAdmissions = new Map<string, { generation: Generation<Context>; context: Context }>()
    let cleanupFailure: Cause.Cause<never> | undefined
    let sealed = false
    let nextId = 0
    const assertCleanup = Effect.suspend(() =>
      cleanupFailure === undefined ? Effect.void : Effect.failCause(cleanupFailure),
    )

    yield* Scope.addFinalizer(
      ownerScope,
      Effect.gen(function* () {
        sealed = true
        yield* Effect.forEach([...pending.values()], (generation) => Effect.exit(generation.close), {
          concurrency: 'unbounded',
          discard: true,
        })
        yield* Scope.close(controllers, Exit.void)
        yield* assertCleanup
      }),
    )
    const waitAfter = (id: number) =>
      SubscriptionRef.waitUntil(
        current,
        (value): value is Generation<Context> =>
          value !== undefined && value.id > id && Deferred.isDoneUnsafe(value.retired) === false,
      )
    const isRetirement = (error: unknown): error is typeof generationRetired => error === generationRetired
    const awaitCurrent = (id: number): Effect.Effect<Context, UnknownError> =>
      waitAfter(id).pipe(
        Effect.flatMap((generation) =>
          untilRetired(Deferred.await(generation.ready), generation.retired).pipe(
            Effect.catchIf(isRetirement, () => awaitCurrent(generation.id)),
          ),
        ),
      )

    const retireAndClose = (generation: Generation<Context>) => {
      Deferred.doneUnsafe(generation.retired, Effect.void)
      Deferred.doneUnsafe(generation.closeRequested, Effect.void)
    }

    const reserve = (token: string, closeScope: Effect.Effect<void>) =>
      Effect.gen(function* () {
        const id = ++nextId
        const ready = yield* Deferred.make<Context, UnknownError>()
        const retired = yield* Deferred.make<void>()
        const closeRequested = yield* Deferred.make<void>()
        const closed = yield* Deferred.make<Exit.Exit<void>>()
        let started = false
        const close = Effect.gen(function* () {
          // Scope.close itself doesn't join a duplicate caller. Store the first Exit,
          // including a failed cleanup, before removing this live obligation.
          if (started === false) {
            started = true
            const exit = yield* Effect.exit(closeScope)
            yield* Effect.sync(() => {
              if (Exit.isFailure(exit) === true) cleanupFailure ??= exit.cause
              pending.delete(id)
              Deferred.doneUnsafe(closed, Effect.succeed(exit))
            })
          }
          const exit = yield* Deferred.await(closed)
          if (Exit.isFailure(exit) === true) return yield* Effect.failCause(exit.cause)
        }).pipe(Effect.uninterruptible)
        const generation = { id, token, ready, retired, closeRequested, close }
        const reservation = yield* SubscriptionRef.modify(current, (active) => {
          if (sealed === true) return [undefined, active]
          const previous = [...pending.values()].at(-1)
          pending.set(id, generation)
          if (active !== undefined) retireAndClose(active)
          return [{ generation, previous }, generation]
        })
        if (reservation === undefined) {
          yield* close
          return yield* Effect.die(new Error('Leader generation owner is closed'))
        }
        // This observer can be retired from inside the generation it owns.
        yield* Effect.raceFirst(Deferred.await(closeRequested), Deferred.await(closed).pipe(Effect.asVoid)).pipe(
          Effect.andThen(Effect.exit(close)),
          Effect.forkIn(controllers),
        )
        return reservation
      }).pipe(Effect.uninterruptible)
    const fail = (generation: Generation<Context>, error: UnknownError) =>
      SubscriptionRef.modify(current, (active) => {
        if (active === generation) Deferred.doneUnsafe(generation.ready, Effect.fail(error))
        return [undefined, active]
      })

    const markRetired = (matches: (generation: Generation<Context>) => boolean) =>
      SubscriptionRef.modify(current, (active) => {
        // Keep the observer until replacement so a late store-wide shutdown can still reset invariants.
        if (active !== undefined && matches(active) === true) Deferred.doneUnsafe(active.retired, Effect.void)
        return [undefined, active]
      })

    const install = <A, E, R, E2, R2>(
      token: string,
      close: Effect.Effect<void>,
      prepare: (generation: Generation<Context>) => Effect.Effect<void, E, R>,
      activate: (reservation: {
        generation: Generation<Context>
        previous: Generation<Context> | undefined
      }) => Effect.Effect<A, E2, R2>,
    ) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const reservation = yield* reserve(token, close)
          const { generation } = reservation
          // Cancellation cannot pass the reservation before cleanup and the shutdown observer own it.
          return yield* Effect.suspend(() => prepare(generation)).pipe(
            Effect.andThen(restore(Effect.suspend(() => activate(reservation)))),
            Effect.onExit((exit) => {
              if (Exit.isSuccess(exit) === true) return Effect.void
              if (Cause.hasInterruptsOnly(exit.cause) === true) return markRetired((active) => active === generation)
              return fail(generation, UnknownError.make({ cause: Cause.squash(exit.cause) })).pipe(
                Effect.andThen(generation.close),
              )
            }),
          )
        }),
      )

    return {
      current: awaitCurrent(0),
      assertCleanup,
      awaitPredecessor: (previous: Generation<Context> | undefined) =>
        (previous?.close ?? Effect.void).pipe(Effect.andThen(assertCleanup)),
      reserve,
      install,
      publish: (generation: Generation<Context>, context: Context) =>
        SubscriptionRef.modify(current, (active) => {
          if (
            active !== generation ||
            sealed === true ||
            cleanupFailure !== undefined ||
            Deferred.isDoneUnsafe(generation.retired) === true
          )
            return [false, active]
          Deferred.doneUnsafe(generation.ready, Effect.succeed(context))
          return [true, active]
        }),
      fail,
      retire: (expected: Generation<Context>, onRetired?: () => void) =>
        SubscriptionRef.modify(current, (active) => {
          if (active !== expected) return [false, active]
          retireAndClose(active)
          onRetired?.()
          return [true, undefined]
        }),
      retireByToken: ({ generationToken }: { readonly generationToken: string }) =>
        markRetired((active) => active.token === generationToken),
      runAdmittedWrite: <A, E, R>(sessionId: string, write: (context: Context) => Effect.Effect<A, E, R>) =>
        Effect.gen(function* () {
          const admission = writeAdmissions.get(sessionId)
          if (admission === undefined) return yield* new StaleWriteAdmission({})
          const { generation, context } = admission
          let dispatched = false
          return yield* untilRetired(
            Effect.suspend<A, E | StaleWriteAdmission | LeaderWriteUnconfirmed, R>(() => {
              if (writeAdmissions.get(sessionId) !== admission || Deferred.isDoneUnsafe(generation.retired) === true)
                return Effect.fail(new StaleWriteAdmission({}))
              dispatched = true
              // Transport can fail before retirement is observed, after the dedicated worker accepted the write.
              return write(context).pipe(
                Effect.mapError((error) => (isRpcClientError(error) === true ? new LeaderWriteUnconfirmed({}) : error)),
              )
            }),
            generation.retired,
          ).pipe(
            Effect.catchIf(isRetirement, () =>
              Effect.fail(dispatched === true ? new LeaderWriteUnconfirmed({}) : new StaleWriteAdmission({})),
            ),
          )
        }),
      openSession: <Frame, E, R>(
        open: (context: Context) => Stream.Stream<Frame, E, R>,
        isAdmission: (frame: Frame) => boolean,
        writeSessionId: string,
      ) =>
        Stream.unwrap(
          Effect.sync(() => {
            let registered = false
            const after = (id: number): Stream.Stream<Frame, E | UnknownError, R> =>
              Stream.unwrap(
                Effect.gen(function* () {
                  const generation = yield* waitAfter(id)
                  let admitted = false
                  const stream = Stream.unwrap(
                    untilRetired(Deferred.await(generation.ready), generation.retired).pipe(
                      Effect.map((context) =>
                        // No parallel stream producer may buffer and then discard the first frame.
                        Stream.transformPull(open(context), (pull) =>
                          Effect.succeed(
                            Effect.gen(function* () {
                              if (admitted === true && (yield* Deferred.isDone(generation.retired)) === true)
                                return yield* Effect.fail<typeof generationRetired>(generationRetired)
                              const chunk = yield* untilRetired(pull, generation.retired)
                              if (admitted === false && chunk.some(isAdmission) === true) {
                                if (writeAdmissions.has(writeSessionId) === true)
                                  return yield* UnknownError.make({ cause: 'Duplicate write admission' })
                                writeAdmissions.set(writeSessionId, { generation, context })
                                registered = true
                                admitted = true
                              }
                              return chunk
                            }),
                          ),
                        ),
                      ),
                    ),
                  )
                  return stream.pipe(
                    Stream.catchIf(isRetirement, () => (admitted === true ? Stream.empty : after(generation.id))),
                  )
                }),
              )
            // The capability lives only as long as the admitted stream, including when its page cancels it.
            return after(0).pipe(
              Stream.ensuring(
                Effect.sync(() => {
                  if (registered === true) writeAdmissions.delete(writeSessionId)
                }),
              ),
            )
          }),
        ),
    }
  })
