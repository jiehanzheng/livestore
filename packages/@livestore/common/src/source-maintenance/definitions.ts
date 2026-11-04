import { Effect, Schema } from '@livestore/utils/effect'

import type * as Global from '../schema/LiveStoreEvent/global.ts'
import { UNKNOWN_EVENT_SCHEMA_HASH, type LiveStoreSchema } from '../schema/mod.ts'
import type { StoredEvent } from '../source-db/rows.ts'
import { digest, encode } from './codec.ts'
import { SourceMaintenanceError, type SourceEventDefinitionWitness } from './types.ts'

/** Classification comes from the application's reviewed producer definitions, never inferred from an unknown name. */
export const verifyDefinitions = (
  definitions: readonly SourceEventDefinitionWitness[],
  rows: readonly StoredEvent[],
  target: readonly Global.Encoded[],
) =>
  Effect.gen(function* () {
    const byKey = new Map<string, SourceEventDefinitionWitness>()
    const byName = new Map<string, Set<boolean>>()
    for (const definition of definitions) {
      if (
        typeof definition.name !== 'string' ||
        definition.name.length === 0 ||
        Number.isSafeInteger(definition.schemaHash) === false ||
        definition.schemaHash === UNKNOWN_EVENT_SCHEMA_HASH ||
        typeof definition.clientOnly !== 'boolean'
      )
        return yield* Effect.fail(
          new SourceMaintenanceError('event-definition', 'Malformed producer definition witness'),
        )
      const key = encode([definition.name, definition.schemaHash])
      if (byKey.has(key) === true)
        return yield* Effect.fail(
          new SourceMaintenanceError('event-definition', 'Repeated producer definition witness'),
        )
      byKey.set(key, definition)
      const flags = byName.get(definition.name) ?? new Set<boolean>()
      flags.add(definition.clientOnly)
      byName.set(definition.name, flags)
    }
    for (const row of rows) {
      const definition = byKey.get(encode([row.event.name, row.schemaHash]))
      if (definition === undefined || definition.clientOnly !== row.event.seqNum.client > 0)
        return yield* Effect.fail(
          new SourceMaintenanceError(
            'unclassified-source-event',
            'Unknown producer classification or impossible shared/client-only position',
          ),
        )
    }
    for (const event of target) {
      const flags = byName.get(event.name)
      if (flags === undefined || flags.size !== 1 || flags.has(false) === false)
        return yield* Effect.fail(
          new SourceMaintenanceError(
            'unclassified-target-event',
            'Canonical server history must have reviewed shared event definitions',
          ),
        )
    }
    const sorted = [...byKey.entries()]
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([, value]) => value)
    return yield* digest(['source-recovery-event-definitions', 1, sorted])
  })

/** Uses the exact per-event argument-codec hash written by normal materialization, not a whole-store schema hash. */
export const deriveSourceEventDefinitions = (schema: Pick<LiveStoreSchema, 'eventsDefsMap'>) =>
  Effect.try({
    try: () =>
      [...schema.eventsDefsMap.values()]
        .map((definition) => ({
          name: definition.name,
          schemaHash: Schema.hash(definition.schema),
          clientOnly: definition.options.clientOnly,
        }))
        .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0)),
    catch: (cause) => new SourceMaintenanceError('producer-definitions', cause, 'not-started', 'joined'),
  })
