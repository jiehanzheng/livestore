import { Effect, Option, Schema } from '@livestore/utils/effect'

import * as EventSequenceNumber from '../schema/EventSequenceNumber/mod.ts'
import type * as LiveStoreEvent from '../schema/LiveStoreEvent/mod.ts'
import {
  EVENTLOG_META_TABLE,
  eventlogMetaTable,
  SYNC_STATUS_TABLE,
} from '../schema/state/sqlite/system-tables/eventlog-tables.ts'
import { insertRow, updateRows } from '../sql-queries/sql-queries.ts'
import { prepareBindValues } from '../util.ts'
import { fenceSource, SourceDbError, type SourceHandle, type SourceTransaction } from './role.ts'
import { selectStoredEvents, type StoredEvent } from './rows.ts'

export {
  decodeStoredEvents,
  selectStoredEvents,
  normalizeEvent,
  normalizeStoredEvent,
  type StoredEvent,
} from './rows.ts'
export {
  readAfterComposite,
  readGlobalWindowPage,
  getSyncBackendCursorInfo,
  type GlobalWindowOptions,
} from './cursors.ts'

export interface PageOptions {
  readonly since?: EventSequenceNumber.Client.Composite
  readonly until?: EventSequenceNumber.Client.Composite
  readonly limit?: number
  readonly names?: ReadonlyArray<string>
  readonly clientIds?: ReadonlyArray<string>
  readonly sessionIds?: ReadonlyArray<string>
  readonly includeClientOnly?: boolean
}

const error = (operation: string, cause: unknown) =>
  cause instanceof SourceDbError ? cause : new SourceDbError({ operation, cause })

/** Paging compares all three components so pending positions and rebase generations are not skipped. */
export const readPage = (source: SourceHandle, options: PageOptions = {}) =>
  Effect.gen(function* () {
    const limit = options.limit ?? 100
    if (Number.isSafeInteger(limit) === false || limit < 1) {
      return yield* Effect.fail(error('read-page', 'Page limit must be a positive safe integer'))
    }
    const since = options.since ?? EventSequenceNumber.Client.ROOT
    const where = ['(seqNumGlobal, seqNumClient, seqNumRebaseGeneration) > (?, ?, ?)']
    const values: Array<string | number> = [since.global, since.client, since.rebaseGeneration]
    if (options.until !== undefined) {
      where.push('(seqNumGlobal, seqNumClient, seqNumRebaseGeneration) <= (?, ?, ?)')
      values.push(options.until.global, options.until.client, options.until.rebaseGeneration)
    }
    if (options.includeClientOnly !== true) {
      where.push('seqNumClient <= ?')
      values.push(EventSequenceNumber.Client.DEFAULT)
    }
    for (const [column, filter] of [
      ['name', options.names],
      ['clientId', options.clientIds],
      ['sessionId', options.sessionIds],
    ] as const) {
      if (filter !== undefined && filter.length > 0) {
        where.push(`${column} IN (${filter.map(() => '?').join(', ')})`)
        values.push(...filter)
      }
    }
    values.push(limit)
    return yield* selectStoredEvents(
      source,
      `SELECT * FROM ${EVENTLOG_META_TABLE} WHERE ${where.join(' AND ')} ORDER BY seqNumGlobal, seqNumClient, seqNumRebaseGeneration LIMIT ?`,
      values,
    )
  })

export const readPending = (source: SourceHandle) =>
  selectStoredEvents(
    source,
    `SELECT * FROM ${EVENTLOG_META_TABLE} WHERE seqNumClient > ? ORDER BY seqNumGlobal, seqNumClient, seqNumRebaseGeneration`,
    [EventSequenceNumber.Client.DEFAULT],
  )

/** Rebase incarnations may coexist; the diagnostic validates the exact referenced parent, not its whole logical position. */
export const assertParentExists = (source: SourceHandle, parent: EventSequenceNumber.Client.Composite) =>
  Effect.gen(function* () {
    if (EventSequenceNumber.Client.isEqual(parent, EventSequenceNumber.Client.ROOT) === true) return
    const rows = yield* source.select<{ count: number }>(
      `SELECT COUNT(*) AS count FROM ${EVENTLOG_META_TABLE} WHERE seqNumGlobal = ? AND seqNumClient = ? AND seqNumRebaseGeneration = ?`,
      [parent.global, parent.client, parent.rebaseGeneration],
    )
    if (rows[0]?.count !== 1) {
      return yield* Effect.fail(
        fenceSource(
          source,
          'event-parent',
          `Parent event ${EventSequenceNumber.Client.toString(parent)} does not exist in eventlog`,
        ),
      )
    }
  })

export const readClientHead = (source: SourceHandle) =>
  source
    .select<{ seqNumGlobal: number; seqNumClient: number; seqNumRebaseGeneration: number }>(
      `SELECT seqNumGlobal, seqNumClient, seqNumRebaseGeneration FROM ${EVENTLOG_META_TABLE} ORDER BY seqNumGlobal DESC, seqNumClient DESC, seqNumRebaseGeneration DESC LIMIT 1`,
    )
    .pipe(
      Effect.flatMap((rows) =>
        rows.length === 0
          ? Effect.succeed(EventSequenceNumber.Client.ROOT)
          : Schema.decodeEffect(EventSequenceNumber.Client.Composite)({
              global: rows[0]!.seqNumGlobal,
              client: rows[0]!.seqNumClient,
              rebaseGeneration: rows[0]!.seqNumRebaseGeneration,
            }),
      ),
      Effect.mapError((cause) =>
        cause instanceof SourceDbError ? cause : fenceSource(source, 'read-client-head', cause),
      ),
    )

export const readBackendHead = (source: SourceHandle) =>
  source.select<{ head: number }>(`SELECT head FROM ${SYNC_STATUS_TABLE}`).pipe(
    Effect.flatMap((rows) =>
      Schema.decodeEffect(EventSequenceNumber.Global.Schema)(rows[0]?.head ?? EventSequenceNumber.Client.ROOT.global),
    ),
    Effect.mapError((cause) =>
      cause instanceof SourceDbError ? cause : fenceSource(source, 'read-backend-head', cause),
    ),
  )

export const readBackendId = (source: SourceHandle) =>
  source
    .select<{ backendId: string | null }>(`SELECT backendId FROM ${SYNC_STATUS_TABLE}`)
    .pipe(Effect.map((rows) => Option.fromNullishOr(rows[0]?.backendId)))

/** Writes require the caller's transaction so events, confirmations and cursor changes share one commit. */
export const insert = (transaction: SourceTransaction, items: ReadonlyArray<StoredEvent>) =>
  Effect.gen(function* () {
    for (const { event, schemaHash, syncMetadata } of items) {
      const [sql, values] = yield* Effect.try({
        try: () =>
          insertRow({
            tableName: EVENTLOG_META_TABLE,
            columns: eventlogMetaTable.sqliteDef.columns,
            values: {
              seqNumGlobal: event.seqNum.global,
              seqNumClient: event.seqNum.client,
              seqNumRebaseGeneration: event.seqNum.rebaseGeneration,
              parentSeqNumGlobal: event.parentSeqNum.global,
              parentSeqNumClient: event.parentSeqNum.client,
              parentSeqNumRebaseGeneration: event.parentSeqNum.rebaseGeneration,
              name: event.name,
              argsJson: event.args === undefined ? {} : event.args,
              clientId: event.clientId,
              sessionId: event.sessionId,
              schemaHash,
              syncMetadataJson: syncMetadata,
            },
          }),
        catch: (cause) => error('encode-eventlog', cause),
      })
      yield* transaction.execute(sql, prepareBindValues(values, sql))
    }
  })

export const updateSyncMetadata = (
  transaction: SourceTransaction,
  items: ReadonlyArray<{
    readonly event: LiveStoreEvent.Client.Encoded
    readonly syncMetadata: Option.Option<Schema.Json>
  }>,
) =>
  Effect.gen(function* () {
    for (const { event, syncMetadata } of items) {
      const [sql, values] = yield* Effect.try({
        try: () =>
          updateRows({
            tableName: EVENTLOG_META_TABLE,
            columns: eventlogMetaTable.sqliteDef.columns,
            where: { seqNumGlobal: event.seqNum.global, seqNumClient: event.seqNum.client },
            updateValues: { syncMetadataJson: syncMetadata },
          }),
        catch: (cause) => error('encode-sync-metadata', cause),
      })
      yield* transaction.execute(sql, prepareBindValues(values, sql))
    }
  })

/** A logical position includes every retained rebase-generation incarnation, matching existing eventlog deletion. */
export const deletePositions = (
  transaction: SourceTransaction,
  positions: ReadonlyArray<EventSequenceNumber.Client.Composite>,
) =>
  Effect.gen(function* () {
    for (let offset = 0; offset < positions.length; offset += 100) {
      const chunk = positions.slice(offset, offset + 100)
      yield* transaction.execute(
        `DELETE FROM ${EVENTLOG_META_TABLE} WHERE (seqNumGlobal, seqNumClient) IN (${chunk.map(() => '(?, ?)').join(', ')})`,
        chunk.flatMap((position) => [position.global, position.client]),
      )
    }
  })

export const updateBackendHead = (transaction: SourceTransaction, head: EventSequenceNumber.Global.Type) =>
  transaction.execute(`UPDATE ${SYNC_STATUS_TABLE} SET head = ?`, [head])

export const updateBackendId = (transaction: SourceTransaction, backendId: string) =>
  transaction.execute(`UPDATE ${SYNC_STATUS_TABLE} SET backendId = ?`, [backendId])
