import { Effect, type Scope, Stream, Subscribable, SubscriptionRef } from '@livestore/utils/effect'

import type { SyncBackend } from '../sync/sync.ts'
import type { DevtoolsContext } from './types.ts'

/** @internal */
export const makeNetworkStatusSubscribable = ({
  syncBackend,
  devtoolsContext,
}: {
  syncBackend: SyncBackend.SyncBackend | undefined
  devtoolsContext: DevtoolsContext
}): Effect.Effect<Subscribable.Subscribable<SyncBackend.NetworkStatus>, never, Scope.Scope> =>
  Effect.gen(function* () {
    const initialIsConnected = syncBackend !== undefined ? yield* SubscriptionRef.get(syncBackend.isConnected) : false
    const initialLatchClosed =
      devtoolsContext.enabled === true
        ? (yield* SubscriptionRef.get(devtoolsContext.syncBackendLatchState)).latchClosed
        : false

    const networkStatusRef = yield* SubscriptionRef.make<SyncBackend.NetworkStatus>({
      isConnected: initialIsConnected,
      timestampMs: Date.now(),
      devtools: { latchClosed: initialLatchClosed },
    })

    const updateNetworkStatus = (patch: { isConnected?: boolean; latchClosed?: boolean }) =>
      SubscriptionRef.update(networkStatusRef, (previous) => ({
        isConnected: patch.isConnected ?? previous.isConnected,
        timestampMs: Date.now(),
        devtools: {
          latchClosed: patch.latchClosed ?? previous.devtools.latchClosed,
        },
      }))

    if (syncBackend !== undefined) {
      yield* SubscriptionRef.changes(syncBackend.isConnected).pipe(
        Stream.tap((isConnected) => updateNetworkStatus({ isConnected })),
        Stream.runDrain,
        Effect.interruptible,
        Effect.tapCauseLogPretty,
        Effect.forkScoped,
      )
    }

    if (devtoolsContext.enabled === true) {
      yield* SubscriptionRef.changes(devtoolsContext.syncBackendLatchState).pipe(
        Stream.tap(({ latchClosed }) => updateNetworkStatus({ latchClosed })),
        Stream.runDrain,
        Effect.interruptible,
        Effect.tapCauseLogPretty,
        Effect.forkScoped,
      )
    }

    return Subscribable.fromSubscriptionRef(networkStatusRef)
  })
