import { nanoid } from '@livestore/utils/nanoid'

import { LegacyStorageFormatError } from './errors.ts'
import { eventlogSystemTables, SOURCE_IDENTITY_TABLE } from './schema/state/sqlite/system-tables/eventlog-tables.ts'
import { getInitializedSourceBinding, type InitializedSource } from './source-initialization-context.ts'
import type { SqliteDb } from './sqlite-types.ts'
import { prepareBindValues } from './util.ts'
import { liveStoreStorageFormatVersion } from './version.ts'
export type { InitializedSource } from './source-initialization-context.ts'

export interface SourceIdentity {
  readonly formatVersion: number
  readonly incarnation: string
}

const refuse = (reason: string, actualFormatVersion?: number): never => {
  throw new LegacyStorageFormatError({
    expectedFormatVersion: liveStoreStorageFormatVersion,
    ...(actualFormatVersion === undefined ? {} : { actualFormatVersion }),
    reason,
  })
}

export const listSourceTables = (db: SqliteDb): ReadonlySet<string> =>
  new Set(db.select<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'").map((row) => row.name))

/** Read-only validation. Missing proof never grants permission to initialize retained bytes. */
export const read = (db: SqliteDb): SourceIdentity => {
  const tables = listSourceTables(db)
  if (eventlogSystemTables.every((table) => tables.has(table.sqliteDef.name)) === false) {
    return refuse('Existing source lacks a complete current-format schema and identity proof')
  }
  const rows = db.select<Record<string, unknown>>(`SELECT * FROM ${SOURCE_IDENTITY_TABLE}`)
  const row = rows[0]
  if (
    rows.length !== 1 ||
    row?.id !== 1 ||
    row.formatVersion !== liveStoreStorageFormatVersion ||
    typeof row.incarnation !== 'string' ||
    row.incarnation.trim().length === 0
  ) {
    return refuse(
      'Existing source has an invalid or incompatible identity proof',
      typeof row?.formatVersion === 'number' ? row.formatVersion : undefined,
    )
  }
  return { formatVersion: row.formatVersion, incarnation: row.incarnation }
}

/** The physical owner captures sourceIsNew before either database factory runs. */
export const assertFresh = (db: SqliteDb, sourceIsNew: boolean): void => {
  const tables = listSourceTables(db)
  const hasRetainedSource =
    db.transactionHost?.sourceNamespace === 'durable-object'
      ? [...tables].some((name) => name === 'eventlog' || name.startsWith('__livestore_') || name === 'vfs_pages')
      : tables.size !== 0
  if (sourceIsNew !== true || hasRetainedSource === true) {
    refuse('Only a newly discovered empty source may receive a new format identity')
  }
}

/** Internal: called only inside the same SQL transaction that creates every source table. */
export const initializeWithinTransaction = (db: SqliteDb): SourceIdentity => {
  const identity = { formatVersion: liveStoreStorageFormatVersion, incarnation: nanoid() }
  db.execute(
    `INSERT INTO ${SOURCE_IDENTITY_TABLE} (id, formatVersion, incarnation) VALUES (1, ?, ?)`,
    prepareBindValues([identity.formatVersion, identity.incarnation], ''),
  )
  return identity
}

/** Internal: destructive source reset must rotate identity in its source transaction. */
export const rotateWithinTransaction = (db: SqliteDb): SourceIdentity => {
  read(db)
  const incarnation = nanoid()
  db.execute(`UPDATE ${SOURCE_IDENTITY_TABLE} SET incarnation = ? WHERE id = 1`, prepareBindValues([incarnation], ''))
  return { formatVersion: liveStoreStorageFormatVersion, incarnation }
}

/** Revalidation is read only and cannot authorize a different source handle or a copied/forged context. */
export const assertInitialized = (db: SqliteDb, context: InitializedSource): SourceIdentity => {
  const binding = getInitializedSourceBinding(context)
  if (binding === undefined || binding.db !== db)
    return refuse('Source initialization context is missing or belongs to another database')
  const current = read(db)
  if (
    current.formatVersion !== binding.identity.formatVersion ||
    current.incarnation !== binding.identity.incarnation
  ) {
    return refuse('Source changed after initialization; reopen under its physical owner')
  }
  return current
}
