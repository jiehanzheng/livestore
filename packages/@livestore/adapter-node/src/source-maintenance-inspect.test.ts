import fs from 'node:fs/promises'
import path from 'node:path'

import { expect, test } from 'vitest'

import { Events, makeSchema, State } from '@livestore/common/schema'
import {
  deriveSourceEventDefinitions,
  inspectSourceCapture,
  type CaptureArchive,
  type CaptureChunk,
} from '@livestore/common/source-maintenance'
import { withRetainedSource } from '@livestore/common/source-maintenance/internal'
import { Effect, Schema, Stream } from '@livestore/utils/effect'

import { binding, definitions, withFixture } from './source-maintenance-adoption-fixture.ts'

const collect = <A, E>(stream: Stream.Stream<A, E>) => Effect.runPromise(Stream.runCollect(stream))
const clone = <A>(value: A): A => JSON.parse(JSON.stringify(value)) as A
const editSource = (
  fixture: Parameters<Parameters<typeof withFixture>[0]>[0],
  sql: string,
  values?: readonly (string | number)[],
) =>
  Effect.runPromise(
    withRetainedSource(fixture.opener, binding, (source) => source.write((tx) => tx.execute(sql, values))),
  )

test('closed capture inspection remains available without SOURCE and preserves unknown/residual raw evidence', async () =>
  withFixture(async (fixture) => {
    await editSource(
      fixture,
      "UPDATE eventlog SET name='future.Unknown', argsJson=' { \"unrecognized\" : null } ' WHERE seqNumGlobal=2 AND seqNumClient=0",
    )
    const capture = await fixture.capture()
    await fs.rename(path.join(fixture.directory, 'eventlog.db'), path.join(fixture.directory, 'unavailable-source.db'))
    const inspected = await Effect.runPromise(inspectSourceCapture(capture))
    const rows = await collect(inspected.rows)
    expect(rows).toHaveLength(3)
    expect(rows.find((row) => row.name === 'future.Unknown')!.argsJson).toBe(' { "unrecognized" : null } ')
    expect(rows.find((row) => row.name === 'local-only')!.seqNumClient).toBe(1)
    const prefix = await Effect.runPromise(inspected.readCanonicalPrefix(definitions))
    expect(prefix).toMatchObject({ through: 1, coverage: { status: 'complete' } })
    expect((await Effect.runPromiseExit(inspected.readCanonicalPrefix(definitions, { through: 2 })))._tag).toBe(
      'Failure',
    )
    expect((await collect(prefix.events)).map((event) => event.seqNum)).toEqual([1])
    expect(await fs.readdir(fixture.directory)).toEqual(['unavailable-source.db'])
  }))

test('incomplete acknowledged coverage yields only the measured contiguous prefix', async () =>
  withFixture(async (fixture) => {
    await editSource(fixture, 'UPDATE __livestore_sync_status SET head=3')
    const inspected = await Effect.runPromise(inspectSourceCapture(await fixture.capture()))
    const prefix = await Effect.runPromise(inspected.readCanonicalPrefix(definitions))
    expect(prefix).toMatchObject({
      through: 2,
      coverage: { acknowledgedHead: 3, provenThrough: 2, status: 'incomplete' },
    })
    expect((await collect(prefix.events)).map((event) => event.seqNum)).toEqual([1, 2])
    const shorter = await Effect.runPromise(inspected.readCanonicalPrefix(definitions, { through: 1 }))
    expect(shorter.coverage).toEqual(prefix.coverage)
    expect((await collect(shorter.events)).map((event) => event.seqNum)).toEqual([1])
    await editSource(fixture, 'UPDATE __livestore_sync_status SET head=1')
    const complete = await Effect.runPromise(inspectSourceCapture(await fixture.capture()))
    expect(shorter.prefixDigest).toBe((await Effect.runPromise(complete.readCanonicalPrefix(definitions))).prefixDigest)
    for (const through of [3, -1, 1.5])
      expect((await Effect.runPromiseExit(inspected.readCanonicalPrefix(definitions, { through })))._tag).toBe(
        'Failure',
      )
    expect(
      await collect((await Effect.runPromise(inspected.readCanonicalPrefix(definitions, { through: 0 }))).events),
    ).toEqual([])
  }))

test('corrupted, reordered, truncated chunks and changed receipt refuse inspection', async () =>
  withFixture(async (fixture) => {
    const capture = await fixture.capture(),
      chunks = await collect(capture.chunks)
    const corrupted = chunks.map((chunk, index) =>
      index === 0
        ? { ...chunk, rows: chunk.rows.map((row) => ({ ...row, argsJson: '{"tampered":true}' })) }
        : clone(chunk),
    )
    const variants: CaptureArchive[] = [
      { ...capture, chunks: Stream.fromIterable(corrupted) },
      { ...capture, chunks: Stream.fromIterable(chunks.toReversed()) },
      { ...capture, chunks: Stream.fromIterable(chunks.slice(0, -1)) },
      { ...capture, receipt: { ...capture.receipt, snapshot: { ...capture.receipt.snapshot, rows: 99 } } },
    ]
    for (const archive of variants)
      expect((await Effect.runPromiseExit(inspectSourceCapture(archive)))._tag).toBe('Failure')
  }))

test('unknown prefix definitions refuse a canonical view but never hide raw capture rows', async () =>
  withFixture(async (fixture) => {
    const inspected = await Effect.runPromise(inspectSourceCapture(await fixture.capture()))
    expect((await Effect.runPromiseExit(inspected.readCanonicalPrefix([])))._tag).toBe('Failure')
    expect(await collect(inspected.rows)).toHaveLength(3)
  }))

test('re-reading streams and mutating returned values cannot mutate verified internal evidence', async () =>
  withFixture(async (fixture) => {
    const inspected = await Effect.runPromise(inspectSourceCapture(await fixture.capture()))
    const first = await collect(inspected.rows),
      original = clone(first)
    expect(() => Object.assign(first[0]!, { argsJson: 'null', name: 'mutated-consumer-copy' })).toThrow(TypeError)
    expect(await collect(inspected.rows)).toEqual(original)
    expect(() => Object.assign(inspected.receipt.coverage, { provenThrough: 0 })).toThrow(TypeError)
    const prefix = await Effect.runPromise(inspected.readCanonicalPrefix(definitions))
    const events = await collect(prefix.events),
      originalEvents = clone(events)
    expect(() => Object.assign(events[0]!, { args: null, name: 'mutated-consumer-copy' })).toThrow(TypeError)
    expect(await collect(prefix.events)).toEqual(originalEvents)
    expect(await collect((await Effect.runPromise(inspected.readCanonicalPrefix(definitions))).events)).toEqual(
      originalEvents,
    )
  }))

test('compiled producer definitions use per-event materializer hash and do not approve an older unknown hash', async () =>
  withFixture(async (fixture) => {
    const events = {
      shared: Events.synced({
        name: 'shared',
        schema: Schema.Struct({ actionId: Schema.String, value: Schema.String }),
      }),
      local: Events.clientOnly({
        name: 'local-only',
        schema: Schema.Struct({ actionId: Schema.String, value: Schema.String }),
      }),
    }
    const schema = makeSchema({
      projectionRevision: 'inspector-test',
      events,
      state: State.SQLite.makeState({ tables: {}, materializers: {} }),
    })
    const actual = await Effect.runPromise(deriveSourceEventDefinitions(schema))
    expect(actual).toEqual(
      [...schema.eventsDefsMap.values()]
        .map((definition) => ({
          name: definition.name,
          schemaHash: Schema.hash(definition.schema),
          clientOnly: definition.options.clientOnly,
        }))
        .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0)),
    )
    const olderCapture = await Effect.runPromise(inspectSourceCapture(await fixture.capture()))
    expect((await Effect.runPromiseExit(olderCapture.readCanonicalPrefix(actual)))._tag).toBe('Failure')
    for (const definition of actual)
      await editSource(fixture, 'UPDATE eventlog SET schemaHash=? WHERE name=?', [
        definition.schemaHash,
        definition.name,
      ])
    const currentCapture = await Effect.runPromise(inspectSourceCapture(await fixture.capture()))
    expect((await Effect.runPromise(currentCapture.readCanonicalPrefix(actual))).through).toBe(1)
  }))
