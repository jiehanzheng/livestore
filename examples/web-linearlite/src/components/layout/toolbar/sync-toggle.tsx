import React from 'react'
import { Switch } from 'react-aria-components'

import { StoreInternalsSymbol } from '@livestore/livestore'
import { Effect, Stream } from '@livestore/utils/effect'

import { useAppStore } from '../../../livestore/store.ts'

export const SyncToggle = ({ className }: { className?: string }) => {
  // TODO hook up actual sync/network state
  const [sync, setSync] = React.useState(false)
  const hasPendingSyncEvents = usePendingSyncEvents()
  const statusText = hasPendingSyncEvents === true ? 'Pending sync events' : 'No pending sync events'

  return (
    <div className={`flex items-center gap-2 ${className}`}>
      <span
        role="application"
        aria-live="polite"
        aria-label={statusText}
        title={statusText}
        className="flex size-6 items-center justify-center"
      >
        <span
          aria-hidden="true"
          className={`size-3 rounded-full border-2 ${
            hasPendingSyncEvents === true
              ? 'animate-spin border-orange-500 border-t-transparent'
              : 'border-transparent opacity-0'
          }`}
        />
        <span className="sr-only">{statusText}</span>
      </span>
      {/* TODO add disabled tooltip for now */}
      <Switch
        aria-label="Toggle sync/network"
        isSelected={sync}
        onChange={setSync}
        isDisabled={true} // TODO enable when sync is implemented
        className="group flex h-6 items-center gap-2 bg-neutral-800 hover:bg-neutral-700 rounded pl-1 pr-1.5 focus:outline-none focus:bg-neutral-700 cursor-pointer"
      >
        <div className="h-4 p-px w-6 bg-neutral-600 rounded-full group-data-[selected]:bg-orange-500 transition-colors">
          <span className="block size-3.5 bg-white rounded-full group-data-[selected]:translate-x-2 transition-transform" />
        </div>
        <span>
          Sync<span className="hidden xl:inline">/Network</span>
        </span>
      </Switch>
    </div>
  )
}

const subscribeToPendingSyncEvents = (
  store: ReturnType<typeof useAppStore>,
  setHasPendingEvents: React.Dispatch<React.SetStateAction<boolean>>,
) => {
  const syncProcessor = store[StoreInternalsSymbol].syncProcessor
  const leaderSyncState = store[StoreInternalsSymbol].clientSession.leaderThread.syncState
  let sessionPending = false
  let leaderPending = false
  const applyState = () => {
    const next = sessionPending || leaderPending
    setHasPendingEvents((previous) => (previous === next ? previous : next))
  }
  const setSessionPending = (pending: boolean) => {
    sessionPending = pending
    applyState()
  }
  const setLeaderPending = (pending: boolean) => {
    leaderPending = pending
    applyState()
  }

  // Both streams belong to this subscription; cancellation closes their shared scope.
  return Effect.gen(function* () {
    applyState()
    const sessionState = yield* syncProcessor.syncState
    const leaderState = yield* leaderSyncState
    setSessionPending(sessionState.pending.length > 0)
    setLeaderPending(leaderState.pending.filter((event) => event.seqNum.client === 0).length > 0)
    yield* syncProcessor.syncState.changes.pipe(
      Stream.tap((state) => Effect.sync(() => setSessionPending(state.pending.length > 0))),
      Stream.runDrain,
      Effect.interruptible,
      Effect.tapCauseLogPretty,
      Effect.forkScoped,
    )
    yield* leaderSyncState.changes.pipe(
      Stream.tap((state) =>
        Effect.sync(() => setLeaderPending(state.pending.filter((event) => event.seqNum.client === 0).length > 0)),
      ),
      Stream.runDrain,
      Effect.interruptible,
      Effect.tapCauseLogPretty,
      Effect.forkScoped,
    )
    return yield* Effect.never
  }).pipe(Effect.scoped, Effect.tapCauseLogPretty, Effect.runCallback)
}

const usePendingSyncEvents = () => {
  const store = useAppStore()
  const [hasPendingEvents, setHasPendingEvents] = React.useState(false)
  React.useEffect(() => subscribeToPendingSyncEvents(store, setHasPendingEvents), [store])
  return hasPendingEvents
}
