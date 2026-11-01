import { Effect, KeyValueStore, Option } from '@livestore/utils/effect'

import { UnknownError } from '../errors.ts'

export const backendIdKey = 'backendId'

export const makeBackendIdHelper = Effect.gen(function* () {
  const kv = yield* KeyValueStore.KeyValueStore

  const backendIdRef = {
    current: Option.fromUndefinedOr(yield* kv.get(backendIdKey).pipe(UnknownError.mapToUnknownError)),
  }

  const setBackendId = (backendId: string) =>
    Effect.gen(function* () {
      if (Option.getOrUndefined(backendIdRef.current) !== backendId) {
        yield* kv.set(backendIdKey, backendId)
        backendIdRef.current = Option.some(backendId)
      }
    }).pipe(UnknownError.mapToUnknownError)

  return {
    lazySet: setBackendId,
    get: () => backendIdRef.current,
  }
})
