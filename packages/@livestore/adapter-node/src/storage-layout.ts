import fs from 'node:fs/promises'
import path from 'node:path'

import { LegacyStorageFormatError, liveStoreStorageFormatVersion } from '@livestore/common'

/** A changed format-derived filename must never turn retained work into a fresh
 * source. This inspects placement only; common owns source-row admission. */
export const inspectNodeStorage = async function (
  baseDirectory: string,
  storeId: string,
): Promise<{ sourceIsNew: boolean }> {
  const base = path.resolve(baseDirectory),
    directory = path.resolve(base, storeId)
  if (storeId.length === 0 || path.dirname(directory) !== base)
    throw new LegacyStorageFormatError({
      expectedFormatVersion: liveStoreStorageFormatVersion,
      reason: 'Node replica must be a direct child of its declared base.',
    })
  let directoryStat
  try {
    directoryStat = await fs.lstat(directory)
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return { sourceIsNew: true }
    throw cause
  }
  if (directoryStat.isDirectory() === false || directoryStat.isSymbolicLink() === true)
    throw new LegacyStorageFormatError({
      expectedFormatVersion: liveStoreStorageFormatVersion,
      reason: 'Node replica path is not an ordinary directory.',
    })
  // Only directory absence above is fresh. Failure to enumerate or inspect a
  // discovered entry is uncertainty, including ENOENT from a concurrent change.
  const entries = await fs.readdir(directory)
  const source = `eventlog@${liveStoreStorageFormatVersion}.db`
  const legacy = entries.find(
    (name) =>
      name.startsWith('eventlog@') &&
      name !== source &&
      ![`${source}-wal`, `${source}-shm`, `${source}-journal`].includes(name),
  )
  if (legacy !== undefined)
    throw new LegacyStorageFormatError({
      expectedFormatVersion: liveStoreStorageFormatVersion,
      reason: `Retained Node source uses another storage format: ${legacy}`,
    })
  if (entries.includes(source) === false) {
    if (entries.length > 0)
      throw new LegacyStorageFormatError({
        expectedFormatVersion: liveStoreStorageFormatVersion,
        reason: 'Node source is missing but retained replica entries remain.',
      })
    return { sourceIsNew: true }
  }
  const stat = await fs.lstat(path.join(directory, source))
  if (stat.isFile() === false || stat.isSymbolicLink() === true)
    throw new LegacyStorageFormatError({
      expectedFormatVersion: liveStoreStorageFormatVersion,
      reason: 'Node source must be an ordinary file.',
    })
  return { sourceIsNew: false }
}
