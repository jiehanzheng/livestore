import { expect, it } from 'vitest'

import { LiveDatabaseImportRefusedError, UnknownError } from '@livestore/common'
import { Deferred, Effect, Exit, Fiber, Scope, Stream } from '@livestore/utils/effect'

import { makeLeaderGenerations } from './leader-generations.ts'

const admitted = (frame: string) => frame === 'admitted'

const publish = <A>(generations: Effect.Success<ReturnType<typeof makeLeaderGenerations<A>>>, value: A) =>
  Effect.gen(function* () {
    const { generation } = yield* generations.reserve(crypto.randomUUID(), Effect.void)
    expect(yield* generations.publish(generation, value)).toBe(true)
    return generation
  })

it('refuses a SOURCE read across retirement of its admitted leader', () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const generations = yield* makeLeaderGenerations<string>()
        const old = yield* publish(generations, 'original')
        const opened = yield* Deferred.make<void>()
        yield* generations
          .openSession(() => Stream.concat(Stream.make('admitted'), Stream.never), admitted, 'old-store')
          .pipe(
            Stream.runForEach(() => Deferred.succeed(opened, undefined)),
            Effect.forkScoped,
          )
        yield* Deferred.await(opened)
        expect(yield* generations.runAdmittedRead('old-store', Effect.succeed)).toBe('original')
        const started = yield* Deferred.make<void>()
        const read = yield* generations
          .runAdmittedRead('old-store', () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)))
          .pipe(Effect.exit, Effect.forkScoped)
        yield* Deferred.await(started)
        yield* generations.retire(old)
        yield* publish(generations, 'replacement')
        expect(Exit.isFailure(yield* Fiber.join(read))).toBe(true)
        expect(Exit.isFailure(yield* generations.runAdmittedRead('old-store', Effect.succeed).pipe(Effect.exit))).toBe(
          true,
        )
      }),
    ),
  ))

it('waits for the newer owner to admit a follower and ignores delayed retirement of the old owner', () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const generations = yield* makeLeaderGenerations<Stream.Stream<string>>()
        const oldStarted = yield* Deferred.make<void>()
        const nextStarted = yield* Deferred.make<void>()
        const allowAdmission = yield* Deferred.make<void>()
        const old = yield* publish(
          generations,
          Stream.unwrap(Deferred.succeed(oldStarted, undefined).pipe(Effect.as(Stream.never))),
        )
        const opening = yield* generations
          .openSession((stream) => stream, admitted, 'test-session')
          .pipe(Stream.runCollect, Effect.forkScoped)
        yield* Deferred.await(oldStarted)
        yield* generations.retire(old)
        expect(opening.pollUnsafe()).toBeUndefined()
        const next = yield* publish(
          generations,
          Stream.unwrap(
            Deferred.succeed(nextStarted, undefined).pipe(
              Effect.andThen(Deferred.await(allowAdmission)),
              Effect.as(Stream.make('admitted', 'saved edit')),
            ),
          ),
        )
        yield* Deferred.await(nextStarted)
        expect(yield* generations.retire(old)).toBe(false)
        expect(next.id).toBeGreaterThan(old.id)
        expect(opening.pollUnsafe()).toBeUndefined()
        yield* Deferred.succeed(allowAdmission, undefined)
        expect(yield* Fiber.join(opening)).toEqual(['admitted', 'saved edit'])
      }),
    ),
  ))

it('lets a store-wide shutdown retire the same generation after normal retirement', () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const generations = yield* makeLeaderGenerations<string>()
        const proxyClosed = yield* Deferred.make<void>()
        const { generation: old } = yield* generations.reserve('old', Deferred.succeed(proxyClosed, undefined))
        expect(yield* generations.publish(old, 'old')).toBe(true)
        yield* generations.retireByToken({ generationToken: 'old' })

        const waiting = yield* generations.current.pipe(Effect.forkScoped({ startImmediately: true }))
        expect(waiting.pollUnsafe()).toBeUndefined()
        expect(yield* Deferred.isDone(proxyClosed)).toBe(false)
        let resetInvariants = false
        expect(
          yield* generations.retire(old, () => {
            resetInvariants = true
          }),
        ).toBe(true)
        expect(resetInvariants).toBe(true)
        yield* Deferred.await(proxyClosed)
        yield* publish(generations, 'successor')
        expect(yield* Fiber.join(waiting)).toBe('successor')
      }),
    ),
  ))

it('preserves a refusal committed before retirement, even while its consumer is blocked', () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const refusal = new LiveDatabaseImportRefusedError({ reason: 'Fixture storage is refused' })
        const generations = yield* makeLeaderGenerations<Stream.Stream<string, typeof refusal>>()
        const old = yield* publish(generations, Stream.fail(refusal))
        const refusalObserved = yield* Deferred.make<void>()
        const allowDelivery = yield* Deferred.make<void>()
        const opening = yield* generations
          .openSession((stream) => stream, admitted, 'test-session')
          .pipe(
            Stream.runCollect,
            Effect.exit,
            Effect.tap(() =>
              Deferred.succeed(refusalObserved, undefined).pipe(Effect.andThen(Deferred.await(allowDelivery))),
            ),
            Effect.forkScoped,
          )
        yield* Deferred.await(refusalObserved)
        yield* generations.retire(old)
        yield* publish(generations, Stream.make('admitted'))
        yield* Deferred.succeed(allowDelivery, undefined)
        expect(yield* Fiber.join(opening)).toEqual(Exit.fail(refusal))
      }),
    ),
  ))

it('ends an admitted stream on retirement without attaching it to a successor', () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const generations = yield* makeLeaderGenerations<Stream.Stream<string>>()
        const first = yield* Deferred.make<void>()
        const allowDelivery = yield* Deferred.make<void>()
        const old = yield* publish(generations, Stream.make('admitted').pipe(Stream.concat(Stream.never)))
        const session = yield* generations
          .openSession((stream) => stream, admitted, 'test-session')
          .pipe(
            Stream.tap(() => Deferred.succeed(first, undefined).pipe(Effect.andThen(Deferred.await(allowDelivery)))),
            Stream.runCollect,
            Effect.forkScoped,
          )
        yield* Deferred.await(first)
        yield* generations.retire(old)
        yield* publish(generations, Stream.make('admitted', 'other generation'))
        yield* Deferred.succeed(allowDelivery, undefined)
        expect(yield* Fiber.join(session)).toEqual(['admitted'])
      }),
    ),
  ))

it('settles an installing failure for existing and late followers and ignores stale failure', () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const generations = yield* makeLeaderGenerations<Stream.Stream<string>>()
        const failure = new UnknownError({ cause: 'Fixture proxy setup failed' })
        const open = generations
          .openSession((stream) => stream, admitted, 'test-session')
          .pipe(Stream.runCollect, Effect.exit)
        const { generation } = yield* generations.reserve(crypto.randomUUID(), Effect.void)
        const opening = yield* open.pipe(Effect.forkScoped({ startImmediately: true }))
        expect(opening.pollUnsafe()).toBeUndefined()
        yield* generations.fail(generation, failure)
        expect(yield* Fiber.join(opening)).toEqual(Exit.fail(failure))
        expect(yield* open).toEqual(Exit.fail(failure))
        yield* publish(generations, Stream.make('admitted'))
        yield* generations.fail(generation, failure)
        expect(yield* open).toEqual(Exit.succeed(['admitted']))
      }),
    ),
  ))

it('joins the first exact generation scope close before replacement setup proceeds', () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const generations = yield* makeLeaderGenerations<string>()
        const scope = yield* Scope.make()
        const entered = yield* Deferred.make<void>()
        const allowClose = yield* Deferred.make<void>()
        let calls = 0
        yield* Scope.addFinalizer(
          scope,
          Effect.gen(function* () {
            calls++
            yield* Deferred.succeed(entered, undefined)
            yield* Deferred.await(allowClose)
          }),
        )
        const { generation } = yield* generations.reserve(crypto.randomUUID(), Scope.close(scope, Exit.void))
        yield* generations.publish(generation, 'old')
        // The listener is scoped inside the generation. The close controller isn't.
        const listener = yield* generations.retire(generation).pipe(Effect.forkIn(scope))
        yield* Deferred.await(entered)
        const { generation: successor, previous } = yield* generations.reserve(crypto.randomUUID(), Effect.void)
        expect(previous).toBe(generation)
        const installing = yield* generation.close.pipe(
          Effect.andThen(generations.publish(successor, 'new')),
          Effect.forkScoped,
        )
        expect(installing.pollUnsafe()).toBeUndefined()
        expect(calls).toBe(1)
        yield* Deferred.succeed(allowClose, undefined)
        yield* Fiber.await(listener)
        expect(yield* Fiber.join(installing)).toBe(true)
        expect(yield* generations.retire(generation)).toBe(false)
        expect(yield* generations.current).toBe('new')
        expect(calls).toBe(1)
      }),
    ),
  ))

it('does not turn unconfirmed upstream completion into a successor wait', () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const generations = yield* makeLeaderGenerations<Stream.Stream<string>>()
        yield* publish(generations, Stream.empty)
        expect(
          yield* generations.openSession((stream) => stream, admitted, 'test-session').pipe(Stream.runCollect),
        ).toEqual([])
      }),
    ),
  ))

it('drops completed predecessor obligations across many generations', () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const generations = yield* makeLeaderGenerations<number>()
        let closes = 0
        for (let value = 0; value < 32; value++) {
          const { generation, previous } = yield* generations.reserve(
            crypto.randomUUID(),
            Effect.sync(() => {
              closes++
            }),
          )
          expect(previous).toBeUndefined()
          expect(yield* generations.publish(generation, value)).toBe(true)
          if (value % 2 === 0) expect(yield* generations.retire(generation)).toBe(true)
          yield* generation.close
        }
        expect(closes).toBe(32)
      }),
    ),
  ))

it('joins one close across retirement, concurrent callers, interrupted waiter, and owner shutdown', () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const owner = yield* Scope.make()
        const generations = yield* makeLeaderGenerations<string>().pipe(Scope.provide(owner))
        const closing = yield* Deferred.make<void>()
        const allowClose = yield* Deferred.make<void>()
        let calls = 0
        const { generation } = yield* generations.reserve(
          crypto.randomUUID(),
          Effect.gen(function* () {
            calls++
            yield* Deferred.succeed(closing, undefined)
            yield* Deferred.await(allowClose)
          }),
        )
        yield* generations.publish(generation, 'old')
        yield* generations.retire(generation)
        yield* Deferred.await(closing)
        const waiter = yield* generation.close.pipe(Effect.forkScoped({ startImmediately: true }))
        const duplicate = yield* generation.close.pipe(Effect.forkScoped({ startImmediately: true }))
        const interrupt = yield* Fiber.interrupt(waiter).pipe(Effect.forkScoped({ startImmediately: true }))
        const shutdown = yield* Scope.close(owner, Exit.void).pipe(Effect.forkScoped({ startImmediately: true }))
        expect(waiter.pollUnsafe()).toBeUndefined()
        expect(duplicate.pollUnsafe()).toBeUndefined()
        expect(shutdown.pollUnsafe()).toBeUndefined()
        expect(calls).toBe(1)
        yield* Deferred.succeed(allowClose, undefined)
        yield* Fiber.join(interrupt)
        yield* Fiber.join(duplicate)
        yield* Fiber.join(shutdown)
        yield* generation.close
        expect(calls).toBe(1)
      }),
    ),
  ))

it('preserves the first failed cleanup after later successful scope closes', () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const owner = yield* Scope.make()
        const generations = yield* makeLeaderGenerations<string>().pipe(Scope.provide(owner))
        const failure = new Error('First generation close failed')
        let failedCloses = 0
        let otherCloses = 0
        const { generation } = yield* generations.reserve(
          crypto.randomUUID(),
          Effect.sync(() => {
            failedCloses++
            throw failure
          }),
        )
        yield* generations.publish(generation, 'old')
        yield* generations.retire(generation)
        const first = yield* Effect.exit(generation.close)
        expect(first).toEqual(Exit.die(failure))
        expect(yield* Effect.exit(generation.close)).toEqual(first)

        const { generation: skipped, previous } = yield* generations.reserve(crypto.randomUUID(), Effect.void)
        expect(previous).toBeUndefined()
        expect(yield* Effect.exit(generations.awaitPredecessor(previous))).toEqual(first)
        expect(yield* generations.publish(skipped, 'unsafe')).toBe(false)
        yield* skipped.close

        const { generation: other, previous: previousOther } = yield* generations.reserve(
          crypto.randomUUID(),
          Effect.sync(() => {
            otherCloses++
          }),
        )
        expect(previousOther).toBeUndefined()
        expect(yield* generations.publish(other, 'still unsafe')).toBe(false)
        expect(yield* Effect.exit(Scope.close(owner, Exit.void))).toEqual(first)
        expect(otherCloses).toBe(1)
        expect(failedCloses).toBe(1)
      }),
    ),
  ))
