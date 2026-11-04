import { expect, test } from 'vitest'

import {
  MaterializationJournal,
  migrateDb,
  SqliteDbHelper,
  StateHead,
  StateSnapshot,
  StateSqliteDb,
} from '@livestore/common'
import { Eventlog, LeaderPersistence, makeMaterializeEvent } from '@livestore/common/leader-thread'
import { EventSequenceNumber, LiveStoreEvent, SystemTables } from '@livestore/common/schema'
import {
  fromSourceDb,
  initializeSource,
  makeSourceDb,
  sourceDriverFromSync,
  SourceContext,
  type SourceOwner,
} from '@livestore/common/source-db'
import { bindFreshSource } from '@livestore/common/source-db/internal'
import { loadSqlite3Wasm } from '@livestore/sqlite-wasm/load-wasm'
import { sqliteDbFactory } from '@livestore/sqlite-wasm/node'
import { Effect, Exit, Layer } from '@livestore/utils/effect'
import { PlatformNode } from '@livestore/utils/node'

import { events, schema, tables } from './fixture.ts'

const withFixture = async (run: (fixture: Awaited<ReturnType<typeof setup>>) => Promise<void>) => {
  const fixture = await setup()
  try {
    await run(fixture)
  } finally {
    fixture.exportRelease.resolve()
    fixture.importRelease.resolve()
    fixture.writeRelease.resolve()
    await Promise.allSettled(fixture.pending)
    await Effect.runPromise(fixture.owner.close)
    fixture.state.close()
  }
}
const setup = () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const runtime = yield* Effect.context<never>()
      const sqlite3 = yield* Effect.promise(() => loadSqlite3Wasm())
      const makeDb = yield* sqliteDbFactory({ sqlite3 })
      const raw = yield* makeDb({ _tag: 'in-memory' })
      const rawState = yield* makeDb({ _tag: 'in-memory' })
      const exportEntered = Promise.withResolvers<void>(),
        exportRelease = Promise.withResolvers<void>()
      const importEntered = Promise.withResolvers<void>(),
        importRelease = Promise.withResolvers<void>()
      const stateFenceDeleted = Promise.withResolvers<void>()
      const writeCommitted = Promise.withResolvers<void>(),
        writeRelease = Promise.withResolvers<void>()
      let pauseWriteAck = false
      let afterCompletion: (() => void) | undefined
      let pauseExport = false,
        pauseImport = false,
        materializations = 0,
        stateCommits = 0,
        completions = 0,
        sourceInserts = 0
      const native = sourceDriverFromSync(raw)
      const source = yield* makeSourceDb({
        ...native,
        execute: async (sql, bindings) => {
          if (/INSERT.*eventlog/i.test(sql) === true) sourceInserts++
          return native.execute(sql, bindings)
        },
        export: async () => {
          if (pauseExport === true) {
            exportEntered.resolve()
            await exportRelease.promise
          }
          return native.export()
        },
        import: async (bytes) => {
          if (pauseImport === true) {
            importEntered.resolve()
            await importRelease.promise
          }
          return native.import(bytes)
        },
      })
      const physical = fromSourceDb(source, {
        storageName: ':memory:import-admission',
        fresh: bindFreshSource(source, {
          storageName: ':memory:import-admission',
          kind: 'new-memory-connection',
          isHeld: () => true,
        }),
      })
      const owner: SourceOwner = {
        ...physical,
        write: (use) =>
          physical.write(use).pipe(
            Effect.tap(() =>
              pauseWriteAck === true
                ? Effect.promise(async () => {
                    writeCommitted.resolve()
                    await writeRelease.promise
                  })
                : Effect.void,
            ),
          ),
      }
      const image = owner.image
      if (image === undefined) return yield* Effect.die(new Error('Test memory SOURCE requires image support'))
      const initialized = yield* initializeSource(owner)
      const state = {
        ...rawState,
        execute: SqliteDbHelper.makeExecute((...args) => {
          if (args[0] === `DELETE FROM ${SystemTables.REBUILD_META_TABLE}`) stateFenceDeleted.resolve()
          if (args[0] === 'COMMIT') stateCommits++
          if (args[0].startsWith(`INSERT OR REPLACE INTO ${SystemTables.REBUILD_META_TABLE}`) === true) completions++
          const result = rawState.execute(...args)
          if (args[0].startsWith(`INSERT OR REPLACE INTO ${SystemTables.REBUILD_META_TABLE}`) === true)
            afterCompletion?.()
          return result
        }),
      }
      yield* migrateDb({ db: state, schema })
      StateSnapshot.writeProvenance(state, {
        proofVersion: StateSnapshot.PROOF_VERSION,
        ownerId: 'initial',
        transitionId: 'initial',
        sourceIncarnation: initialized.identity.incarnation,
        projection: StateSnapshot.getProjectionIdentity(schema),
      })
      const base = Layer.mergeAll(StateSqliteDb.layer(state), Layer.succeed(SourceContext, owner))
      const services = Layer.mergeAll(
        base,
        Layer.mergeAll(StateHead.layer, MaterializationJournal.layer).pipe(Layer.provide(base)),
      )
      const materialize = yield* makeMaterializeEvent({ schema }).pipe(Effect.provide(services))
      const persistence = yield* LeaderPersistence.make({
        schema,
        materializeEvent: (event, options) => {
          materializations++
          return materialize(event, options)
        },
      }).pipe(Effect.provide(services))
      const bytes = yield* source.export
      materializations = 0
      stateCommits = 0
      completions = 0
      sourceInserts = 0
      const event = LiveStoreEvent.Client.Encoded.make({
        name: events.todoCreated.name,
        args: { id: 'raced', text: 'raced' },
        clientId: 'test',
        sessionId: 'test',
        seqNum: EventSequenceNumber.Client.Composite.make({ global: 1, client: 0 }),
        parentSeqNum: EventSequenceNumber.Client.ROOT,
      })
      const pending: Promise<unknown>[] = []
      return {
        owner,
        image,
        importAfterCompletion: () => {
          afterCompletion = () => {
            pending.push(Effect.runPromiseWith(runtime)(image.import(bytes)))
          }
        },
        writeCommitted,
        writeRelease,
        pauseWriteAck: () => {
          pauseWriteAck = true
        },
        state,
        persistence,
        event,
        bytes,
        pending,
        exportEntered,
        exportRelease,
        importEntered,
        importRelease,
        stateFenceDeleted,
        pauseExport: () => {
          pauseExport = true
        },
        pauseImport: () => {
          pauseImport = true
        },
        counts: () => ({ materializations, stateCommits, completions, sourceInserts }),
        sourceRows: source.select('SELECT * FROM eventlog'),
      }
    }).pipe(Effect.provide(PlatformNode.NodeFileSystem.layer)),
  )

for (const mode of ['queued import', 'running import'] as const)
  test(`persistence refuses ${mode} without publishing a stale transition`, async () => {
    await withFixture(async (f) => {
      if (mode === 'queued import') {
        f.pauseExport()
        const reading = Effect.runPromise(f.image.export)
        f.pending.push(reading)
        await f.exportEntered.promise
        const importing = Effect.runPromise(f.image.import(f.bytes))
        f.pending.push(importing)
        const persisting = Effect.runPromiseExit(f.persistence.persistLocal({ events: [f.event] }))
        f.pending.push(persisting)
        await f.stateFenceDeleted.promise
        f.exportRelease.resolve()
        await reading
        await importing
        expect(Exit.isFailure(await persisting)).toBe(true)
      } else {
        f.pauseImport()
        const importing = Effect.runPromise(f.image.import(f.bytes))
        f.pending.push(importing)
        await f.importEntered.promise
        expect(Exit.isFailure(await Effect.runPromiseExit(f.persistence.persistLocal({ events: [f.event] })))).toBe(
          true,
        )
        f.importRelease.resolve()
        await importing
      }
      expect(f.counts()).toEqual({ materializations: 0, stateCommits: 0, completions: 0, sourceInserts: 0 })
      expect(f.state.select(tables.todos)).toEqual([])
      expect(await Effect.runPromise(f.sourceRows)).toEqual([])
      expect(Exit.isFailure(await Effect.runPromiseExit(f.persistence.exportSnapshot))).toBe(true)
    })
  })

test('import after real SOURCE commit refuses the delayed acknowledgement before writing completion', async () => {
  await withFixture(async (f) => {
    f.pauseWriteAck()
    const persisting = Effect.runPromiseExit(f.persistence.persistLocal({ events: [f.event] }))
    f.pending.push(persisting)
    await f.writeCommitted.promise
    // The real database transaction has committed and released its gate; only the owner acknowledgement is held.
    expect(f.counts()).toEqual({ materializations: 1, stateCommits: 1, completions: 0, sourceInserts: 1 })
    await Effect.runPromise(f.image.import(f.bytes))
    f.writeRelease.resolve()
    expect(Exit.isFailure(await persisting)).toBe(true)
    expect(f.counts()).toEqual({ materializations: 1, stateCommits: 1, completions: 0, sourceInserts: 1 })
    expect(StateSnapshot.readProvenance(f.state)).toBeUndefined()
    expect(f.state.select(tables.todos).map(({ id }) => id)).toEqual(['raced'])
    expect(await Effect.runPromise(f.sourceRows)).toEqual([])
    expect(Exit.isFailure(await Effect.runPromiseExit(f.persistence.exportSnapshot))).toBe(true)
  })
})

test('replacement admitted after the real completion INSERT removes its stale proof and refuses publication', async () => {
  await withFixture(async (f) => {
    f.importAfterCompletion()
    const result = await Effect.runPromiseExit(f.persistence.persistLocal({ events: [f.event] }))
    await Promise.all(f.pending)
    expect(Exit.isFailure(result)).toBe(true)
    expect(f.counts()).toEqual({ materializations: 1, stateCommits: 1, completions: 1, sourceInserts: 1 })
    expect(StateSnapshot.readProvenance(f.state)).toBeUndefined()
    expect(await Effect.runPromise(f.sourceRows)).toEqual([])
    expect(Exit.isFailure(await Effect.runPromiseExit(f.persistence.exportSnapshot))).toBe(true)
  })
})
