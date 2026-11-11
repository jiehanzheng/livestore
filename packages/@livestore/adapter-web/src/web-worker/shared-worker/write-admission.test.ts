import { expect, it } from 'vitest'

import { Cause, Deferred, Effect, Exit, Fiber, Schema, Stream } from '@livestore/utils/effect'

import {
  LeaderWorkerInnerOpenSession,
  LeaderWorkerInnerPushToLeader,
  SharedWorkerOpenWriteSession,
  SharedWorkerPushAdmittedWrite,
} from '../common/worker-schema.ts'
import { LeaderWriteUnconfirmed, StaleWriteAdmission } from '../common/write-admission-errors.ts'
import { makeLeaderGenerations } from './leader-generations.ts'

const makeFixture = Effect.gen(function* () {
  const generations = yield* makeLeaderGenerations<'first' | 'successor'>()
  const publish = (owner: 'first' | 'successor') =>
    Effect.gen(function* () {
      const { generation } = yield* generations.reserve(owner, Effect.void)
      expect(yield* generations.publish(generation, owner)).toBe(true)
    })
  const open = (id: string) =>
    Effect.gen(function* () {
      const admitted = yield* Deferred.make<void>()
      const stream = yield* generations
        .openSession(
          (owner) => Stream.concat(Stream.succeed(owner), Stream.never),
          () => true,
          id,
        )
        .pipe(
          Stream.tap(() => Deferred.succeed(admitted, undefined)),
          Stream.runDrain,
          Effect.forkScoped,
        )
      yield* Deferred.await(admitted)
      return stream
    })
  yield* publish('first')
  return { generations, publish, open }
})

it('rejects missing, retired and closed admissions and writes through a fresh admission', () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const { generations, publish, open } = yield* makeFixture
        const write = (session: string) => generations.runAdmittedWrite(session, Effect.succeed).pipe(Effect.exit)
        expect(yield* write('old')).toEqual(Exit.fail(new StaleWriteAdmission({})))
        yield* open('old')
        expect(yield* write('old')).toEqual(Exit.succeed('first'))
        yield* publish('successor')
        expect(yield* write('old')).toEqual(Exit.fail(new StaleWriteAdmission({})))
        const next = yield* open('next')
        expect(yield* write('next')).toEqual(Exit.succeed('successor'))
        yield* Fiber.interrupt(next)
        expect(yield* write('next')).toEqual(Exit.fail(new StaleWriteAdmission({})))
      }),
    ),
  ))

it('rejects a duplicate admission without revoking the first stream', () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const { generations, open } = yield* makeFixture
        yield* open('duplicate')
        const duplicate = yield* generations
          .openSession(
            () => Stream.succeed('admitted'),
            () => true,
            'duplicate',
          )
          .pipe(Stream.runDrain, Effect.exit)
        expect(Exit.isFailure(duplicate) && Cause.squash(duplicate.cause)).toMatchObject({ _tag: 'UnknownError' })
        expect(yield* generations.runAdmittedWrite('duplicate', Effect.succeed)).toBe('first')

        yield* generations.retireByToken({ generationToken: 'first' })
        let dispatched = false
        const write = yield* generations
          .runAdmittedWrite('duplicate', () =>
            Effect.sync(() => {
              dispatched = true
            }),
          )
          .pipe(Effect.exit)
        expect(write).toEqual(Exit.fail(new StaleWriteAdmission({})))
        expect(dispatched).toBe(false)
      }),
    ),
  ))

it('reports loss of an in-flight acknowledgement without replaying the write', () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const { generations, publish, open } = yield* makeFixture
        yield* open('old')
        const dispatched = yield* Deferred.make<void>()
        const transportInterrupted = yield* Deferred.make<void>()
        const calls: string[] = []
        const write = yield* generations
          .runAdmittedWrite('old', (owner) =>
            Effect.sync(() => calls.push(owner)).pipe(
              Effect.andThen(Deferred.succeed(dispatched, undefined)),
              Effect.andThen(Deferred.await(transportInterrupted)),
              Effect.andThen(Effect.interrupt),
            ),
          )
          .pipe(Effect.forkScoped)
        yield* Deferred.await(dispatched)
        yield* publish('successor')
        yield* Deferred.succeed(transportInterrupted, undefined)
        expect(yield* Fiber.await(write)).toEqual(Exit.fail(new LeaderWriteUnconfirmed({})))
        expect(calls).toEqual(['first'])
      }),
    ),
  ))

it('preserves cancellation while the admitted owner is live', () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const { generations, open } = yield* makeFixture
        yield* open('first')
        const dispatched = yield* Deferred.make<void>()
        const write = yield* generations
          .runAdmittedWrite('first', () => Deferred.succeed(dispatched, undefined).pipe(Effect.andThen(Effect.never)))
          .pipe(Effect.forkScoped)
        yield* Deferred.await(dispatched)
        yield* Fiber.interrupt(write)
        const exit = yield* Fiber.await(write)
        expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
        expect(yield* generations.runAdmittedWrite('first', Effect.succeed)).toBe('first')
      }),
    ),
  ))

it('requires the capability only on the page-to-coordinator wire and preserves both error tags', () => {
  expect(SharedWorkerOpenWriteSession.payloadSchema.fields.writeSessionId).toBe(Schema.String)
  expect(LeaderWorkerInnerOpenSession.payloadSchema.fields).not.toHaveProperty('writeSessionId')
  expect(Schema.decodeSync(LeaderWorkerInnerPushToLeader.payloadSchema)({ batch: [] })).toEqual({ batch: [] })
  expect(() => Schema.decodeUnknownSync(SharedWorkerPushAdmittedWrite.payloadSchema)({ batch: [] })).toThrow()
  expect(
    Schema.decodeSync(SharedWorkerPushAdmittedWrite.payloadSchema)({ batch: [], writeSessionId: 'session' }),
  ).toEqual({ batch: [], writeSessionId: 'session' })

  const decode = Schema.decodeUnknownSync(SharedWorkerPushAdmittedWrite.errorSchema)
  const encode = Schema.encodeSync(SharedWorkerPushAdmittedWrite.errorSchema)
  for (const error of [new StaleWriteAdmission({}), new LeaderWriteUnconfirmed({})]) {
    expect(decode(encode(error))).toEqual(error)
  }
})
