import { type BootStatus, type SqliteDb, SqliteDbHelper } from '@livestore/common'
import { Eventlog, LeaderPersistence, makeMaterializeEvent, recreateDb } from '@livestore/common/leader-thread'
import { EventSequenceNumber, LiveStoreEvent, SystemTables } from '@livestore/common/schema'
import { loadSqlite3Wasm } from '@livestore/sqlite-wasm/load-wasm'
import { sqliteDbFactory } from '@livestore/sqlite-wasm/node'
import { Effect, Queue } from '@livestore/utils/effect'
import { PlatformNode } from '@livestore/utils/node'

import { events, makeSqliteServicesLayer, schema } from './fixture.ts'

const [directory, boundary] = process.argv.slice(2)
if (directory === undefined || boundary === undefined) throw new Error('Expected directory and crash boundary')

await Effect.runPromise(
  Effect.gen(function* () {
    const sqlite3 = yield* Effect.promise(() => loadSqlite3Wasm())
    const makeSqliteDb = yield* sqliteDbFactory({ sqlite3 })
    const rawState = yield* makeSqliteDb({ _tag: 'fs', directory, fileName: 'state.db' })
    const rawEventlog = yield* makeSqliteDb({ _tag: 'fs', directory, fileName: 'eventlog.db' })
    let armed = false
    const crash = () => process.kill(process.pid, 'SIGKILL')
    const dbState: SqliteDb = {
      ...rawState,
      execute: SqliteDbHelper.makeExecute((...args) => {
        if (armed === true && boundary === 'crash-before-state' && args[0] === 'COMMIT') crash()
        const result = rawState.execute(...args)
        if (armed === true && boundary === 'crash-after-state' && args[0] === 'COMMIT') crash()
        if (
          armed === true &&
          boundary === 'crash-after-completion' &&
          args[0].startsWith(`INSERT OR REPLACE INTO ${SystemTables.REBUILD_META_TABLE}`) === true
        )
          crash()
        return result
      }),
    }
    const dbEventlog: SqliteDb = {
      ...rawEventlog,
      execute: SqliteDbHelper.makeExecute((...args) => {
        const result = rawEventlog.execute(...args)
        if (armed === true && boundary === 'crash-after-eventlog' && args[0] === 'COMMIT') crash()
        return result
      }),
    }
    yield* Eventlog.initEventlogDb(dbEventlog, { sourceIsNew: true })
    const services = makeSqliteServicesLayer({ dbState, dbEventlog })
    const materializeEvent = yield* makeMaterializeEvent({ schema }).pipe(Effect.provide(services))
    const bootStatusQueue = yield* Queue.unbounded<BootStatus>()
    yield* recreateDb({ schema, bootStatusQueue, materializeEvent }).pipe(Effect.provide(services))
    const persistence = yield* LeaderPersistence.make({ materializeEvent, schema }).pipe(Effect.provide(services))
    const todo = (id: string, rebaseGeneration: number) =>
      LiveStoreEvent.Client.Encoded.make({
        name: events.todoCreated.name,
        args: { id, text: id },
        seqNum: EventSequenceNumber.Client.Composite.make({ global: 1, client: 0, rebaseGeneration }),
        parentSeqNum: EventSequenceNumber.Client.ROOT,
        clientId: 'test',
        sessionId: 'test-session',
      })
    const original = todo('original', 0)
    const replacement = todo('replacement', 1)
    yield* persistence.persistLocal({ events: [original] })
    armed = true
    yield* persistence.persistUpstream({
      events: [replacement],
      rollbackEvents: [original],
      pulledEvents: [],
      confirmedEvents: [],
      backendHead: EventSequenceNumber.Client.ROOT,
    })
    throw new Error(`Did not reach ${boundary}`)
  }).pipe(Effect.provide(PlatformNode.NodeFileSystem.layer)),
)
