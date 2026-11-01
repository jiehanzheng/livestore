import type { AdapterArgs } from '@livestore/common'
import { ShutdownChannel } from '@livestore/common/leader-thread'
import { Effect, Exit, Stream, WebChannel, type Scope } from '@livestore/utils/effect'

export const createShutdownChannel = (
  shutdown: AdapterArgs['shutdown'],
): Effect.Effect<ShutdownChannel.ShutdownChannel, never, Scope.Scope> =>
  Effect.gen(function* () {
    // A per-lifetime queue cannot be closed by a previous same-process Store.
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
