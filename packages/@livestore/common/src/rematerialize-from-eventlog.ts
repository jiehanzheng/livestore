import { memoizeByRef } from '@livestore/utils'
import { Effect, Option, Schema, Stream } from '@livestore/utils/effect'

import { type SqliteDb, UnknownError } from './adapter-types.ts'
import * as EventlogSqliteDb from './EventlogSqliteDb.ts'
import type { MaterializeEvent } from './leader-thread/mod.ts'
import { STATE_REBUILD_BATCH_SIZE_DEFAULT, StateRebuildBatchSizeSchema } from './leader-thread/types.ts'
import type { EventDef, LiveStoreSchema } from './schema/mod.ts'
import { EventSequenceNumber, SystemTables } from './schema/mod.ts'
import { readPage } from './source-db/events.ts'
import type { StoredEvent } from './source-db/rows.ts'
import { withSavepoint } from './sqlite-db-helper.ts'

export const rematerializeFromEventlog = Effect.fn('@livestore/common:rematerializeFromEventlog')(function* ({
  // TODO re-use this db when bringing back the boot in-memory db implementation
  dbState,
  schema,
  onProgress,
  materializeEvent,
  batchSize = STATE_REBUILD_BATCH_SIZE_DEFAULT,
}: {
  dbState: SqliteDb
  schema: LiveStoreSchema
  onProgress: (_: { done: number; total: number }) => Effect.Effect<void>
  materializeEvent: MaterializeEvent
  batchSize?: number
}) {
  if (Schema.is(StateRebuildBatchSizeSchema)(batchSize) === false) {
    return yield* UnknownError.make({
      cause: `Invalid stateRebuildBatchSize: ${String(batchSize)}. Expected a positive integer.`,
      payload: { batchSize },
    })
  }

  const dbEventlog = yield* EventlogSqliteDb.EventlogSqliteDb
  const eventsCount = (yield* dbEventlog.handle.select<{ count: number }>(
    `SELECT COUNT(*) AS count FROM ${SystemTables.EVENTLOG_META_TABLE}`,
  ))[0]!.count

  const hashEventDef = memoizeByRef((event: EventDef.AnyWithoutFn) => Schema.hash(event.schema))

  const processEvent = Effect.fn(`@livestore/common:rematerializeFromEventlog:processEvent`)(function* (
    row: StoredEvent,
  ) {
    const eventEncoded = row.event
    const args = eventEncoded.args
    const eventDef = schema.eventsDefsMap.get(eventEncoded.name)
    const materializer = schema.state.materializers.get(eventEncoded.name)

    if (eventDef === undefined || materializer === undefined) {
      // Route unknown events through the normal materialization boundary so
      // they advance the state snapshot head as no-ops.
      yield* materializeEvent(eventEncoded, { skipEventlog: true })
      return
    }

    if (hashEventDef(eventDef) !== row.schemaHash) {
      yield* Effect.logWarning(
        `Schema hash mismatch for event definition ${eventEncoded.name}. Trying to materialize event anyway.`,
      )
    }

    // Checking whether the schema has changed in an incompatible way
    yield* Schema.decodeUnknownEffect(eventDef.schema)(args).pipe(
      Effect.mapError((cause) =>
        UnknownError.make({
          cause,
          note: `\
There was an error during rematerializing from the eventlog while decoding
the persisted event args for event definition "${eventEncoded.name}".
This likely means the schema has changed in an incompatible way.
`,
        }),
      ),
    )

    yield* materializeEvent(eventEncoded, { skipEventlog: true })
  })

  let processedEvents = 0
  yield* Stream.paginate(EventSequenceNumber.Client.ROOT, (lastId) =>
    readPage(dbEventlog.handle, { since: lastId, limit: batchSize, includeClientOnly: true }).pipe(
      Effect.map((rows) => {
        const last = rows.at(-1)
        return [rows, last === undefined ? Option.none() : Option.some(last.event.seqNum)] as const
      }),
    ),
  ).pipe(
    Stream.bufferArray({ capacity: 2 }),
    Stream.runForEachArray((rows) =>
      Effect.forEach(
        rows,
        (row) =>
          Effect.gen(function* () {
            yield* processEvent(row)

            processedEvents++
            yield* onProgress({ done: processedEvents, total: eventsCount })
          }),
        { discard: true },
      ).pipe(withSavepoint(dbState)),
    ),
  )
}, Effect.withPerformanceMeasure('@livestore/common:rematerializeFromEventlog'))
