import { Cause, Effect, Exit } from 'effect'

import { SourceDbError } from '@livestore/common/source-db'

/** This lease belongs to the physical SOURCE owner, never to a document session. */
export interface SourceAuthority {
  readonly storageName: string
  isHeld(): boolean
  release(): Promise<void>
}

export const startSourceAuthority = (
  locks: LockManager,
  storageName: string,
): {
  acquired: Promise<SourceAuthority>
  cancelAndJoin: () => Promise<void>
} => {
  if (storageName === '') throw new Error('SOURCE storage name is required')
  let held = false
  const ready = Promise.withResolvers<SourceAuthority>()
  const release = Promise.withResolvers<void>()
  const controller = new AbortController()
  let closing: Promise<void> | undefined
  const finished = locks.request(
    `livestore-source-authority:${storageName}`,
    { mode: 'exclusive', signal: controller.signal },
    async () => {
      if (controller.signal.aborted === true) throw new DOMException('SOURCE acquisition cancelled', 'AbortError')
      held = true
      ready.resolve({
        storageName,
        isHeld: () => held,
        release: () =>
          (closing ??= (async () => {
            release.resolve()
            await finished
          })()),
      })
      try {
        await release.promise
      } finally {
        held = false
      }
    },
  )
  void finished.catch((error) => {
    held = false
    ready.reject(error)
  })
  return {
    acquired: ready.promise,
    cancelAndJoin: async () => {
      controller.abort()
      release.resolve()
      try {
        await finished
      } catch (error) {
        if (!(error instanceof DOMException) || error.name !== 'AbortError') throw error
      }
    },
  }
}

/** Join the native request, including abort completion. A blocked request is refused but remains owned until terminal. */
export const inspectSourceExistence = (
  factory: IDBFactory,
  authority: SourceAuthority,
  expected: 'absent' | 'retained',
): Promise<void> =>
  new Promise((resolve, reject) => {
    if (authority.isHeld() === false) {
      reject(new Error('SOURCE authority is not held'))
      return
    }
    const request = factory.open(authority.storageName)
    let absentUpgrade = false
    let abortReturned = false
    let refused: Error | undefined
    request.onblocked = () => {
      refused = new Error('SOURCE exact-name probe blocked; creation refused')
    }
    request.onupgradeneeded = (event) => {
      absentUpgrade = event.oldVersion === 0
      try {
        if (request.transaction === null) throw new Error('SOURCE upgrade transaction missing')
        request.transaction.abort()
        abortReturned = true
      } catch (error) {
        refused = error instanceof Error ? error : new Error('SOURCE native abort failed')
      }
    }
    request.onerror = () => {
      if (
        refused === undefined &&
        authority.isHeld() === true &&
        expected === 'absent' &&
        absentUpgrade === true &&
        abortReturned === true &&
        request.error?.name === 'AbortError'
      )
        resolve()
      else reject(refused ?? new Error('SOURCE existence/abort result is not the required owned boundary'))
    }
    request.onsuccess = () => {
      request.result.close()
      if (refused === undefined && authority.isHeld() === true && expected === 'retained') resolve()
      else reject(refused ?? new Error('Existing SOURCE storage cannot grant a fresh creation receipt'))
    }
  })

/** Call only inside masked resource acquisition, so the grant cannot escape before its cleanup is owned. */
export const acquireSourceAuthority = (locks: LockManager, storageName: string) =>
  Effect.gen(function* () {
    const error = (cause: unknown) => new SourceDbError({ operation: 'open', cause })
    const attempt = yield* Effect.try({ try: () => startSourceAuthority(locks, storageName), catch: error })
    // Only the contended wait is interruptible; native cancellation and the grant handoff remain joined.
    const outcome = yield* Effect.exit(
      Effect.interruptible(Effect.tryPromise({ try: () => attempt.acquired, catch: error })),
    )
    if (Exit.isFailure(outcome) === true) {
      const cleanup = yield* Effect.exit(Effect.tryPromise({ try: attempt.cancelAndJoin, catch: error }))
      return yield* Effect.failCause(
        Exit.isFailure(cleanup) === true ? Cause.combine(outcome.cause, cleanup.cause) : outcome.cause,
      )
    }
    return outcome.value
  })
