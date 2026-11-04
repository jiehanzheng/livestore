import { Effect } from '@livestore/utils/effect'

import { encodedSyncMetadataNone } from '../schema/state/sqlite/system-tables/eventlog-tables.ts'
import * as Identity from '../source-db/identity.ts'
import type { SourceTransaction } from '../source-db/role.ts'
import { decodeStoredEvents } from '../source-db/rows.ts'
import { digest, encode } from './codec.ts'
import { logicalPrefixProjection, makeCoverage } from './coverage.ts'
import { SourceMaintenanceError, type CaptureLimits, type SourceRecoveryRow, type SourceSnapshot } from './types.ts'

export { logicalPrefixProjection }
const columns = [
  'seqNumGlobal',
  'seqNumClient',
  'seqNumRebaseGeneration',
  'parentSeqNumGlobal',
  'parentSeqNumClient',
  'parentSeqNumRebaseGeneration',
  'name',
  'argsJson',
  'clientId',
  'sessionId',
  'schemaHash',
  'syncMetadataJson',
] as const
const textColumns = ['name', 'argsJson', 'clientId', 'sessionId', 'syncMetadataJson'] as const
const order = 'seqNumGlobal, seqNumClient, seqNumRebaseGeneration'
const fail = (code: string, cause: unknown) => new SourceMaintenanceError(code, cause)
const utf8 = new TextEncoder()
export const rowTuple = (row: SourceRecoveryRow) => columns.map((column) => row[column])
export const rawEventTuple = (row: SourceRecoveryRow) =>
  columns.filter((column) => column !== 'syncMetadataJson').map((column) => row[column])
const position = (row: SourceRecoveryRow) => [row.seqNumGlobal, row.seqNumClient, row.seqNumRebaseGeneration]
export const validateRow = (input: unknown): input is SourceRecoveryRow => {
  if (input === null || typeof input !== 'object' || Array.isArray(input) === true) return false
  const row = input as Record<string, unknown>
  return (
    Object.keys(row).length === columns.length &&
    columns.every((column) => Object.hasOwn(row, column)) &&
    columns
      .filter((column) => !textColumns.includes(column as (typeof textColumns)[number]))
      .every((column) => Number.isSafeInteger(row[column])) &&
    textColumns.every((column) => typeof row[column] === 'string') &&
    columns.slice(0, 6).every((column) => (row[column] as number) >= 0) &&
    (row.seqNumGlobal !== 0 || row.seqNumClient !== 0)
  )
}

export const readSourceMetadata = (tx: SourceTransaction) =>
  Effect.gen(function* () {
    const sourceIdentity = yield* Identity.read(tx)
    const status = yield* tx.select<{ head: unknown; backendId: unknown }>(
      'SELECT head, backendId FROM __livestore_sync_status',
    )
    const row = status[0]
    if (
      status.length !== 1 ||
      row === undefined ||
      Number.isSafeInteger(row.head) === false ||
      (row.head as number) < 0 ||
      (row.backendId === null || (typeof row.backendId === 'string' && row.backendId.trim().length > 0)) === false
    ) {
      return yield* Effect.fail(
        fail('sync-status', 'Expected one safe acknowledged head and null/nonempty backend identity'),
      )
    }
    const schema = yield* tx.select<{ type: string; name: string; tbl_name: string; sql: string | null }>(
      `SELECT type, name, tbl_name, sql FROM sqlite_master WHERE tbl_name IN ('eventlog','__livestore_sync_status','__livestore_source_identity') AND type IN ('table','index') ORDER BY type, name`,
    )
    const schemaDigest = yield* digest([
      'source-recovery-schema',
      1,
      schema.map((entry) => [entry.type, entry.name, entry.tbl_name, entry.sql]),
    ])
    return {
      sourceIdentity,
      acknowledgedHead: row.head as number,
      backendId: row.backendId as string | null,
      schemaDigest,
    }
  })

type PageCallback = (
  index: number,
  rows: readonly SourceRecoveryRow[],
  encodedBytes: number,
  chunkDigest: string,
) => Effect.Effect<void, SourceMaintenanceError>

/** The caller owns one outer maintenance transaction; stage callbacks cannot publish a sealed capture. */
export const scanSource = (tx: SourceTransaction, limits: CaptureLimits, onPage?: PageCallback) =>
  Effect.gen(function* () {
    if (
      [limits.maxRows, limits.maxBytes, limits.maxRowBytes, limits.pageSize].every(
        (value) => Number.isSafeInteger(value) && value > 0,
      ) === false
    ) {
      return yield* Effect.fail(fail('limits', 'All capture limits must be positive safe integers'))
    }
    const metadata = yield* readSourceMetadata(tx)
    const counts = yield* tx.select<{ count: number }>('SELECT COUNT(*) AS count FROM eventlog')
    const count = counts[0]?.count
    if (counts.length !== 1 || Number.isSafeInteger(count) === false || count! < 0 || count! > limits.maxRows) {
      return yield* Effect.fail(fail('row-limit', 'Invalid or oversized SOURCE row count'))
    }
    const coverage = yield* makeCoverage(metadata.acknowledgedHead)
    let rowDigest = yield* digest(['source-recovery-row', 1])
    let eventDigest = yield* digest(['source-recovery-event', 1])
    let clearedMetadataRowDigest = rowDigest
    let rows = 0,
      bytes = 0,
      chunks = 0
    let after: SourceRecoveryRow | undefined
    const none = encodedSyncMetadataNone()
    while (true) {
      const where = after === undefined ? '' : 'WHERE (seqNumGlobal, seqNumClient, seqNumRebaseGeneration) > (?, ?, ?)'
      const bindings = [...(after === undefined ? [] : position(after)), limits.pageSize]
      // Fetch lengths before cell bodies: an oversized retained JSON value must not be materialized just to reject it.
      const preflight = yield* tx.select<{ cellBytes: number }>(
        `SELECT ${textColumns.map((column) => `length(CAST(${column} AS BLOB))`).join(' + ')} AS cellBytes FROM eventlog ${where} ORDER BY ${order} LIMIT ?`,
        bindings,
      )
      if (
        preflight.some(
          (entry) =>
            Number.isSafeInteger(entry.cellBytes) === false ||
            entry.cellBytes < 0 ||
            entry.cellBytes > limits.maxRowBytes ||
            entry.cellBytes > limits.maxBytes - bytes,
        ) === true
      ) {
        return yield* Effect.fail(fail('row-bytes', 'SOURCE text cells exceed the remaining capture budget'))
      }
      const rawTextBytes = preflight.reduce((total, entry) => total + entry.cellBytes, 0)
      if (Number.isSafeInteger(rawTextBytes) === false || rawTextBytes > limits.maxBytes - bytes)
        return yield* Effect.fail(fail('capture-bytes', 'SOURCE page text exceeds the remaining capture budget'))
      const page = yield* tx.select<SourceRecoveryRow>(
        `SELECT ${columns.join(', ')} FROM eventlog ${where} ORDER BY ${order} LIMIT ?`,
        bindings,
      )
      if (page.length !== preflight.length)
        return yield* Effect.fail(fail('snapshot-changed', 'Preflight and row page disagree'))
      if (page.length === 0) break
      if (rows + page.length > limits.maxRows) return yield* Effect.fail(fail('row-limit', 'SOURCE row limit exceeded'))
      for (const row of page) {
        if (validateRow(row) === false) return yield* Effect.fail(fail('invalid-row', 'Invalid raw format-7 row'))
        if (after !== undefined) {
          const a = position(after),
            b = position(row)
          const comparison = b[0]! - a[0]! || b[1]! - a[1]! || b[2]! - a[2]!
          if (comparison <= 0) return yield* Effect.fail(fail('row-order', 'Non-increasing SOURCE position'))
        }
        if (utf8.encode(encode(row)).length > limits.maxRowBytes)
          return yield* Effect.fail(fail('row-bytes', 'Encoded SOURCE row exceeds budget'))
        after = row
      }
      const encodedBytes = utf8.encode(encode(page)).length
      if (encodedBytes > limits.maxBytes - bytes)
        return yield* Effect.fail(fail('capture-bytes', 'Encoded SOURCE capture exceeds budget'))
      const decoded = yield* decodeStoredEvents(tx, page)
      yield* coverage.add(decoded)
      for (const row of page) {
        rowDigest = yield* digest(['source-recovery-row', 1, rows, rowDigest, rowTuple(row)])
        eventDigest = yield* digest(['source-recovery-event', 1, rows, eventDigest, rawEventTuple(row)])
        clearedMetadataRowDigest = yield* digest([
          'source-recovery-row',
          1,
          rows,
          clearedMetadataRowDigest,
          rowTuple({ ...row, syncMetadataJson: none }),
        ])
        rows++
      }
      const chunkDigest = yield* digest(['source-recovery-chunk', 1, chunks, page.map(rowTuple)])
      if (onPage !== undefined) yield* onPage(chunks, page, encodedBytes, chunkDigest)
      chunks++
      bytes += encodedBytes
    }
    if (rows !== count)
      return yield* Effect.fail(fail('snapshot-changed', 'Exact EOF row count differs from initial count'))
    return {
      snapshot: { ...metadata, rows, rowDigest, eventDigest, clearedMetadataRowDigest } satisfies SourceSnapshot,
      coverage: yield* coverage.finish(),
      bytes,
      chunks,
    }
  })
