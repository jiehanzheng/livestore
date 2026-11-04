import { EventSequenceNumber, LiveStoreEvent } from '@livestore/common/schema'
import {
  makeSourceDb,
  sourceDriverFromSync,
  type SourceEvents as Events,
  type SourceDb,
  type AsyncSourceDriver,
} from '@livestore/common/source-db'
import { bindFreshSource, invalidateFreshSource } from '@livestore/common/source-db/internal'
import { loadSqlite3Wasm } from '@livestore/sqlite-wasm/load-wasm'
import { sqliteDbFactory } from '@livestore/sqlite-wasm/node'
import { Effect, Option, type Scope } from '@livestore/utils/effect'
import { PlatformNode } from '@livestore/utils/node'

export const run = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>) =>
  Effect.runPromise(Effect.scoped(effect).pipe(Effect.provide(PlatformNode.NodeFileSystem.layer)))

/** The permit comes from this actual new connection, never from discovering empty retained tables. */
export const makeMemorySource = (
  bytes?: Uint8Array,
  options?: { wrapDriver: (driver: AsyncSourceDriver) => AsyncSourceDriver },
) =>
  Effect.gen(function* () {
    const sqlite3 = yield* Effect.promise(() => loadSqlite3Wasm())
    const factory = yield* sqliteDbFactory({ sqlite3 })
    const raw = yield* factory({ _tag: 'in-memory' })
    if (bytes !== undefined) raw.import(new Uint8Array(bytes))
    const nativeDriver = sourceDriverFromSync(raw)
    const driver = options === undefined ? nativeDriver : options.wrapDriver(nativeDriver)
    const rolledBackImages: Uint8Array[] = []
    let held = true,
      source: SourceDb
    source = yield* makeSourceDb({
      ...driver,
      execute: async (sql, bindings) => {
        await driver.execute(sql, bindings)
        // Capture inside the joined driver rollback, before the poisoned owner is closed.
        if (sql === 'ROLLBACK') rolledBackImages.push(await driver.export())
      },
      import: async (image) => {
        invalidateFreshSource(source)
        await driver.import(image)
      },
      close: async () => {
        invalidateFreshSource(source)
        await driver.close()
        held = false
      },
    })
    yield* Effect.addFinalizer(() => source.close.pipe(Effect.orDie))
    const storageName = `memory-source-${crypto.randomUUID()}`
    const fresh =
      bytes === undefined
        ? bindFreshSource(source, {
            storageName,
            kind: 'new-memory-connection',
            isHeld: () => held,
          })
        : undefined
    return { source, fresh, storageName, rolledBackImages }
  }).pipe(Effect.provide(PlatformNode.NodeFileSystem.layer))

export const sequence = (global: number, client = 0, rebaseGeneration = 0) =>
  EventSequenceNumber.Client.Composite.make({ global, client, rebaseGeneration })

export const stored = (global: number, client = 0, rebaseGeneration = 0): Events.StoredEvent => ({
  event: LiveStoreEvent.Client.Encoded.make({
    name: 'v1.TodoCreated',
    args: { id: `${global}.${client}r${rebaseGeneration}`, text: 'Retained "value"', nested: [1, null, true] },
    seqNum: sequence(global, client, rebaseGeneration),
    parentSeqNum: sequence(Math.max(0, global - 1)),
    clientId: 'client-A',
    sessionId: 'session-A',
  }),
  schemaHash: 42,
  syncMetadata: Option.none(),
})
