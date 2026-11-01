import { defaultDatabaseDirectory } from 'expo-sqlite'

import { liveStoreStorageFormatVersion } from '@livestore/common'
import { getStateDbBaseName, type LiveStoreSchema } from '@livestore/common/schema'

export type ExpoStorage = { directory?: string; subDirectory?: string }

const segment = function (value: string) {
  if (value.length === 0 || value === '.' || value === '..' || /[/\\\0?#]/.test(value) === true) {
    throw new Error('Native storage requires a plain path segment.')
  }
  return value
}

export const expoPersistencePaths = function (storeId: string, schema: LiveStoreSchema, storage?: ExpoStorage) {
  const base: string = storage?.directory ?? defaultDatabaseDirectory
  if (
    (base.startsWith('/') === false && base.startsWith('file:///') === false) ||
    /[\\\0?#]/.test(base) === true ||
    base.split('/').some((part) => part === '.' || part === '..') === true
  ) {
    throw new Error('Native storage requires an absolute directory.')
  }
  const subDirectory = storage?.subDirectory?.replace(/\/+$/, '')
  const parts = subDirectory === undefined ? [] : subDirectory.split('/').map(segment)
  // Join only the suffix: collapsing all slashes would corrupt file:// URIs.
  const prefix = base === 'file:///' ? base : `${base.replace(/\/+$/, '')}/`
  const directory = `${prefix}${[...parts, segment(storeId)].join('/')}`
  return {
    baseDirectory: base,
    segments: [...parts, segment(storeId)],
    directory,
    stateDatabaseName: `${getStateDbBaseName(schema)}@${liveStoreStorageFormatVersion}.db`,
    eventlogDatabaseName: `livestore-eventlog@${liveStoreStorageFormatVersion}.db`,
  }
}
