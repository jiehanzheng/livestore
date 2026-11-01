import { Effect, KeyValueStore, Option } from '@livestore/utils/effect'

import type { SqliteDb } from '../adapter-types.ts'
import { backendIdKey } from '../sync/sync-backend-kv.ts'
import * as Eventlog from './eventlog.ts'

/** The backend identity has one durable SQL slot, not a general application key/value namespace. */
export const makeBackendIdKeyValueStore = (db: SqliteDb): KeyValueStore.KeyValueStore => {
  const operation = <A>(method: string, run: () => A, key?: string) =>
    Effect.try({
      try: run,
      catch: (cause) =>
        new KeyValueStore.KeyValueStoreError({
          method,
          ...(key === undefined ? {} : { key }),
          message: `Failed to ${method} backend identity`,
          cause,
        }),
    })
  const keys = operation('keys', () => (Option.isSome(Eventlog.getBackendIdFromDb(db)) === true ? [backendIdKey] : []))
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
      operation(
        'get',
        () => (key === backendIdKey ? Option.getOrUndefined(Eventlog.getBackendIdFromDb(db)) : undefined),
        key,
      ),
    set: (key, value) =>
      key === backendIdKey
        ? operation(
            'set',
            () => {
              const current = Eventlog.getBackendIdFromDb(db)
              if (Option.isSome(current) === true) {
                if (current.value !== value)
                  throw new Error(
                    'Persisted backend identity cannot be rebound without the explicit source-reset protocol',
                  )
                return
              }
              Eventlog.updateBackendId(db, value)
            },
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
