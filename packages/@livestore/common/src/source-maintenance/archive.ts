import { Effect, Schema, Stream } from '@livestore/utils/effect'

import { encodedSyncMetadataNone } from '../schema/state/sqlite/system-tables/eventlog-tables.ts'
import { decodeStoredEventRows, type StoredEvent } from '../source-db/rows.ts'
import { liveStoreStorageFormatVersion } from '../version.ts'
import { digest, encode, equal, ownJson, parseJson } from './codec.ts'
import { makeCoverage } from './coverage.ts'
import { captureChunkInputCodec, captureReceiptCodec } from './model-codecs.ts'
import { rawEventTuple, rowTuple, validateRow } from './scan.ts'
import { SourceMaintenanceError, type SourceCaptureInput, type SourceRecoveryRow } from './types.ts'
const fail = (code: string, cause: unknown) => new SourceMaintenanceError(code, cause)
const utf8 = new TextEncoder()

/** Revalidate untrusted archived chunks instead of treating a JSON receipt/hash as an authority proof. */
export const readCaptureArchive = (archive: SourceCaptureInput) =>
  Effect.gen(function* () {
    const rawReceipt = yield* Effect.try({
      try: () => ownJson(archive.receipt),
      catch: (cause) => fail('archive-json', cause),
    })
    const receipt = yield* Schema.decodeUnknownEffect(captureReceiptCodec)(rawReceipt).pipe(
      Effect.mapError((cause) => fail('archive-contract', cause)),
    )
    const limits = receipt.header.limits
    if (
      receipt.closure !== 'joined-maintenance-owner' ||
      receipt.header.contract !== 'livestore-source-recovery-v1' ||
      [limits.maxRows, limits.maxBytes, limits.maxRowBytes, limits.pageSize].every(
        (n) => Number.isSafeInteger(n) && n > 0,
      ) === false
    )
      return yield* Effect.fail(fail('archive-contract', 'Invalid capture contract or limits'))
    const snapshot = receipt.snapshot
    if (
      snapshot.sourceIdentity.formatVersion !== liveStoreStorageFormatVersion ||
      typeof snapshot.sourceIdentity.incarnation !== 'string' ||
      snapshot.sourceIdentity.incarnation.trim().length === 0 ||
      Number.isSafeInteger(snapshot.acknowledgedHead) === false ||
      snapshot.acknowledgedHead < 0 ||
      (snapshot.backendId !== null &&
        (typeof snapshot.backendId !== 'string' || snapshot.backendId.trim().length === 0)) ||
      [snapshot.rows, receipt.bytes, receipt.chunks, receipt.coverage.provenThrough].every(
        (n) => Number.isSafeInteger(n) && n >= 0,
      ) === false ||
      receipt.coverage.acknowledgedHead !== snapshot.acknowledgedHead ||
      receipt.coverage.provenThrough > snapshot.acknowledgedHead
    )
      return yield* Effect.fail(
        fail('archive-metadata', 'Invalid current-format SOURCE identity, sync status or coverage'),
      )
    let rowDigest = yield* digest(['source-recovery-row', 1])
    let clearedMetadataRowDigest = rowDigest
    let eventDigest = yield* digest(['source-recovery-event', 1])
    const coverage = yield* makeCoverage(receipt.snapshot.acknowledgedHead)
    const rows: SourceRecoveryRow[] = [],
      decoded: StoredEvent[] = []
    let chunks = 0,
      bytes = 0
    const none = encodedSyncMetadataNone()
    yield* Stream.runForEach(archive.chunks, (input) =>
      Effect.gen(function* () {
        const rawChunk = yield* Effect.try({
          try: () => ownJson(input),
          catch: (cause) => fail('archive-chunk-json', cause),
        })
        const chunk = yield* Schema.decodeUnknownEffect(captureChunkInputCodec)(rawChunk).pipe(
          Effect.mapError((cause) => fail('archive-chunk-shape', cause)),
        )
        if (
          chunk.index !== chunks ||
          chunk.rows.length === 0 ||
          chunk.rows.length > limits.pageSize ||
          rows.length + chunk.rows.length > limits.maxRows
        )
          return yield* Effect.fail(fail('archive-chunk-order', 'Invalid chunk index, length or row budget'))
        const rawRows = chunk.rows.filter(validateRow)
        if (rawRows.length !== chunk.rows.length) return yield* Effect.fail(fail('archive-row', 'Invalid raw row'))
        const encoded = encode(rawRows),
          chunkBytes = utf8.encode(encoded).length
        if (
          chunkBytes !== chunk.bytes ||
          chunkBytes > limits.maxBytes - bytes ||
          rawRows.some((row) => utf8.encode(encode(row)).length > limits.maxRowBytes) === true ||
          (yield* digest(['source-recovery-chunk', 1, chunks, rawRows.map(rowTuple)])) !== chunk.digest
        )
          return yield* Effect.fail(fail('archive-chunk-digest', 'Chunk bytes or commitment differ'))
        // Own the bounded page after verification so a reusable reader cannot mutate a prepared preimage.
        const page = yield* parseJson<SourceRecoveryRow[]>(encoded)
        for (const row of page) {
          const prior = rows.at(-1)
          if (
            prior !== undefined &&
            (row.seqNumGlobal - prior.seqNumGlobal ||
              row.seqNumClient - prior.seqNumClient ||
              row.seqNumRebaseGeneration - prior.seqNumRebaseGeneration) <= 0
          )
            return yield* Effect.fail(fail('archive-row-order', 'Non-increasing physical row position'))
          const index = rows.length
          rowDigest = yield* digest(['source-recovery-row', 1, index, rowDigest, rowTuple(row)])
          eventDigest = yield* digest(['source-recovery-event', 1, index, eventDigest, rawEventTuple(row)])
          clearedMetadataRowDigest = yield* digest([
            'source-recovery-row',
            1,
            index,
            clearedMetadataRowDigest,
            rowTuple({ ...row, syncMetadataJson: none }),
          ])
          rows.push(row)
        }
        const events = yield* decodeStoredEventRows(page).pipe(Effect.mapError((cause) => fail('archive-codec', cause)))
        yield* coverage.add(events)
        decoded.push(...events)
        bytes += chunkBytes
        chunks++
      }),
    )
    const actual = { ...receipt.snapshot, rows: rows.length, rowDigest, eventDigest, clearedMetadataRowDigest }
    const prefix = yield* coverage.finish()
    const { sourceIdentity, backendId, acknowledgedHead, schemaDigest } = actual
    const metadata = { sourceIdentity, backendId, acknowledgedHead, schemaDigest }
    const headerMetadata = {
      sourceIdentity: receipt.header.sourceIdentity,
      backendId: receipt.header.backendId,
      acknowledgedHead: receipt.header.acknowledgedHead,
      schemaDigest: receipt.header.schemaDigest,
    }
    if (
      equal(actual, receipt.snapshot) === false ||
      equal(metadata, headerMetadata) === false ||
      equal(prefix, receipt.coverage) === false ||
      chunks !== receipt.chunks ||
      bytes !== receipt.bytes ||
      (yield* digest(['source-recovery-capture', 1, receipt.header, actual, prefix, chunks, bytes])) !==
        receipt.captureDigest
    )
      return yield* Effect.fail(fail('archive-receipt', 'Capture EOF commitment differs from actual chunks'))
    return { receipt, rows, decoded }
  })
