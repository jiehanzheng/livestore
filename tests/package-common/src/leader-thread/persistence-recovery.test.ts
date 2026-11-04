import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { expect } from 'vitest'

import { type BootStatus, type SqliteDb, SqliteDbHelper, StateSnapshot, SourceIdentity } from '@livestore/common'
import {
  Eventlog,
  LeaderPersistence,
  LeaderThreadCtx,
  makeLeaderThreadLayer,
  makeMaterializeEvent,
  recreateDb,
  ShutdownChannel,
} from '@livestore/common/leader-thread'
import { EventSequenceNumber, LiveStoreEvent, SystemTables, makeSchema, State } from '@livestore/common/schema'
import { loadSqlite3Wasm } from '@livestore/sqlite-wasm/load-wasm'
import { reserveNodeSource, sqliteDbFactory } from '@livestore/sqlite-wasm/node'
import { Vitest } from '@livestore/utils-dev/node-vitest'
import { Effect, FetchHttpClient, FileSystem, Layer, Queue, WebChannel } from '@livestore/utils/effect'
import { PlatformNode } from '@livestore/utils/node'

import { ownSource, events, getStateHead, makeSqliteServicesLayer, schema, tables } from './fixture.ts'

/** Real retained files distinguish cross-database recovery from ordinary transaction rollback. */
for (const commitOutcome of [
  'state-rejected',
  'state-committed-but-threw',
  'rejected',
  'committed-but-threw',
  'completion-rejected',
  'rollback-rejected',
  'crash-before-state',
  'crash-after-state',
  'crash-after-eventlog',
  'crash-after-completion',
  'legacy-completed',
  'malformed-completed',
  'confirmation-rejected',
  'confirmation-committed-but-threw',
  'confirmation-noop',
] as const) {
  Vitest.live(`recovers authoritative pending events after eventlog COMMIT ${commitOutcome}`, (test) =>
    Effect.gen(function* () {
      const sqlite3 = yield* Effect.promise(() => loadSqlite3Wasm())
      const makeSqliteDb = yield* sqliteDbFactory({ sqlite3 })
      const fs = yield* FileSystem.FileSystem
      const directory = yield* fs.makeTempDirectoryScoped()
      const open = (fileName: string, newlyAllocated = false) =>
        makeSqliteDb({
          _tag: 'fs',
          directory,
          fileName,
          ...(newlyAllocated === true ? { sourceCreation: reserveNodeSource(path.join(directory, fileName)) } : {}),
        })
      const original = todo('original', 0)
      const replacement = todo('replacement', 1)

      if (commitOutcome.startsWith('crash-') === true) {
        const child = spawnSync(
          'bun',
          [fileURLToPath(new URL('./persistence-crash.fixture.ts', import.meta.url)), directory, commitOutcome],
          { encoding: 'utf8' },
        )
        expect(child.error).toBeUndefined()
        expect(child.signal, child.stderr).toBe('SIGKILL')
      } else
        yield* Effect.gen(function* () {
          const rawState = yield* Effect.acquireRelease(open('state.db'), (db) => Effect.sync(() => db.close()))
          const dbState: SqliteDb = {
            ...rawState,
            execute: SqliteDbHelper.makeExecute((...args) => {
              if (failCommit === true && commitOutcome.startsWith('state-') === true && args[0] === 'COMMIT') {
                if (commitOutcome === 'state-committed-but-threw') rawState.execute(...args)
                throw new Error('Injected state COMMIT failure')
              }
              if (
                failCommit === true &&
                commitOutcome === 'completion-rejected' &&
                args[0].startsWith(`INSERT OR REPLACE INTO ${SystemTables.REBUILD_META_TABLE}`) === true
              ) {
                throw new Error('Injected completion failure')
              }
              return rawState.execute(...args)
            }),
          }
          const dbEventlog = yield* open('eventlog.db', true)
          let failCommit = false
          const wrappedEventlog: SqliteDb = {
            ...dbEventlog,
            execute: SqliteDbHelper.makeExecute((...args) => {
              if (failCommit === true && args[0] === 'ROLLBACK' && commitOutcome === 'rollback-rejected')
                throw new Error('Injected rollback failure')
              if (
                failCommit === true &&
                args[0] === 'COMMIT' &&
                (commitOutcome === 'rejected' ||
                  commitOutcome === 'committed-but-threw' ||
                  commitOutcome === 'rollback-rejected' ||
                  (commitOutcome.startsWith('confirmation-') === true && commitOutcome !== 'confirmation-noop'))
              ) {
                if (commitOutcome === 'committed-but-threw' || commitOutcome === 'confirmation-committed-but-threw')
                  dbEventlog.execute(...args)
                throw new Error('Injected eventlog COMMIT failure')
              }
              return dbEventlog.execute(...args)
            }),
          }
          const source = yield* ownSource(wrappedEventlog, dbEventlog.metadata.sourceCreation)
          const initializedSource = yield* Eventlog.initializeSource(source)
          const services = makeSqliteServicesLayer({ dbState, source })
          const materializeEvent = yield* makeMaterializeEvent({ schema }).pipe(Effect.provide(services))
          const bootStatusQueue = yield* Queue.unbounded<BootStatus>()
          yield* recreateDb({ initializedSource, schema, bootStatusQueue, materializeEvent }).pipe(
            Effect.provide(services),
          )
          const persistence = yield* LeaderPersistence.make({ materializeEvent, schema }).pipe(Effect.provide(services))
          yield* persistence.persistLocal({ events: [original] })
          if (commitOutcome === 'malformed-completed') {
            rawState.execute(`UPDATE ${SystemTables.REBUILD_META_TABLE} SET proofVersion = 99`)
            rawState.execute("UPDATE todos SET id = 'replacement', text = 'replacement'")
            return
          }
          if (commitOutcome === 'legacy-completed') {
            rawState.execute(`ALTER TABLE ${SystemTables.REBUILD_META_TABLE} RENAME TO __livestore_rebuild`)
            rawState.execute("UPDATE todos SET id = 'replacement', text = 'replacement'")
            return
          }
          failCommit = true
          // Same count and logical head, different source identity: head/count comparisons cannot detect this split.
          const transition = persistence.persistUpstream(
            commitOutcome.startsWith('confirmation-') === true
              ? {
                  events: [],
                  rollbackEvents: [],
                  pulledEvents: [],
                  confirmedEvents: [original],
                  backendHead: original.seqNum,
                }
              : {
                  events: [replacement],
                  rollbackEvents: [original],
                  pulledEvents: [],
                  confirmedEvents: [],
                  backendHead: EventSequenceNumber.Client.ROOT,
                },
          )
          if (commitOutcome === 'confirmation-noop') {
            yield* transition
            expect(dbState.select(SystemTables.rebuildMetaTable).map(({ id }) => ({ id }))).toEqual([{ id: 1 }])
            return
          }
          yield* transition.pipe(Effect.flip)
          expect(dbState.select(SystemTables.rebuildMetaTable)).toEqual([])
          // Reopening is mandatory even if rollback appeared to work.
          const sourceAfterFailure = dbEventlog.select(SystemTables.eventlogMetaTable)
          failCommit = false
          yield* persistence.persistLocal({ events: [] }).pipe(Effect.flip)
          expect(dbEventlog.select(SystemTables.eventlogMetaTable)).toEqual(sourceAfterFailure)
        }).pipe(Effect.scoped)

      yield* Effect.gen(function* () {
        const dbEventlog = yield* open('eventlog.db')
        const source = yield* ownSource(dbEventlog)
        const initializedSource = yield* Eventlog.initializeSource(source)
        const dbState = yield* Effect.acquireRelease(open('state.db'), (db) => Effect.sync(() => db.close()))
        const sourceBeforeBoot = dbEventlog.select(SystemTables.eventlogMetaTable)
        const shutdown = yield* WebChannel.queueChannelProxy({ schema: ShutdownChannel.All })
        yield* Effect.gen(function* () {
          const leader = yield* LeaderThreadCtx
          const expected =
            ['committed-but-threw', 'completion-rejected', 'crash-after-eventlog', 'crash-after-completion'].includes(
              commitOutcome,
            ) === true
              ? replacement
              : original
          expect(dbState.select(tables.todos)).toEqual([
            { id: expected.args.id, text: expected.args.text, completed: false, deletedAt: null },
          ])
          expect(yield* getStateHead(dbState)).toEqual(expected.seqNum)
          const confirmed =
            commitOutcome === 'confirmation-noop' || commitOutcome === 'confirmation-committed-but-threw'
          expect((yield* leader.syncProcessor.syncState.get).pending).toEqual(confirmed === true ? [] : [expected])
          expect(dbState.select(SystemTables.materializationJournalMetaTable)).toHaveLength(confirmed === true ? 0 : 1)
          expect(dbEventlog.select(SystemTables.eventlogMetaTable)).toEqual(sourceBeforeBoot)
        }).pipe(
          Effect.provide(
            makeLeaderThreadLayer({
              initializedSource,
              schema,
              storeId: 'recovery',
              clientId: 'test',
              syncPayloadEncoded: undefined,
              syncPayloadSchema: undefined,
              makeSqliteDb,
              syncOptions: undefined,
              devtoolsOptions: { enabled: false },
              shutdownChannel: shutdown.webChannel,
            }).pipe(Layer.provide(makeSqliteServicesLayer({ dbState, source })), Layer.provide(FetchHttpClient.layer)),
          ),
        )
      }).pipe(Effect.scoped)
    }).pipe(Effect.provide(PlatformNode.NodeFileSystem.layer), Vitest.withTestCtx(test)),
  )
}

const todo = (id: string, rebaseGeneration: number) =>
  LiveStoreEvent.Client.Encoded.make({
    name: events.todoCreated.name,
    args: { id, text: id },
    seqNum: EventSequenceNumber.Client.Composite.make({ global: 1, client: 0, rebaseGeneration }),
    parentSeqNum: EventSequenceNumber.Client.ROOT,
    clientId: 'test',
    sessionId: 'test-session',
  })

Vitest.live('rebuilds A to B to A projections over the same retained source and rejects each stale cache', (test) =>
  Effect.gen(function* () {
    const sqlite3 = yield* Effect.promise(() => loadSqlite3Wasm())
    const makeSqliteDb = yield* sqliteDbFactory({ sqlite3 })
    const fs = yield* FileSystem.FileSystem
    const directory = yield* fs.makeTempDirectoryScoped()
    const variants = ['A', 'B'].map((revision) =>
      makeSchema({
        projectionRevision: `projection-${revision}-v1`,
        events,
        state: State.SQLite.makeState({
          tables: { todos: tables.todos },
          materializers: State.SQLite.materializers(events, {
            todoCreated: ({ id, text, completed }) =>
              tables.todos.insert({ id, text: `${revision}:${text}`, completed: completed ?? false }),
            todoCompleted: ({ id }) => tables.todos.update({ completed: true }).where({ id }),
            todoDeletedNonPure: ({ id }) => tables.todos.update({ deletedAt: new Date(0) }).where({ id }),
          }),
        }),
      }),
    )
    const projectionA = variants[0]!
    const projectionB = variants[1]!
    expect(StateSnapshot.getProjectionIdentity(projectionA).stateSchemaHash).toBe(
      StateSnapshot.getProjectionIdentity(projectionB).stateSchemaHash,
    )
    let incarnation: string | undefined
    let cached: StateSnapshot.Provenance | undefined
    for (const [index, current] of [projectionA, projectionB, projectionA].entries()) {
      yield* Effect.gen(function* () {
        const open = (fileName: string, newlyAllocated = false) =>
          makeSqliteDb({
            _tag: 'fs',
            directory,
            fileName,
            ...(newlyAllocated === true ? { sourceCreation: reserveNodeSource(path.join(directory, fileName)) } : {}),
          })
        const openState = (fileName: string) =>
          Effect.acquireRelease(open(fileName), (db) => Effect.sync(() => db.close()))
        const dbEventlog = yield* open('eventlog.db', index === 0)
        const source = yield* ownSource(dbEventlog, dbEventlog.metadata.sourceCreation)
        const initializedSource = yield* Eventlog.initializeSource(source)
        const dbState = yield* openState('state.db')
        const channel = yield* WebChannel.queueChannelProxy({ schema: ShutdownChannel.All })
        yield* Effect.gen(function* () {
          const leader = yield* LeaderThreadCtx
          if (index === 0) yield* leader.syncProcessor.push([todo('retained', 0)])
          expect(dbState.select(tables.todos).map((row) => row.text)).toEqual([`${index === 1 ? 'B' : 'A'}:retained`])
          const identity = yield* SourceIdentity.read(source.handle)
          if (incarnation === undefined) incarnation = identity.incarnation
          expect(identity.incarnation).toBe(incarnation)
          const admission = yield* leader.syncProcessor.openSession({
            expectedProjection: StateSnapshot.getProjectionIdentity(current),
            candidate: cached,
          })
          expect(admission.admission._tag).toBe('StaleSnapshot')
          cached = StateSnapshot.readProvenance(dbState)!
          expect(cached.projection.projectionRevision).toBe(current.projectionRevision)
        }).pipe(
          Effect.provide(
            makeLeaderThreadLayer({
              schema: current,
              initializedSource,
              storeId: 'projection-recovery',
              clientId: 'test',
              makeSqliteDb,
              syncOptions: undefined,
              syncPayloadEncoded: undefined,
              syncPayloadSchema: undefined,
              devtoolsOptions: { enabled: false },
              shutdownChannel: channel.webChannel,
            }).pipe(Layer.provide(makeSqliteServicesLayer({ dbState, source })), Layer.provide(FetchHttpClient.layer)),
          ),
        )
      }).pipe(Effect.scoped)
    }
  }).pipe(Effect.provide(PlatformNode.NodeFileSystem.layer), Vitest.withTestCtx(test)),
)

Vitest.live('source reset and same-head regrowth invalidate a retained cache from the previous incarnation', (test) =>
  Effect.gen(function* () {
    const sqlite3 = yield* Effect.promise(() => loadSqlite3Wasm())
    const makeSqliteDb = yield* sqliteDbFactory({ sqlite3 })
    const fs = yield* FileSystem.FileSystem
    const directory = yield* fs.makeTempDirectoryScoped()
    const open = (fileName: string, newlyAllocated = false) =>
      makeSqliteDb({
        _tag: 'fs',
        directory,
        fileName,
        ...(newlyAllocated === true ? { sourceCreation: reserveNodeSource(path.join(directory, fileName)) } : {}),
      })
    const openState = (fileName: string) => Effect.acquireRelease(open(fileName), (db) => Effect.sync(() => db.close()))
    const captured = yield* Effect.gen(function* () {
      const dbEventlog = yield* open('eventlog.db', true)
      const source = yield* ownSource(dbEventlog, dbEventlog.metadata.sourceCreation)
      const initializedSource = yield* Eventlog.initializeSource(source)
      const dbState = yield* openState('state.db')
      const services = makeSqliteServicesLayer({ dbState, source })
      const materializeEvent = yield* makeMaterializeEvent({ schema }).pipe(Effect.provide(services))
      const bootStatusQueue = yield* Queue.unbounded<BootStatus>()
      yield* recreateDb({ initializedSource, schema, materializeEvent, bootStatusQueue }).pipe(Effect.provide(services))
      const persistence = yield* LeaderPersistence.make({ schema, materializeEvent }).pipe(Effect.provide(services))
      yield* persistence.persistLocal({ events: [todo('before-reset', 0)] })
      const provenance = StateSnapshot.readProvenance(dbState)!
      const head = yield* Eventlog.getClientHeadFromDb(source.handle)
      yield* persistence.resetSource
      expect((yield* SourceIdentity.read(source.handle)).incarnation).not.toBe(provenance.sourceIncarnation)
      return { provenance, head }
    }).pipe(Effect.scoped)
    yield* Effect.gen(function* () {
      const dbEventlog = yield* open('eventlog.db')
      const source = yield* ownSource(dbEventlog)
      const initializedSource = yield* Eventlog.initializeSource(source)
      const dbState = yield* openState('state.db')
      const channel = yield* WebChannel.queueChannelProxy({ schema: ShutdownChannel.All })
      yield* Effect.gen(function* () {
        const leader = yield* LeaderThreadCtx
        yield* leader.syncProcessor.push([todo('after-reset', 0)])
        expect(yield* Eventlog.getClientHeadFromDb(source.handle)).toEqual(captured.head)
        expect(dbState.select(tables.todos).map((row) => row.id)).toEqual(['after-reset'])
        const opened = yield* leader.syncProcessor.openSession({
          expectedProjection: StateSnapshot.getProjectionIdentity(schema),
          candidate: captured.provenance,
        })
        expect(opened.admission._tag).toBe('StaleSnapshot')
        expect(opened.admission.provenance.sourceIncarnation).not.toBe(captured.provenance.sourceIncarnation)
      }).pipe(
        Effect.provide(
          makeLeaderThreadLayer({
            schema,
            initializedSource,
            storeId: 'source-reset-recovery',
            clientId: 'test',
            makeSqliteDb,
            syncOptions: undefined,
            syncPayloadEncoded: undefined,
            syncPayloadSchema: undefined,
            devtoolsOptions: { enabled: false },
            shutdownChannel: channel.webChannel,
          }).pipe(Layer.provide(makeSqliteServicesLayer({ dbState, source })), Layer.provide(FetchHttpClient.layer)),
        ),
      )
    }).pipe(Effect.scoped)
  }).pipe(Effect.provide(PlatformNode.NodeFileSystem.layer), Vitest.withTestCtx(test)),
)
