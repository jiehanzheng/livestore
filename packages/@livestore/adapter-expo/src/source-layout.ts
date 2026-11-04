import { Directory, File } from 'expo-file-system'
import { makeDirectoryAsync } from 'expo-file-system/legacy'

import { LegacyStorageFormatError, liveStoreStorageFormatVersion } from '@livestore/common'

import type { expoPersistencePaths } from './paths.ts'
import { allocateExpoSourceReceipt, expoSourceStorageName, type ExpoSourceAllocation } from './source-owner.ts'

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
  return inspectSourceDirectory(directory, paths, true)
}

export type ExpoSourceLayout =
  | { readonly kind: 'new'; readonly allocation: ExpoSourceAllocation }
  | { readonly kind: 'retained' }

/** Parent creation is advisory. Only the non-intermediate native mkdir of the exact final namespace grants creation. */
export const allocateExpoSource = async (paths: ReturnType<typeof expoPersistencePaths>): Promise<ExpoSourceLayout> => {
  let parent = new Directory(paths.baseDirectory)
  parent.create({ intermediates: true, idempotent: true })
  for (const name of paths.segments.slice(0, -1)) {
    const child = checkedChild(parent, name)
    if (child === undefined) {
      const created = new Directory(parent, name)
      created.create({ intermediates: true, idempotent: true })
      parent = created
    } else parent = child
  }
  const finalName = paths.segments.at(-1)
  if (finalName === undefined) throw new Error('Native SOURCE namespace is missing')
  const target = checkedChild(parent, finalName)
  if (target !== undefined) {
    inspectSourceDirectory(target, paths, false)
    return { kind: 'retained' }
  }
  const candidate = new Directory(parent, finalName)
  // A raced creator or any native uncertainty is a refusal; never turn mkdir failure into freshness.
  await makeDirectoryAsync(candidate.uri, { intermediates: false })
  return {
    kind: 'new',
    allocation: allocateExpoSourceReceipt(expoSourceStorageName(paths.directory, paths.eventlogDatabaseName)),
  }
}

const checkedChild = (parent: Directory, name: string): Directory | undefined => {
  const matching = parent.list().filter((entry) => entry.name === name)
  if (matching.length === 0) return undefined
  if (
    matching.length !== 1 ||
    !(matching[0] instanceof Directory) ||
    matching[0].uri !== new Directory(parent, name).uri
  ) {
    throw new LegacyStorageFormatError({
      expectedFormatVersion: liveStoreStorageFormatVersion,
      reason: 'Native source directory is not an unambiguous owned child.',
    })
  }
  return matching[0]
}

const inspectSourceDirectory = (
  directory: Directory,
  paths: ReturnType<typeof expoPersistencePaths>,
  allowEmpty: boolean,
): { sourceIsNew: boolean } => {
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
    if (allowEmpty === true) return { sourceIsNew: true }
    throw new LegacyStorageFormatError({
      expectedFormatVersion: liveStoreStorageFormatVersion,
      reason: 'Retained native namespace has no SOURCE identity candidate. Its files were preserved.',
    })
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
