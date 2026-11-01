import { Schema } from '@livestore/utils/effect'

import type { SqliteDb } from './adapter-types.ts'
import type { PullItem } from './ClientSessionLeaderThreadProxy.ts'
import type { MigrationsReport } from './defs.ts'
import { ProjectionIdentity, isSameProjection } from './ProjectionIdentity.ts'
export { ProjectionIdentity, getProjectionIdentity, isSameProjection } from './ProjectionIdentity.ts'
import { SystemTables } from './schema/mod.ts'
import { prepareBindValues } from './util.ts'

/** Identifies one completed projection within one serving leader's lifetime. */
export const PROOF_VERSION = 1
export const Provenance = Schema.Struct({
  proofVersion: Schema.Literal(PROOF_VERSION),
  ownerId: Schema.String,
  transitionId: Schema.String,
  sourceIncarnation: Schema.String,
  projection: ProjectionIdentity,
})
export type Provenance = typeof Provenance.Type

export type AdmissionRequest = {
  readonly expectedProjection: ProjectionIdentity
  readonly candidate: Provenance | undefined
}

export type Admission =
  | { readonly _tag: 'Accepted'; readonly provenance: Provenance }
  | { readonly _tag: 'StaleSnapshot'; readonly provenance: Provenance; readonly snapshot: Uint8Array<ArrayBuffer> }

export type OpenSessionFrame =
  | (Admission & { readonly migrationsReport: MigrationsReport })
  | { readonly _tag: 'Pull'; readonly item: typeof PullItem.Type }

/** Call only after verifying the current completion table exists. Unowned boot/seed images require admission. */
export const readProvenance = (db: SqliteDb): Provenance | undefined => {
  const tables = db.select<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
  if (tables.some((row) => row.name === SystemTables.REBUILD_META_TABLE) === false) return undefined
  // Legacy derived metadata is stale, not source authority. Read existing columns without assuming the new shape.
  const row = db.select<Record<string, unknown>>(`SELECT * FROM ${SystemTables.REBUILD_META_TABLE} WHERE id = 1`)[0]
  if (
    row === undefined ||
    row.proofVersion !== PROOF_VERSION ||
    typeof row.ownerId !== 'string' ||
    typeof row.transitionId !== 'string' ||
    typeof row.sourceIncarnation !== 'string' ||
    typeof row.stateSchemaHash !== 'string' ||
    typeof row.projectionRevision !== 'string'
  )
    return undefined
  return {
    proofVersion: PROOF_VERSION,
    ownerId: row.ownerId,
    transitionId: row.transitionId,
    sourceIncarnation: row.sourceIncarnation,
    projection: { stateSchemaHash: row.stateSchemaHash, projectionRevision: row.projectionRevision },
  }
}

export const isEqual = (left: Provenance | undefined, right: Provenance): boolean =>
  left?.proofVersion === right.proofVersion &&
  left.ownerId === right.ownerId &&
  left.transitionId === right.transitionId &&
  left.sourceIncarnation === right.sourceIncarnation &&
  isSameProjection(left.projection, right.projection)

/** Only reconstruction and the serialized persistence owner may publish a completed image. */
export const writeProvenance = (db: SqliteDb, provenance: Provenance): void => {
  db.execute(
    `INSERT OR REPLACE INTO ${SystemTables.REBUILD_META_TABLE}
    (id, proofVersion, ownerId, transitionId, sourceIncarnation, stateSchemaHash, projectionRevision)
    VALUES (1, ?, ?, ?, ?, ?, ?)`,
    prepareBindValues(
      [
        provenance.proofVersion,
        provenance.ownerId,
        provenance.transitionId,
        provenance.sourceIncarnation,
        provenance.projection.stateSchemaHash,
        provenance.projection.projectionRevision,
      ],
      '',
    ),
  )
}
