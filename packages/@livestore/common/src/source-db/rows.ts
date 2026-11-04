import { Effect, Option, Schema } from '@livestore/utils/effect'

import * as LiveStoreEvent from '../schema/LiveStoreEvent/mod.ts'
import { eventlogMetaTable } from '../schema/state/sqlite/system-tables/eventlog-tables.ts'
import { fenceSource, type SourceBindings, type SourceHandle } from './role.ts'

export interface StoredEvent {
  readonly event: LiveStoreEvent.Client.Encoded
  readonly schemaHash: number
  readonly syncMetadata: Option.Option<Schema.Json>
}

/** The existing row codec is shared by replay, cursor reads and normal event reads. */
export const decodeStoredEventRows = (rows: unknown) =>
  Schema.decodeUnknownEffect(Schema.Array(eventlogMetaTable.rowSchema))(rows).pipe(
    Effect.map(
      (decoded): ReadonlyArray<StoredEvent> =>
        decoded.map((row) => ({
          event: LiveStoreEvent.Client.Encoded.make({
            name: row.name,
            args: row.argsJson,
            seqNum: {
              global: row.seqNumGlobal,
              client: row.seqNumClient,
              rebaseGeneration: row.seqNumRebaseGeneration,
            },
            parentSeqNum: {
              global: row.parentSeqNumGlobal,
              client: row.parentSeqNumClient,
              rebaseGeneration: row.parentSeqNumRebaseGeneration,
            },
            clientId: row.clientId,
            sessionId: row.sessionId,
          }),
          schemaHash: row.schemaHash,
          syncMetadata: row.syncMetadataJson,
        })),
    ),
  )

export const decodeStoredEvents = (source: SourceHandle, rows: unknown) =>
  decodeStoredEventRows(rows).pipe(Effect.mapError((cause) => fenceSource(source, 'decode-eventlog', cause)))

export const selectStoredEvents = (source: SourceHandle, sql: string, bindings?: SourceBindings) =>
  source.select<Record<string, unknown>>(sql, bindings).pipe(Effect.flatMap((rows) => decodeStoredEvents(source, rows)))

/** Session attribution is explicit; unknown event names and encoded arguments remain unchanged. */
export const normalizeEvent = (
  event: LiveStoreEvent.Client.Encoded,
  overrides: {
    readonly clientId?: string
    readonly sessionId?: string
  } = {},
): LiveStoreEvent.Client.Encoded =>
  LiveStoreEvent.Client.Encoded.make({
    ...event,
    clientId: overrides.clientId ?? event.clientId,
    sessionId: overrides.sessionId ?? event.sessionId,
  })

export const normalizeStoredEvent = (
  event: LiveStoreEvent.Client.Encoded,
  options: {
    readonly schemaHash: number
    readonly syncMetadata?: Option.Option<Schema.Json>
    readonly clientId?: string
    readonly sessionId?: string
  },
): StoredEvent => ({
  event: normalizeEvent(event, options),
  schemaHash: options.schemaHash,
  syncMetadata: options.syncMetadata ?? Option.none(),
})
