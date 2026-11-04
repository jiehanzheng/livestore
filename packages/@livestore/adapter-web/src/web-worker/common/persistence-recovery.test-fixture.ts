import { openSnapshotSession } from '@livestore/common'
import {
  type BootStatus,
  EventlogSqliteDb,
  MaterializationJournal,
  type SqliteDb,
  SqliteDbHelper,
  StateHead,
  StateSnapshot,
  StateSqliteDb,
} from '@livestore/common'
import {
  configureConnection,
  LeaderPersistence,
  LeaderThreadCtx,
  makeLeaderThreadLayer,
  makeMaterializeEvent,
  recreateDb,
  ShutdownChannel,
} from '@livestore/common/leader-thread'
import { Events, EventSequenceNumber, LiveStoreEvent, makeSchema, State, SystemTables } from '@livestore/common/schema'
import { fromSyncSource, initializeSource, SourceEvents, type SourceOwner } from '@livestore/common/source-db'
import { sqliteDbFactory } from '@livestore/sqlite-wasm/browser'
import { loadSqlite3Wasm } from '@livestore/sqlite-wasm/load-wasm'
import { deepEqual } from '@livestore/utils'
import { Effect, FetchHttpClient, Layer, Queue, Schema, Stream, WebChannel } from '@livestore/utils/effect'
import { Opfs } from '@livestore/utils/effect/browser'

import {
  discoverPersistedSource,
  getStateDbFileName,
  readPersistedStateDbFromClientSession,
  sanitizeOpfsDir,
} from './persisted-sqlite.ts'
import { acquireSourceNamespace } from './source-namespace.ts'

/** Dedicated-worker fixture: the parent terminates this worker at a real SQLite boundary, without finalizers. */
type Command = {
  action: 'seed' | 'recover' | 'fast-read'
  namespace: string
  boundary?: 'before-state' | 'after-state' | 'after-eventlog' | 'after-completion' | 'rebuild-post'
  confirmation?: boolean
  delayed?: boolean
  capturedSnapshot?: Uint8Array<ArrayBuffer>
}

const values = State.SQLite.table({
  name: 'fork_recovery_values',
  columns: { id: State.SQLite.text({ primaryKey: true }) },
})
const events = {
  created: Events.synced({ name: 'fork.recovery.created', schema: Schema.Struct({ id: Schema.String }) }),
}
const sourceEvent = (id: string, rebaseGeneration: number) =>
  LiveStoreEvent.Client.Encoded.make({
    name: events.created.name,
    args: { id },
    seqNum: EventSequenceNumber.Client.Composite.make({ global: 1, client: 0, rebaseGeneration }),
    parentSeqNum: EventSequenceNumber.Client.ROOT,
    clientId: 'fork-fixture-client',
    sessionId: 'fork-fixture-session',
  })

addEventListener('message', (message: MessageEvent<Command>) => {
  const request = message.data
  if (/^fork-correctness-opfs-[a-z0-9-]+$/.test(request.namespace) === false) {
    postMessage({ error: 'Refusing namespace outside this fixture' })
    return
  }
  const parkAtBoundary = (boundary: string) => {
    postMessage({ boundary, namespace: request.namespace })
    // An actual synchronization barrier keeps COMMIT's caller from running cleanup before parent termination.
    // This is a worker-only wait, released solely by terminating this owned test worker.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)
    throw new Error('Crash barrier unexpectedly resumed')
  }
  const schema = makeSchema({
    projectionRevision: 'persistence-recovery-fixture-v1',
    events,
    state: State.SQLite.makeState({
      tables: { values },
      materializers: State.SQLite.materializers(events, { 'fork.recovery.created': ({ id }) => values.insert({ id }) }),
      migrations: request.boundary === 'rebuild-post' ? { hooks: { post: () => parkAtBoundary('rebuild-post') } } : {},
    }),
  })
  let stage = 'load-sqlite'
  let ownedDirectory: string | undefined
  const run = Effect.gen(function* () {
    const sqlite3 = yield* Effect.promise(() => loadSqlite3Wasm())
    const makeSqliteDb = yield* sqliteDbFactory({ sqlite3 })
    const directory = yield* sanitizeOpfsDir(undefined, request.namespace)
    ownedDirectory = directory
    stage = 'fast-read'
    if (request.action === 'fast-read') {
      const snapshot = yield* readPersistedStateDbFromClientSession({
        storageOptions: { type: 'opfs' },
        storeId: request.namespace,
        schema,
        makeSqliteDb,
      }).pipe(
        Effect.match({
          onSuccess: ({ sqliteDb }) => ({ accepted: true, rows: sqliteDb.select(values) }),
          onFailure: (error) => ({ accepted: false, error: error._tag }),
        }),
      )
      return { namespace: request.namespace, directory, snapshot }
    }
    const namespace = yield* acquireSourceNamespace({ directory, closePhysicalOwner: makeSqliteDb.close })
    const discovery = yield* discoverPersistedSource({
      storageOptions: { type: 'opfs' },
      storeId: request.namespace,
      namespace,
    })
    const services = yield* Effect.context()
    let sourceOwner: SourceOwner | undefined
    const open = (fileName: string, isSource = false) =>
      Effect.acquireRelease(
        makeSqliteDb({
          _tag: 'opfs',
          opfsDirectory: directory,
          fileName,
          ...(isSource === true && discovery.inventory !== undefined ? { sourceInventory: discovery.inventory } : {}),
          configureDb: (db) => configureConnection(db, { foreignKeys: true }).pipe(Effect.runSyncWith(services)),
        }),
        (db) =>
          isSource === true && sourceOwner !== undefined
            ? sourceOwner.close.pipe(Effect.orDie)
            : Effect.sync(() => db.close()),
      )
    stage = 'open-eventlog'
    const rawEventlog = yield* open('eventlog.db', true)
    let armed = false
    const observedEventlog: SqliteDb = {
      ...rawEventlog,
      execute: SqliteDbHelper.makeExecute((...args) => {
        rawEventlog.execute(...args)
        if (armed === true && request.boundary === 'after-eventlog' && args[0] === 'COMMIT')
          parkAtBoundary('after-eventlog')
      }),
    }
    const dbEventlog = yield* fromSyncSource(
      observedEventlog,
      rawEventlog.metadata._tag === 'opfs' ? rawEventlog.metadata.sourceCreation : undefined,
      namespace.isHeld,
    )
    sourceOwner = dbEventlog
    const initializedSource = yield* initializeSource(dbEventlog)
    stage = 'open-state'
    const rawState = yield* open(getStateDbFileName(schema))
    const dbState: SqliteDb = {
      ...rawState,
      execute: SqliteDbHelper.makeExecute((...args) => {
        if (armed === true && request.boundary === 'before-state' && args[0] === 'COMMIT')
          parkAtBoundary('before-state')
        rawState.execute(...args)
        if (armed === true && request.boundary === 'after-state' && args[0] === 'COMMIT') parkAtBoundary('after-state')
        if (
          armed === true &&
          request.boundary === 'after-completion' &&
          args[0].startsWith(`INSERT OR REPLACE INTO ${SystemTables.REBUILD_META_TABLE}`) === true
        )
          parkAtBoundary('after-completion')
      }),
    }
    const dbLayer = Layer.mergeAll(StateSqliteDb.layer(dbState), EventlogSqliteDb.layer(dbEventlog))
    const stateLayer = Layer.mergeAll(StateHead.layer, MaterializationJournal.layer).pipe(Layer.provide(dbLayer))
    const layers = Layer.mergeAll(dbLayer, stateLayer)
    if (request.action === 'seed') {
      stage = 'initialize-source'
      const materializeEvent = yield* makeMaterializeEvent({ schema }).pipe(Effect.provide(layers))
      const bootStatusQueue = yield* Queue.unbounded<BootStatus>()
      stage = 'initial-reconstruction'
      yield* recreateDb({ schema, bootStatusQueue, materializeEvent, initializedSource }).pipe(Effect.provide(layers))
      const persistence = yield* LeaderPersistence.make({ materializeEvent, schema }).pipe(Effect.provide(layers))
      const base = sourceEvent('base', 0)
      const original =
        request.delayed === true
          ? LiveStoreEvent.Client.Encoded.make({
              ...sourceEvent('pending', 0),
              seqNum: EventSequenceNumber.Client.Composite.make({ global: 2, client: 0 }),
              parentSeqNum: base.seqNum,
            })
          : sourceEvent('original', 0)
      const remote = LiveStoreEvent.Client.Encoded.make({
        ...original,
        args: { id: 'remote' },
        clientId: 'peer',
        sessionId: 'peer',
      })
      const replacement =
        request.delayed === true
          ? LiveStoreEvent.Client.Encoded.make({
              ...original,
              seqNum: EventSequenceNumber.Client.Composite.make({ global: 3, client: 0, rebaseGeneration: 1 }),
              parentSeqNum: remote.seqNum,
            })
          : sourceEvent('replacement', 1)
      if (request.delayed === true)
        yield* persistence.persistUpstream({
          events: [base],
          rollbackEvents: [],
          pulledEvents: [],
          confirmedEvents: [],
          backendHead: base.seqNum,
        })
      stage = 'seed-pending'
      yield* persistence.persistLocal({ events: [original] })
      if (request.delayed === true) postMessage({ capturedSnapshot: yield* persistence.exportSnapshot })
      stage = 'rebase-transition'
      armed = true
      yield* persistence.persistUpstream(
        request.confirmation === true
          ? {
              events: [],
              rollbackEvents: [],
              pulledEvents: [],
              confirmedEvents: [original],
              backendHead: original.seqNum,
            }
          : {
              events: request.delayed === true ? [remote, replacement] : [replacement],
              rollbackEvents: [original],
              pulledEvents: [],
              confirmedEvents: [],
              backendHead: request.delayed === true ? remote.seqNum : EventSequenceNumber.Client.ROOT,
            },
      )
      throw new Error('Expected the parent to terminate this worker at a boundary')
    }
    stage = 'offline-leader-boot'
    const readSource = SourceEvents.selectStoredEvents(
      dbEventlog.handle,
      'SELECT * FROM eventlog ORDER BY seqNumGlobal, seqNumClient, seqNumRebaseGeneration',
    )
    const sourceBefore = yield* readSource
    const shutdown = yield* WebChannel.queueChannelProxy({ schema: ShutdownChannel.All })
    return yield* Effect.gen(function* () {
      const leader = yield* LeaderThreadCtx
      const state = yield* leader.syncProcessor.syncState.get
      const sourceAfter = yield* readSource
      const recovered = {
        namespace: request.namespace,
        directory,
        rows: dbState.select(values),
        pending: state.pending.map((event) => ({
          id: event.args.id,
          clientId: event.clientId,
          sessionId: event.sessionId,
        })),
        sourceIds: sourceAfter.map(({ event }) => event.args),
        sourceUnchanged: deepEqual(sourceBefore, sourceAfter),
        backendHead: yield* SourceEvents.readBackendHead(dbEventlog.handle),
        stateHead: dbState.select(SystemTables.stateHeadMetaTable),
        journalCount: dbState.select(SystemTables.materializationJournalMetaTable).length,
        marker: dbState.select(SystemTables.rebuildMetaTable),
      }
      if (request.capturedSnapshot === undefined) return recovered
      stage = 'delayed-snapshot-admission'
      const candidate = yield* Effect.acquireRelease(makeSqliteDb({ _tag: 'in-memory' }), (db) =>
        Effect.sync(() => db.close()),
      )
      candidate.import(request.capturedSnapshot)
      const capturedRows = candidate.select(values)
      const capturedProvenance = StateSnapshot.readProvenance(candidate)
      let admissionTag: string | undefined
      const opened = yield* openSnapshotSession({
        expectedProjection: StateSnapshot.getProjectionIdentity(schema),
        candidate: { sqliteDb: candidate, snapshotByteLength: request.capturedSnapshot.byteLength },
        makeSqliteDb,
        open: (admissionRequest) =>
          Effect.gen(function* () {
            const { admission, queue } = yield* leader.syncProcessor.openSession(admissionRequest)
            admissionTag = admission._tag
            return Stream.concat(
              Stream.succeed({ ...admission, migrationsReport: leader.initialState.migrationsReport }),
              Stream.fromQueue(queue).pipe(Stream.map((item) => ({ _tag: 'Pull' as const, item }))),
            )
          }).pipe(Stream.unwrap),
      })
      const admittedRows = opened.sqliteDb.select(values)
      const admittedProvenance = StateSnapshot.readProvenance(opened.sqliteDb)
      const later = LiveStoreEvent.Client.Encoded.make({
        ...sourceEvent('later', 0),
        seqNum: EventSequenceNumber.Client.Composite.make({
          global: 4,
          client: 0,
          rebaseGeneration: state.localHead.rebaseGeneration,
        }),
        parentSeqNum: state.localHead,
      })
      yield* leader.syncProcessor.push([later])
      const subsequent = yield* opened.pull.pipe(Stream.take(1), Stream.runCollect)
      return {
        ...recovered,
        admission: {
          tag: admissionTag,
          capturedRows,
          capturedProvenance,
          admittedRows,
          admittedProvenance,
          subsequentIds: subsequent.flatMap((item) => item.payload.newEvents.map((event) => event.args.id)),
        },
      }
    }).pipe(
      Effect.provide(
        makeLeaderThreadLayer({
          schema,
          initializedSource,
          storeId: request.namespace,
          clientId: 'fork-fixture-client',
          makeSqliteDb,
          syncOptions: undefined,
          syncPayloadEncoded: undefined,
          syncPayloadSchema: undefined,
          devtoolsOptions: { enabled: false },
          shutdownChannel: shutdown.webChannel,
        }).pipe(Layer.provide(layers), Layer.provide(FetchHttpClient.layer)),
      ),
    )
  }).pipe(Effect.scoped, Effect.provide(Opfs.layer), Effect.withSpan('fork-opfs-recovery-fixture'))
  // The actual SOURCE namespace lease releases on abrupt worker termination; fast reads remain concurrent.
  const execution = Effect.runPromise(run)
  void execution.then(
    (result) => postMessage({ result }),
    (error) => postMessage({ error: String(error), stage, namespace: request.namespace, directory: ownedDirectory }),
  )
})
