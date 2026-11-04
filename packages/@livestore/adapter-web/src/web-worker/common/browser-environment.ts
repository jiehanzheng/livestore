import type { BootWarningReason } from '@livestore/common'
import { UnknownError } from '@livestore/common'
import { shouldNeverHappen } from '@livestore/utils'
import { Effect, Schema } from '@livestore/utils/effect'
import { Opfs, WebError } from '@livestore/utils/effect/browser'
import { nanoid } from '@livestore/utils/nanoid'

export const getPersistedId = (key: string, storageType: 'session' | 'local') => {
  const makeId = () => nanoid(5)

  const storage =
    typeof window === 'undefined'
      ? undefined
      : storageType === 'session'
        ? sessionStorage
        : storageType === 'local'
          ? localStorage
          : shouldNeverHappen(`[@livestore/adapter-web] Invalid storage type: ${String(storageType)}`)

  // in case of a worker, we need the id of the parent window, to keep the id consistent
  // we also need to handle the case where there are multiple workers being spawned by the same window
  if (storage === undefined) {
    return makeId()
  }

  const fullKey = `livestore:${key}`
  const storedKey = storage.getItem(fullKey)

  if (storedKey !== null) return storedKey

  const newKey = makeId()
  storage.setItem(fullKey, newKey)

  return newKey
}

export const ensureBrowserRequirements = Effect.gen(function* () {
  const validate = (condition: boolean, label: string) =>
    Effect.gen(function* () {
      if (condition === true) {
        return yield* UnknownError.make({
          cause: `[@livestore/adapter-web] Browser not supported. The LiveStore web adapter needs '${label}' to work properly`,
        })
      }
    })

  yield* Effect.all([
    validate(typeof navigator === 'undefined', 'navigator'),
    validate(navigator.locks === undefined, 'navigator.locks'),
    validate(navigator.storage === undefined, 'navigator.storage'),
    validate(crypto.randomUUID === undefined, 'crypto.randomUUID'),
    validate(typeof window === 'undefined', 'window'),
    validate(typeof sessionStorage === 'undefined', 'sessionStorage'),
  ])
})

/**
 * Attempts to access OPFS and returns a warning if unavailable.
 *
 * Common failure scenarios:
 * - Safari/Firefox private browsing: SecurityError or NotAllowedError
 * - Permission denied: NotAllowedError
 * - Quota exceeded: QuotaExceededError
 */
export const checkOpfsAvailability = Effect.gen(function* () {
  const opfs = yield* Opfs.Opfs
  return yield* opfs.getRootDirectoryHandle.pipe(
    Effect.as(undefined),
    Effect.catch((error) => {
      const reason: BootWarningReason =
        Schema.is(WebError.SecurityError)(error) === true || Schema.is(WebError.NotAllowedError)(error) === true
          ? 'private-browsing'
          : 'storage-unavailable'
      const message =
        reason === 'private-browsing'
          ? 'Storage unavailable in private browsing mode. LiveStore will continue without persistence.'
          : 'Storage access denied. LiveStore will continue without persistence.'
      return Effect.succeed({ reason, message } as const)
    }),
  )
})
