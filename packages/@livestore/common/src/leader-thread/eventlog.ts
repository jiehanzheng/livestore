import { LS_DEV } from '@livestore/utils'
import { Effect, Option, type Schema } from '@livestore/utils/effect'

import * as EventSequenceNumber from '../schema/EventSequenceNumber/mod.ts'
import type * as LiveStoreEvent from '../schema/LiveStoreEvent/mod.ts'
import * as Admission from '../source-db/admission.ts'
import * as SourceEvents from '../source-db/events.ts'
import { SourceContext, type SourceOwner } from '../source-db/owner.ts'
import type { SourceHandle } from '../source-db/role.ts'
import type { StreamEventsOptions } from './types.ts'
import { STREAM_EVENTS_BATCH_SIZE_DEFAULT } from './types.ts'

/** Legacy entry-point name, with the same owner admission and no discovery-boolean authority. */
export const initEventlogDb = (owner: SourceOwner) =>
  Admission.initializeSource(owner).pipe(Effect.map((proof) => proof.identity))
export const initializeSource = Admission.initializeSource

export const getEventsSince = ({
  dbEventlog,
  since,
}: {
  dbEventlog: SourceHandle
  since: EventSequenceNumber.Client.Composite
}) => SourceEvents.readAfterComposite(dbEventlog, since).pipe(Effect.map((rows) => rows.map((row) => row.event)))

export const deleteEvents = (owner: SourceOwner, eventNums: ReadonlyArray<EventSequenceNumber.Client.Composite>) =>
  owner.write((transaction) => SourceEvents.deletePositions(transaction, eventNums))

/** Global bounds are fixed; continuation drains ties before the caller advances its global window. */
export const getEventsFromEventlog = ({
  dbEventlog,
  options,
  after,
}: {
  dbEventlog: SourceHandle
  options: StreamEventsOptions
  after?: EventSequenceNumber.Client.Composite
}) =>
  SourceEvents.readGlobalWindowPage(dbEventlog, {
    since: options.since?.global ?? EventSequenceNumber.Client.ROOT.global,
    limit: options.batchSize ?? STREAM_EVENTS_BATCH_SIZE_DEFAULT,
    includeClientOnly: options.includeClientOnly === true,
    ...(options.until === undefined ? {} : { until: options.until.global }),
    ...(options.filter === undefined ? {} : { names: options.filter }),
    ...(options.clientIds === undefined ? {} : { clientIds: options.clientIds }),
    ...(options.sessionIds === undefined ? {} : { sessionIds: options.sessionIds }),
    ...(after === undefined ? {} : { after }),
  }).pipe(Effect.map((rows) => rows.map((row) => row.event)))

export const getClientHeadFromDb = SourceEvents.readClientHead
export const getBackendHeadFromDb = SourceEvents.readBackendHead
export const getBackendIdFromDb = SourceEvents.readBackendId

export const updateBackendHead = (owner: SourceOwner, head: EventSequenceNumber.Client.Composite) =>
  owner.write((transaction) => SourceEvents.updateBackendHead(transaction, head.global))

export const updateBackendId = (owner: SourceOwner, backendId: string) =>
  owner.write((transaction) => SourceEvents.updateBackendId(transaction, backendId))

export const insertIntoEventlog = (
  eventEncoded: LiveStoreEvent.Client.Encoded,
  owner: SourceOwner,
  eventDefSchemaHash: number,
  clientId: string,
  sessionId: string,
  syncMetadata: Option.Option<Schema.Json> = Option.none(),
) =>
  owner
    .write((transaction) =>
      Effect.gen(function* () {
        if (LS_DEV === true) yield* SourceEvents.assertParentExists(transaction, eventEncoded.parentSeqNum)
        yield* SourceEvents.insert(transaction, [
          SourceEvents.normalizeStoredEvent(eventEncoded, {
            schemaHash: eventDefSchemaHash,
            clientId,
            sessionId,
            syncMetadata,
          }),
        ])
      }),
    )
    .pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          owner.debug.head = eventEncoded.seqNum
        }),
      ),
    )

export const updateSyncMetadata = (
  items: ReadonlyArray<{
    readonly event: LiveStoreEvent.Client.Encoded
    readonly syncMetadata: Option.Option<Schema.Json>
  }>,
) => SourceContext.pipe(Effect.flatMap((owner) => updateSyncMetadataForDb(owner, items)))

export const updateSyncMetadataForDb = (
  owner: SourceOwner,
  items: ReadonlyArray<{
    readonly event: LiveStoreEvent.Client.Encoded
    readonly syncMetadata: Option.Option<Schema.Json>
  }>,
) => owner.write((transaction) => SourceEvents.updateSyncMetadata(transaction, items))

export const getSyncBackendCursorInfo = (args: { remoteHead: EventSequenceNumber.Global.Type }) =>
  SourceContext.pipe(Effect.flatMap((owner) => getSyncBackendCursorInfoForDb(owner.handle, args)))

export const getSyncBackendCursorInfoForDb = SourceEvents.getSyncBackendCursorInfo
