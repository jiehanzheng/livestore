import { type Subscribable, Effect, Option, Queue, Stream } from '@livestore/utils/effect'

import { EventSequenceNumber, type LiveStoreEvent } from '../schema/mod.ts'
import { readGlobalWindowPage } from '../source-db/cursors.ts'
import type { SourceOwner } from '../source-db/owner.ts'
import type { SourceDbError } from '../source-db/role.ts'
import type * as SyncState from '../sync/syncstate.ts'
import type { StreamEventsOptions } from './types.ts'

type Position = EventSequenceNumber.Client.Composite
type Window = { since: Position; target: Position; head: Position; after: Position | undefined }

/** A global window is exhausted by composite position before its global cursor advances. */
export const streamEventsWithSyncState = ({
  dbEventlog,
  syncState,
  options,
}: {
  dbEventlog: SourceOwner
  syncState: Subscribable.Subscribable<SyncState.SyncState>
  options: StreamEventsOptions
}): Stream.Stream<LiveStoreEvent.Client.Encoded, SourceDbError> => {
  const initial = options.since ?? EventSequenceNumber.Client.ROOT
  const limit = options.batchSize ?? 100
  return Stream.unwrap(
    Effect.gen(function* () {
      const heads = yield* Queue.sliding<Position>(1)
      let previous = -1
      yield* syncState.changes.pipe(
        Stream.map((state) => state.upstreamHead),
        Stream.filter((head) => {
          if (head.global <= previous) return false
          previous = head.global
          return true
        }),
        Stream.runForEach((head) => Queue.offer(heads, head)),
        Effect.forkScoped,
      )
      const start: Window = { since: initial, target: initial, head: initial, after: undefined }
      return Stream.paginate(start, (window) =>
        Effect.gen(function* () {
          let { since, target, head, after } = window
          if (after === undefined) {
            if (options.until !== undefined && since.global >= options.until.global) {
              return [[], Option.none<Window>()] as const
            }
            const next =
              since.global >= head.global ? yield* Queue.take(heads).pipe(Effect.asSome) : yield* Queue.poll(heads)
            head = Option.getOrElse(next, () => head)
            target = EventSequenceNumber.Client.Composite.make({
              global: Math.min(options.until?.global ?? Infinity, since.global + limit, head.global),
              client: EventSequenceNumber.Client.DEFAULT,
            })
          }
          const rows = yield* readGlobalWindowPage(dbEventlog.handle, {
            ...options,
            ...(options.filter === undefined ? {} : { names: options.filter }),
            since: since.global,
            until: target.global,
            limit,
            ...(after === undefined ? {} : { after }),
          })
          const events = rows.map((row) => row.event)
          // A full page can end midway through one global position, including its rebase generations.
          const last = events.at(-1)
          if (events.length === limit && last !== undefined) {
            return [events, Option.some({ since, target, head, after: last.seqNum })] as const
          }
          const done = options.until !== undefined && target.global >= options.until.global
          return [
            events,
            done === true
              ? Option.none<Window>()
              : Option.some({
                  since: target,
                  target,
                  head,
                  after: undefined,
                }),
          ] as const
        }),
      )
    }),
  )
}
