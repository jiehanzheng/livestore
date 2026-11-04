import { expect, test } from 'vitest'

import {
  inspectSourceCapture,
  prepareSourceAdoption,
  SourceMaintenanceError,
  type SourceCaptureInput,
} from '@livestore/common/source-maintenance'
import { Effect, Result, Schema, Stream } from '@livestore/utils/effect'

import { definitions, withFixture } from './source-maintenance-adoption-fixture.ts'

const json = (value: unknown): unknown => {
  const parsed: unknown = JSON.parse(JSON.stringify(value))
  return Schema.decodeUnknownSync(Schema.Json)(parsed)
}
const collect = <A, E>(stream: Stream.Stream<A, E>) => Effect.runPromise(Stream.runCollect(stream))
const refuse = async (input: SourceCaptureInput) => {
  // Defects escape runPromise; a malformed archive must produce a typed public failure instead.
  const result = await Effect.runPromise(Effect.result(inspectSourceCapture(input)))
  expect(Result.isFailure(result)).toBe(true)
  if (Result.isFailure(result) === true) expect(result.failure).toBeInstanceOf(SourceMaintenanceError)
}

test('persisted unknown receipt and chunks inspect and prepare without application SDK schema or casts', async () =>
  withFixture(async (fixture) => {
    const archive = await fixture.capture()
    const producerInput: SourceCaptureInput = archive
    const original = await Effect.runPromise(inspectSourceCapture(producerInput))
    const chunks = await collect(archive.chunks)
    const input: SourceCaptureInput = { receipt: json(archive.receipt), chunks: Stream.fromIterable(chunks.map(json)) }
    const restored = await Effect.runPromise(inspectSourceCapture(input))
    expect(restored.receipt).toEqual(original.receipt)
    expect(await collect(restored.rows)).toEqual(await collect(original.rows))
    const plan = await Effect.runPromise(
      prepareSourceAdoption({ capture: input, target: fixture.target(), eventDefinitions: definitions }),
    )
    expect(plan.expected).toEqual(archive.receipt.snapshot)
    expect(plan.captureDigest).toBe(archive.receipt.captureDigest)
  }))

test('null, missing and wrong-shaped receipts and chunks fail through the typed channel', async () =>
  withFixture(async (fixture) => {
    const archive = await fixture.capture()
    for (const receipt of [
      null,
      {},
      [],
      'receipt',
      { ...archive.receipt, header: null },
      { ...archive.receipt, snapshot: {} },
      { ...archive.receipt, coverage: { status: 'invented' } },
      { ...archive.receipt, chunks: '3' },
    ])
      await refuse({ receipt, chunks: archive.chunks })
    const [chunk] = await collect(archive.chunks)
    expect(chunk).toBeDefined()
    for (const invalid of [
      null,
      {},
      [],
      'chunk',
      { ...chunk, rows: null },
      { ...chunk, index: '0' },
      { ...chunk, rows: [null] },
      { ...chunk, rows: [{}] },
      { ...chunk, rows: [{ ...chunk!.rows[0], seqNumGlobal: '1' }] },
    ])
      await refuse({ receipt: json(archive.receipt), chunks: Stream.fromIterable([json(invalid)]) })
  }))

test('unknown archive input still enforces exact EOF, bounded pages and content commitments', async () =>
  withFixture(async (fixture) => {
    const archive = await fixture.capture()
    const chunks = await collect(archive.chunks)
    const variants: SourceCaptureInput[] = [
      { receipt: json(archive.receipt), chunks: Stream.empty },
      { receipt: json(archive.receipt), chunks: Stream.fromIterable(chunks.slice(0, -1).map(json)) },
      { receipt: json(archive.receipt), chunks: Stream.fromIterable([...chunks, chunks[0]!].map(json)) },
      { receipt: json(archive.receipt), chunks: Stream.fromIterable(chunks.toReversed().map(json)) },
      { receipt: json({ ...archive.receipt, captureDigest: '0'.repeat(64) }), chunks: archive.chunks },
      {
        receipt: json({
          ...archive.receipt,
          header: { ...archive.receipt.header, limits: { ...archive.receipt.header.limits, maxRows: 1 } },
        }),
        chunks: archive.chunks,
      },
      {
        receipt: json(archive.receipt),
        chunks: Stream.fromIterable(
          chunks.map((chunk, index) =>
            json(
              index === 0
                ? { ...chunk, rows: chunk.rows.map((row) => ({ ...row, argsJson: '{"tampered":true}' })) }
                : chunk,
            ),
          ),
        ),
      },
    ]
    for (const variant of variants) await refuse(variant)
  }))
