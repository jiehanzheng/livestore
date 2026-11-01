import type { AdapterArgs } from '@livestore/common'
import { ShutdownChannel } from '@livestore/common/leader-thread'
import { Effect, Exit, Stream, WebChannel, type Scope } from '@livestore/utils/effect'

export const createExpoShutdownChannel = (
  shutdown: AdapterArgs['shutdown'],
): Effect.Effect<ShutdownChannel.ShutdownChannel, never, Scope.Scope> =>
  Effect.gen(function* () {
    // A private scoped queue avoids the process-global same-thread channel cache:
    // disposing an earlier store must never close a later store's shutdown path.
    const proxy = yield* WebChannel.queueChannelProxy({ schema: ShutdownChannel.All })
    yield* Stream.fromQueue(proxy.sendQueue).pipe(
      Stream.runForEach((cause) =>
        shutdown(cause._tag === 'IntentionalShutdownCause' ? Exit.succeed(cause) : Exit.fail(cause)),
      ),
      Effect.interruptible,
      Effect.forkScoped,
    )
    return proxy.webChannel
  })
