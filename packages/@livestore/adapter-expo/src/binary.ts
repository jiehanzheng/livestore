import type { SQLiteBindParams, SQLiteBindValue } from 'expo-sqlite'

import type { PreparedBindValues } from '@livestore/common'

/** Native module boundaries must receive precisely the view, never adjacent bytes. */
export const ownedBytes = function (value: Uint8Array | ArrayBuffer): Uint8Array<ArrayBuffer> {
  return value instanceof Uint8Array ? new Uint8Array(value) : new Uint8Array(value.slice(0))
}

export const nativeBindings = function (values: PreparedBindValues | undefined): SQLiteBindParams {
  const nativeValue = (value: unknown): SQLiteBindValue =>
    value instanceof Uint8Array ? ownedBytes(value).buffer : (value as SQLiteBindValue)
  return Array.isArray(values) === true
    ? values.map(nativeValue)
    : Object.fromEntries(Object.entries(values ?? {}).map(([key, value]) => [key, nativeValue(value)]))
}

export const normalizedRows = function <T>(rows: Record<string, unknown>[]): ReadonlyArray<T> {
  return rows.map((row) =>
    Object.fromEntries(
      Object.entries(row).map(([key, value]) => [
        key,
        value instanceof ArrayBuffer || value instanceof Uint8Array ? ownedBytes(value) : value,
      ]),
    ),
  ) as T[]
}
