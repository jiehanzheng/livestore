import { Directory, File } from 'expo-file-system'

import { LegacyStorageFormatError, liveStoreStorageFormatVersion } from '@livestore/common'

import type { expoPersistencePaths } from './paths.ts'

/** Establish only the declared base; inspect retained children before SQLite can
 * create a new-format file beside an older source. `exists` also means unreadable
 * in Expo, so only successful parent enumeration can establish absence. */
export const prepareExpoSourceLayout = function (paths: ReturnType<typeof expoPersistencePaths>): {
  sourceIsNew: boolean
} {
  let directory = new Directory(paths.baseDirectory)
  directory.create({ intermediates: true, idempotent: true })
  for (const name of paths.segments) {
    const entries = directory.list()
    const matching = entries.filter((entry) => entry.name === name)
    if (matching.length === 0) return { sourceIsNew: true }
    if (matching.length !== 1 || !(matching[0] instanceof Directory))
      throw new LegacyStorageFormatError({
        expectedFormatVersion: liveStoreStorageFormatVersion,
        reason: 'Native source directory is not an unambiguous directory.',
      })
    const child = matching[0]
    if (child.uri !== new Directory(directory, name).uri)
      throw new LegacyStorageFormatError({
        expectedFormatVersion: liveStoreStorageFormatVersion,
        reason: 'Native source directory escapes its declared parent.',
      })
    directory = child
  }
  const entries = directory.list()
  const source = entries.filter((entry) => entry.name === paths.eventlogDatabaseName)
  const currentFamily = new Set([
    paths.eventlogDatabaseName,
    ...['wal', 'shm', 'journal'].map((suffix) => `${paths.eventlogDatabaseName}-${suffix}`),
  ])
  const legacy = entries.some((entry) => entry.name.startsWith('livestore-eventlog@') && !currentFamily.has(entry.name))
  if (legacy === true)
    throw new LegacyStorageFormatError({
      expectedFormatVersion: liveStoreStorageFormatVersion,
      reason: 'Retained native source uses an unsupported storage format. Its files were preserved.',
    })
  if (source.length === 0) {
    if (entries.length > 0)
      throw new LegacyStorageFormatError({
        expectedFormatVersion: liveStoreStorageFormatVersion,
        reason: 'Retained native files have no current source. Its files were preserved.',
      })
    return { sourceIsNew: true }
  }
  if (
    source.length !== 1 ||
    !(source[0] instanceof File) ||
    source[0] instanceof Directory ||
    source[0].uri !== new File(directory, paths.eventlogDatabaseName).uri
  ) {
    throw new LegacyStorageFormatError({
      expectedFormatVersion: liveStoreStorageFormatVersion,
      reason: 'Retained native source is not an unambiguous file.',
    })
  }
  return { sourceIsNew: false }
}
