import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { expect } from 'vitest'

import { EventSequenceNumber, LiveStoreEvent } from '@livestore/common/schema'
import { fromSyncSource, initializeSource, SourceEvents } from '@livestore/common/source-db'
import {
  captureSource,
  SourceMaintenanceError,
  type ApplicationBinding,
  type CaptureArchive,
  type CaptureChunk,
  type DurableIntent,
  type SourceMaintenanceLocationOwner,
  type SourceMaintenanceContext,
  type TargetVerification,
} from '@livestore/common/source-maintenance'
import { loadSqlite3Wasm } from '@livestore/sqlite-wasm/load-wasm'
import {
  reserveNodeSource,
  sqliteDbFactory,
  type MakeNodeSqliteDb,
  type NodeDatabaseInput,
  type NodeDatabaseMetadata,
} from '@livestore/sqlite-wasm/node'
import { Effect, Option, Schema, Stream } from '@livestore/utils/effect'
import { PlatformNode } from '@livestore/utils/node'

import { makeNodeSourceMaintenanceOpener } from './source-maintenance.ts'

export const binding: ApplicationBinding = {
  operationId: 'actual-node-adoption',
  context: { installation: 'retained', revision: 1 },
}
export const payloadDigest = 'a'.repeat(64)
export const definitions = [
  { name: 'shared', schemaHash: 42, clientOnly: false },
  { name: 'local-only', schemaHash: 42, clientOnly: true },
]
export const sequence = (global: number, client = 0, generation = 0) =>
  EventSequenceNumber.Client.Composite.make({ global, client, rebaseGeneration: generation })
export const item = (global: number, client = 0, generation = 0, name = 'shared'): SourceEvents.StoredEvent => ({
  event: LiveStoreEvent.Client.Encoded.make({
    name,
    args: { actionId: `${name}-${global}`, value: 'original' },
    seqNum: sequence(global, client, generation),
    parentSeqNum: sequence(client === 0 ? global - 1 : global),
    clientId: 'original-client',
    sessionId: 'original-session',
  }),
  schemaHash: 42,
  syncMetadata: Option.some({ cursor: `old-physical-${global}` }),
})
export const withFixture = async <A>(
  use: (fixture: Awaited<ReturnType<typeof create>>) => Promise<A>,
  invalidClientShape = false,
) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'source-adoption-'))
  try {
    return await use(await create(directory, invalidClientShape))
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
}
const create = async (directory: string, invalidClientShape: boolean) => {
  const sqlite3 = await loadSqlite3Wasm()
  const make = await Effect.runPromise(
    sqliteDbFactory({ sqlite3 }).pipe(Effect.provide(PlatformNode.NodeFileSystem.layer)),
  )
  const raw = await Effect.runPromise(
    make({
      _tag: 'fs',
      directory,
      fileName: 'eventlog.db',
      sourceCreation: reserveNodeSource(path.join(directory, 'eventlog.db')),
    }),
  )
  const source = await Effect.runPromise(fromSyncSource(raw, raw.metadata.sourceCreation))
  const first = item(1),
    pending =
      invalidClientShape === true
        ? { ...item(1, 1, 3), event: { ...item(2).event, seqNum: sequence(1, 1, 3) } }
        : item(2, 0, 3)
  const localBase = item(2, 1, 3, 'local-only')
  const local = { ...localBase, event: { ...localBase.event, parentSeqNum: sequence(2, 0, 3) } }
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* initializeSource(source)
        yield* source.write((tx) =>
          Effect.gen(function* () {
            yield* SourceEvents.insert(tx, invalidClientShape === true ? [first, pending] : [first, pending, local])
            yield* SourceEvents.updateBackendHead(tx, sequence(1).global)
            yield* SourceEvents.updateBackendId(tx, 'old-backend')
          }),
        )
      }),
    )
  } finally {
    await Effect.runPromise(source.close)
  }
  let failClose = false,
    held = false,
    released = 0
  const locationOwner: SourceMaintenanceLocationOwner = {
    run: <A, E, R>(context: SourceMaintenanceContext, effect: Effect.Effect<A, E, R>) =>
      Effect.suspend((): Effect.Effect<A, E | SourceMaintenanceError, R> => {
        if (
          context.binding.operationId !== binding.operationId ||
          Schema.toEquivalence(Schema.Json)(context.binding.context, binding.context) === false
        )
          return Effect.fail(new SourceMaintenanceError('app-context', 'Changed application context'))
        if (
          context.purpose === 'adoption' &&
          (context.intent.payloadDigest !== payloadDigest ||
            Schema.toEquivalence(Schema.Json)(context.intent.receipt, { durable: true }) === false)
        )
          return Effect.fail(new SourceMaintenanceError('app-intent', 'Changed immutable durable payload receipt'))
        held = true
        return effect.pipe(
          Effect.onExit(() =>
            Effect.sync(() => {
              if (failClose === false) {
                held = false
                released++
              }
            }),
          ),
        )
      }),
  }
  const makeSqliteDb: MakeNodeSqliteDb = <
    TInput extends NodeDatabaseInput,
    TMetadata extends NodeDatabaseMetadata & { _tag: TInput['_tag'] } = NodeDatabaseMetadata & { _tag: TInput['_tag'] },
  >(
    input: TInput,
  ) =>
    make<TInput, TMetadata>(input).pipe(
      Effect.map((native) => ({
        ...native,
        close: () => {
          expect(held).toBe(true)
          native.close()
          if (failClose === true) throw new Error('joined close acknowledgement failed after physical close')
        },
      })),
    )
  const opener = makeNodeSourceMaintenanceOpener({
    binding,
    directory,
    fileName: 'eventlog.db',
    locationOwner,
    makeSqliteDb,
  })
  const capture = async (): Promise<CaptureArchive> => {
    const chunks: CaptureChunk[] = []
    const receipt = await Effect.runPromise(
      captureSource({
        opener,
        binding,
        limits: { maxRows: 100, maxBytes: 100_000, maxRowBytes: 10_000, pageSize: 1 },
        provenance: { producer: 'actual-node-test' },
        sink: {
          begin: () => Effect.void,
          chunk: (chunk) =>
            Effect.try({
              try: () => {
                chunks.push(structuredClone(chunk))
              },
              catch: (cause) => new SourceMaintenanceError('fixture-chunk', cause),
            }),
          seal: () => Effect.void,
        },
      }),
    )
    return { receipt, chunks: Stream.fromIterable(chunks) }
  }
  const target = (intentPayloadDigest: string | null = null): TargetVerification => ({
    binding,
    backendId: 'new-backend',
    logicalHead: 2,
    prefix: Stream.fromIterable([first, item(2)].map(({ event }) => LiveStoreEvent.Client.toGlobal(event))),
    witness: { reviewed: true },
    intentPayloadDigest,
  })
  const intent = (planDigest: string): DurableIntent => ({
    binding,
    receipt: { durable: true },
    payloadDigest,
    planDigest,
  })
  return {
    directory,
    makeSqliteDb,
    locationOwner,
    opener,
    capture,
    target,
    intent,
    first,
    pending,
    local,
    failClose: () => {
      failClose = true
    },
    held: () => held,
    released: () => released,
  }
}
