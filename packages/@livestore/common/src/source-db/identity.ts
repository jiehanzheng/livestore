import { Effect } from '@livestore/utils/effect'
import { nanoid } from '@livestore/utils/nanoid'

import { LegacyStorageFormatError } from '../errors.ts'
import * as EventSequenceNumber from '../schema/EventSequenceNumber/mod.ts'
import {
  eventlogSystemTables,
  SOURCE_IDENTITY_TABLE,
  SYNC_STATUS_TABLE,
} from '../schema/state/sqlite/system-tables/eventlog-tables.ts'
import type { SourceIdentity } from '../SourceIdentity.ts'
import { liveStoreStorageFormatVersion } from '../version.ts'
import { consumeFreshSource, type FreshSource } from './freshness.ts'
import { sourceLifecycle, invalidateSourceLifecycle } from './lifecycle.ts'
import { hasRetainedSourceNamespace } from './namespace.ts'
import { fenceSource, SourceDbError, type SourceDb, type SourceHandle, type SourceTransaction } from './role.ts'
import { createSourceSchema, listSourceTables } from './schema.ts'

const refuse = (reason: string, actualFormatVersion?: number) =>
  new SourceDbError({
    operation: 'source-identity',
    cause: new LegacyStorageFormatError({
      expectedFormatVersion: liveStoreStorageFormatVersion,
      ...(actualFormatVersion === undefined ? {} : { actualFormatVersion }),
      reason,
    }),
  })

/** Read-only validation of the existing SOURCE format, with no retained-data initialization. */
export const read = (source: SourceHandle): Effect.Effect<SourceIdentity, SourceDbError> =>
  Effect.gen(function* () {
    const tables = yield* listSourceTables(source)
    if (eventlogSystemTables.every((table) => tables.has(table.sqliteDef.name)) === false) {
      return yield* Effect.fail(refuse('Existing source lacks a complete current-format schema and identity proof'))
    }
    const rows = yield* source.select<Record<string, unknown>>(`SELECT * FROM ${SOURCE_IDENTITY_TABLE}`)
    const row = rows[0]
    if (
      rows.length !== 1 ||
      row?.id !== 1 ||
      row.formatVersion !== liveStoreStorageFormatVersion ||
      typeof row.incarnation !== 'string' ||
      row.incarnation.trim().length === 0
    ) {
      return yield* Effect.fail(
        refuse(
          'Existing source has an invalid or incompatible identity proof',
          typeof row?.formatVersion === 'number' ? row.formatVersion : undefined,
        ),
      )
    }
    return { formatVersion: row.formatVersion, incarnation: row.incarnation }
  })

export const initialize = (source: SourceDb, fresh: FreshSource): Effect.Effect<SourceIdentity, SourceDbError> =>
  Effect.gen(function* () {
    const epoch = source[sourceLifecycle].epoch
    // A failed initialization consumes its physical freshness permit too; retained emptiness is not freshness.
    yield* consumeFreshSource(source, fresh)
    return yield* source.transaction((transaction) => initializeWithinTransaction(transaction, epoch))
  })

/** One initializer for standalone databases and the native host's reserved SDK namespace. */
export const initializeWithinTransaction = (
  transaction: SourceTransaction,
  epoch: number,
): Effect.Effect<SourceIdentity, SourceDbError> =>
  Effect.gen(function* () {
    // Allocation authorization may precede admission to the physical transaction owner.
    if (transaction[sourceLifecycle].epoch !== epoch || transaction[sourceLifecycle].phase !== 'open') {
      return yield* Effect.fail(fenceSource(transaction, 'initialize', 'SOURCE changed after allocation authorization'))
    }
    const tables = yield* listSourceTables(transaction)
    const retained =
      transaction[sourceLifecycle].namespace === 'durable-object'
        ? hasRetainedSourceNamespace(tables)
        : tables.size !== 0
    if (retained === true)
      return yield* Effect.fail(refuse('Only a newly allocated empty SOURCE namespace may receive an identity'))
    yield* createSourceSchema(transaction)
    yield* transaction.execute(`INSERT INTO ${SYNC_STATUS_TABLE} (head) VALUES (?)`, [
      EventSequenceNumber.Client.ROOT.global,
    ])
    const identity = { formatVersion: liveStoreStorageFormatVersion, incarnation: nanoid() }
    yield* transaction.execute(
      `INSERT INTO ${SOURCE_IDENTITY_TABLE} (id, formatVersion, incarnation) VALUES (1, ?, ?)`,
      [identity.formatVersion, identity.incarnation],
    )
    return identity
  })

/** Rotate within the owning SOURCE transaction. A planned incarnation makes an immutable recovery intent resumable. */
export const rotate = (
  transaction: SourceTransaction,
  plannedIncarnation?: string,
): Effect.Effect<SourceIdentity, SourceDbError> =>
  Effect.gen(function* () {
    const previous = yield* read(transaction)
    const incarnation = plannedIncarnation ?? nanoid()
    if (incarnation.trim().length === 0 || incarnation === previous.incarnation)
      return yield* Effect.fail(
        fenceSource(transaction, 'rotate-identity', 'Successor SOURCE incarnation must be new and nonempty'),
      )
    invalidateSourceLifecycle(transaction[sourceLifecycle])
    yield* transaction.execute(`UPDATE ${SOURCE_IDENTITY_TABLE} SET incarnation = ? WHERE id = 1`, [incarnation])
    return { formatVersion: liveStoreStorageFormatVersion, incarnation }
  })
