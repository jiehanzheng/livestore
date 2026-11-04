import { Effect, KeyValueStore, Option } from '@livestore/utils/effect'

import * as SourceEvents from '../source-db/events.ts'
import type { SourceOwner } from '../source-db/owner.ts'
import { SourceDbError } from '../source-db/role.ts'
import { backendIdKey } from '../sync/sync-backend-kv.ts'

/** The backend identity has one durable SOURCE slot, not a general application key/value namespace. */
export const makeBackendIdKeyValueStore = (owner: SourceOwner): KeyValueStore.KeyValueStore => {
  const operation = <A, E>(method: string, action: Effect.Effect<A, E>, key?: string) =>
    action.pipe(
      Effect.mapError(
        (cause) =>
          new KeyValueStore.KeyValueStoreError({
            method,
            ...(key === undefined ? {} : { key }),
            message: `Failed to ${method} backend identity`,
            cause,
          }),
      ),
    )
  const keys = operation(
    'keys',
    SourceEvents.readBackendId(owner.handle).pipe(
      Effect.map((value) => (Option.isSome(value) === true ? [backendIdKey] : [])),
    ),
  )
  // A backend binding is source authority. Generic KV reset must never make it rebindable.
  const unsupportedReset = (method: string, key?: string) =>
    Effect.fail(
      new KeyValueStore.KeyValueStoreError({
        method,
        ...(key === undefined ? {} : { key }),
        message: 'Backend identity reset requires the explicit source-reset protocol',
      }),
    )
  return KeyValueStore.makeStringOnly({
    get: (key) =>
      key === backendIdKey
        ? operation('get', SourceEvents.readBackendId(owner.handle).pipe(Effect.map(Option.getOrUndefined)), key)
        : Effect.undefined,
    set: (key, value) =>
      key === backendIdKey
        ? operation(
            'set',
            owner.write((transaction) =>
              Effect.gen(function* () {
                // Read and conditional bind share one physical transaction, including concurrent first setters.
                const current = yield* SourceEvents.readBackendId(transaction)
                if (Option.isSome(current) === true) {
                  if (current.value !== value)
                    return yield* Effect.fail(
                      new SourceDbError({
                        operation: 'bind-backend',
                        cause:
                          'Persisted backend identity cannot be rebound without the explicit source-reset protocol',
                      }),
                    )
                  return
                }
                yield* SourceEvents.updateBackendId(transaction, value)
              }),
            ),
            key,
          )
        : Effect.fail(
            new KeyValueStore.KeyValueStoreError({
              method: 'set',
              key,
              message: `Unsupported backend identity key: ${key}`,
            }),
          ),
    remove: (key) => unsupportedReset('remove', key),
    clear: unsupportedReset('clear'),
    keys,
    size: keys.pipe(Effect.map((storedKeys) => storedKeys.length)),
  })
}
