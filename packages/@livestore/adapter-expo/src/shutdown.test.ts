import { expect, test } from 'vitest'

import { IntentionalShutdownCause, UnknownError, type AdapterArgs } from '@livestore/common'
import { Deferred, Effect, Exit, Scope } from '@livestore/utils/effect'

import { createExpoShutdownChannel } from './shutdown.ts'

test('each scope owns an independent shutdown path and preserves typed causes', async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const oldScope = yield* Scope.make()
        yield* createExpoShutdownChannel(() => Effect.void).pipe(Scope.provide(oldScope))
        const received = yield* Deferred.make<Parameters<AdapterArgs['shutdown']>[0]>()
        const current = yield* createExpoShutdownChannel((exit) => Deferred.succeed(received, exit).pipe(Effect.asVoid))
        yield* Scope.close(oldScope, Exit.void)
        const cause = new UnknownError({ cause: 'native storage failure' })
        yield* current.send(cause)
        const exit = yield* Deferred.await(received)
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit) === true) expect(exit.cause).toBeDefined()
      }),
    ),
  )
})

test('intentional shutdown retains its successful exit', async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const received = yield* Deferred.make<unknown>()
        const channel = yield* createExpoShutdownChannel((exit) => Deferred.succeed(received, exit).pipe(Effect.asVoid))
        const cause = new IntentionalShutdownCause({ reason: 'adapter-reset' })
        yield* channel.send(cause)
        expect(yield* Deferred.await(received)).toEqual(Exit.succeed(cause))
      }),
    ),
  )
})
