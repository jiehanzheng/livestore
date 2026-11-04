import { Effect, Option, Schema } from '@livestore/utils/effect'

import * as EventSequenceNumber from '../schema/EventSequenceNumber/mod.ts'
import { EVENTLOG_META_TABLE } from '../schema/state/sqlite/system-tables/eventlog-tables.ts'
import { fenceSource, SourceDbError, type SourceHandle } from './role.ts'
import { selectStoredEvents } from './rows.ts'

export interface GlobalWindowOptions {
  readonly since: EventSequenceNumber.Global.Type
  readonly until?: EventSequenceNumber.Global.Type
  readonly after?: EventSequenceNumber.Client.Composite
  readonly limit?: number
  readonly names?: ReadonlyArray<string>
  readonly clientIds?: ReadonlyArray<string>
  readonly sessionIds?: ReadonlyArray<string>
  readonly includeClientOnly?: boolean
}

/** A backend cursor is not the local tail: confirmed-client rows beyond it are retained work too. */
export const readAfterComposite = (source: SourceHandle, since: EventSequenceNumber.Client.Composite) =>
  selectStoredEvents(
    source,
    `SELECT * FROM ${EVENTLOG_META_TABLE} WHERE (seqNumGlobal, seqNumClient, seqNumRebaseGeneration) > (?, ?, ?) ORDER BY seqNumGlobal, seqNumClient, seqNumRebaseGeneration`,
    [since.global, since.client, since.rebaseGeneration],
  )

/** Global bounds remain fixed while the continuation drains every incarnation at their edges. */
export const readGlobalWindowPage = (source: SourceHandle, options: GlobalWindowOptions) =>
  Effect.gen(function* () {
    const limit = options.limit ?? 100
    if (Number.isSafeInteger(limit) === false || limit < 1) {
      return yield* Effect.fail(
        new SourceDbError({ operation: 'read-global-window', cause: 'Page limit must be a positive safe integer' }),
      )
    }
    const where = ['seqNumGlobal > ?'],
      values: Array<string | number> = [options.since]
    if (options.until !== undefined) {
      where.push('seqNumGlobal <= ?')
      values.push(options.until)
    }
    if (options.after !== undefined) {
      where.push('(seqNumGlobal, seqNumClient, seqNumRebaseGeneration) > (?, ?, ?)')
      values.push(options.after.global, options.after.client, options.after.rebaseGeneration)
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

const equivalentJson = Schema.toEquivalence(Schema.Json)
const sameMetadata = (left: Option.Option<Schema.Json>, right: Option.Option<Schema.Json>): boolean =>
  Option.isNone(left) === true
    ? Option.isNone(right)
    : Option.isSome(right) === true && equivalentJson(left.value, right.value)

export const getSyncBackendCursorInfo = (
  source: SourceHandle,
  { remoteHead }: { remoteHead: EventSequenceNumber.Global.Type },
) =>
  Effect.gen(function* () {
    if (remoteHead === EventSequenceNumber.Client.ROOT.global) return Option.none()
    const candidates = yield* selectStoredEvents(
      source,
      `SELECT * FROM ${EVENTLOG_META_TABLE} WHERE seqNumGlobal = ? AND seqNumClient = (SELECT MIN(seqNumClient) FROM ${EVENTLOG_META_TABLE} WHERE seqNumGlobal = ?) ORDER BY seqNumRebaseGeneration DESC`,
      [remoteHead, remoteHead],
    )
    const selected = candidates[0]
    if (
      selected !== undefined &&
      candidates.some((candidate) => sameMetadata(candidate.syncMetadata, selected.syncMetadata) === false) === true
    ) {
      // Confirmation updates all generations. None/Some disagreement is not permission to discard a cursor.
      return yield* Effect.fail(
        fenceSource(source, 'backend-cursor-metadata', 'Conflicting metadata at one logical backend position'),
      )
    }
    return Option.some({ eventSequenceNumber: remoteHead, metadata: selected?.syncMetadata ?? Option.none() })
  })
