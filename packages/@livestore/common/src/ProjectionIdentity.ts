import { Schema } from '@livestore/utils/effect'

import type { LiveStoreSchema } from './schema/schema.ts'

export const ProjectionIdentity = Schema.Struct({
  stateSchemaHash: Schema.String,
  projectionRevision: Schema.String,
})
export type ProjectionIdentity = typeof ProjectionIdentity.Type

export const getProjectionIdentity = (schema: LiveStoreSchema): ProjectionIdentity => ({
  stateSchemaHash: schema.state.sqlite.hash,
  projectionRevision: schema.projectionRevision,
})

export const isSameProjection = (left: ProjectionIdentity, right: ProjectionIdentity): boolean =>
  left.stateSchemaHash === right.stateSchemaHash && left.projectionRevision === right.projectionRevision
