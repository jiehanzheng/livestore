import { expect } from 'vitest'

import { type BootStatus, AdmittedOwnerEndedError, openSnapshotSession, StateSnapshot } from '@livestore/common'
import { Eventlog, LeaderPersistence, makeMaterializeEvent, recreateDb } from '@livestore/common/leader-thread'
import { createStore, makeShutdownDeferred, StoreInternalsSymbol } from '@livestore/livestore'
import { loadSqlite3Wasm } from '@livestore/sqlite-wasm/load-wasm'
import { sqliteDbFactory } from '@livestore/sqlite-wasm/node'
import { Vitest } from '@livestore/utils-dev/node-vitest'
import {
  Cause,
  Deferred,
  Effect,
  Exit,
  FetchHttpClient,
  Fiber,
  Layer,
  Queue,
  Schema,
  Stream,
} from '@livestore/utils/effect'
import { PlatformNode } from '@livestore/utils/node'

import { events, makeSqliteServicesLayer, schema, tables } from '../leader-thread/fixture.ts'
import { makeTestAdapter } from '../test-adapter.ts'

Vitest.live('keeps an accepted snapshot and makes ownership loss terminal without opening another session', (test) =>
  Effect.gen(function* () {
    const { makeSqliteDb, db, persistence } = yield* setup
    const provenance = StateSnapshot.readProvenance(db)
    const admission = yield* persistence.admitSnapshot({
      expectedProjection: StateSnapshot.getProjectionIdentity(schema),
      candidate: provenance,
    })
    expect(admission._tag).toBe('Accepted')
    let opens = 0
    let allocations = 0
    const opened = yield* openSnapshotSession({
      expectedProjection: StateSnapshot.getProjectionIdentity(schema),
      candidate: { sqliteDb: db, snapshotByteLength: db.export().byteLength },
      makeSqliteDb: (...args) => {
        allocations++
        return makeSqliteDb(...args)
      },
      open: (candidate) => {
        opens++
        expect(candidate).toEqual({
          expectedProjection: StateSnapshot.getProjectionIdentity(schema),
          candidate: provenance,
        })
        return Stream.succeed({ ...admission, migrationsReport: { migrations: [] } })
      },
    })
    expect(opened.sqliteDb).toBe(db)
    expect(allocations).toBe(0)
    const exit = yield* opened.pull.pipe(Stream.runDrain, Effect.exit)
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit) === true) {
      const defect = Cause.squash(exit.cause)
      expect(Schema.is(AdmittedOwnerEndedError)(defect)).toBe(true)
      expect(defect).toHaveProperty('message', 'Admitted leader ended; reopen the Store')
    }
    expect(opens).toBe(1)
  }).pipe(Effect.provide(PlatformNode.NodeFileSystem.layer), Vitest.withTestCtx(test)),
)

Vitest.live('fails owner loss before the first admission frame without exposing a database', (test) =>
  Effect.gen(function* () {
    let allocations = 0
    const { makeSqliteDb } = yield* setup
    const result = yield* openSnapshotSession({
      expectedProjection: StateSnapshot.getProjectionIdentity(schema),
      candidate: undefined,
      makeSqliteDb: (...args) => {
        allocations++
        return makeSqliteDb(...args)
      },
      open: () => Stream.empty,
    }).pipe(Effect.exit)
    expect(result._tag).toBe('Failure')
    expect(allocations).toBe(0)
  }).pipe(Effect.provide(PlatformNode.NodeFileSystem.layer), Vitest.withTestCtx(test)),
)

Vitest.live('joins pre-admission cancellation and failed-import stream teardown', (test) =>
  Effect.gen(function* () {
    const { makeSqliteDb, persistence } = yield* setup
    const entered = yield* Deferred.make<void>()
    const finalized = yield* Deferred.make<void>()
    const cancelled = yield* openSnapshotSession({
      expectedProjection: StateSnapshot.getProjectionIdentity(schema),
      candidate: undefined,
      makeSqliteDb,
      open: () =>
        Stream.fromEffect(Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never))).pipe(
          Stream.ensuring(Deferred.succeed(finalized, undefined)),
        ),
    }).pipe(Effect.scoped, Effect.forkScoped)
    yield* Deferred.await(entered)
    yield* Fiber.interrupt(cancelled)
    const cancelledExit = yield* Fiber.await(cancelled)
    expect(cancelledExit._tag).toBe('Failure')
    if (cancelledExit._tag === 'Failure') expect(Cause.hasInterruptsOnly(cancelledExit.cause)).toBe(true)
    expect(yield* Deferred.isDone(finalized)).toBe(true)

    const admission = yield* persistence.admitSnapshot({
      expectedProjection: StateSnapshot.getProjectionIdentity(schema),
      candidate: undefined,
    })
    if (admission._tag !== 'StaleSnapshot') return yield* Effect.die('Expected replacement bytes')
    let allocated = 0
    let closed = 0
    let streamClosed = false
    const failingFactory: Parameters<typeof openSnapshotSession>[0]['makeSqliteDb'] = (input) =>
      makeSqliteDb(input).pipe(
        Effect.map((db) => ({
          ...db,
          import: () => {
            throw new Error('Injected import failure')
          },
          close: () => {
            closed++
            db.close()
          },
        })),
        Effect.tap(() =>
          Effect.sync(() => {
            allocated++
          }),
        ),
      )
    const failed = yield* openSnapshotSession({
      expectedProjection: StateSnapshot.getProjectionIdentity(schema),
      candidate: undefined,
      makeSqliteDb: failingFactory,
      open: () =>
        Stream.concat(Stream.succeed({ ...admission, migrationsReport: { migrations: [] } }), Stream.never).pipe(
          Stream.ensuring(
            Effect.sync(() => {
              streamClosed = true
            }),
          ),
        ),
    }).pipe(Effect.scoped, Effect.exit)
    expect(failed._tag).toBe('Failure')
    expect(allocated).toBe(1)
    expect(closed).toBe(allocated)
    expect(streamClosed).toBe(true)
  }).pipe(Effect.provide(PlatformNode.NodeFileSystem.layer), Vitest.withTestCtx(test)),
)

for (const invariantFailure of [false, true]) {
  Vitest.live(
    `preserves the admitted stream terminal cause through Store shutdown (invariant failure: ${invariantFailure})`,
    (test) =>
      Effect.gen(function* () {
        const { makeSqliteDb, db, persistence } = yield* setup
        const admission = yield* persistence.admitSnapshot({
          expectedProjection: StateSnapshot.getProjectionIdentity(schema),
          candidate: StateSnapshot.readProvenance(db),
        })
        const ended = yield* Deferred.make<void>()
        // Even an identical message is not the public owner-ended condition.
        const invariantError = new Error('Admitted leader ended; reopen the Store')
        let opens = 0
        const opened = yield* openSnapshotSession({
          expectedProjection: StateSnapshot.getProjectionIdentity(schema),
          candidate: { sqliteDb: db, snapshotByteLength: db.export().byteLength },
          makeSqliteDb,
          open: () => {
            opens++
            return Stream.concat(
              Stream.succeed({ ...admission, migrationsReport: { migrations: [] } }),
              Stream.fromEffect(Deferred.await(ended)).pipe(
                Stream.flatMap(() => (invariantFailure === true ? Stream.die(invariantError) : Stream.empty)),
              ),
            )
          },
        })
        const shutdown = yield* makeShutdownDeferred
        const store = yield* createStore({
          schema,
          storeId: `admitted-owner-end-${invariantFailure}`,
          shutdownDeferred: shutdown,
          adapter: makeTestAdapter({
            testing: {
              overrides: {
                clientSession: {
                  leaderThreadProxy: (leader) => ({ events: { ...leader.events, pull: () => opened.pull } }),
                },
              },
            },
          }),
        })
        expect(store.query(tables.todos)).toEqual([])
        yield* Deferred.succeed(ended, undefined)
        const exit = yield* Deferred.await(shutdown).pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit) === true) {
          const defect = Cause.squash(exit.cause)
          expect(Schema.is(AdmittedOwnerEndedError)(defect)).toBe(!invariantFailure)
          if (invariantFailure === true) expect(defect).toBe(invariantError)
        }
        expect(opens).toBe(1)
        expect(store[StoreInternalsSymbol].isShutdown).toBe(true)
        expect(() => store.query(tables.todos)).toThrow()
        expect(() => store.commit(events.todoCreated({ id: 'too-late', text: 'Too late' }))).toThrow()
      }).pipe(
        Effect.provide(Layer.mergeAll(PlatformNode.NodeFileSystem.layer, FetchHttpClient.layer)),
        Vitest.withTestCtx(test),
      ),
  )
}

const setup = Effect.gen(function* () {
  const sqlite3 = yield* Effect.promise(() => loadSqlite3Wasm())
  const makeSqliteDb = yield* sqliteDbFactory({ sqlite3 })
  const db = yield* Effect.acquireRelease(makeSqliteDb({ _tag: 'in-memory' }), (db) => Effect.sync(() => db.close()))
  const eventlog = yield* Effect.acquireRelease(makeSqliteDb({ _tag: 'in-memory' }), (db) =>
    Effect.sync(() => db.close()),
  )
  yield* Eventlog.initEventlogDb(eventlog, { sourceIsNew: true })
  const services = makeSqliteServicesLayer({ dbState: db, dbEventlog: eventlog })
  const materializeEvent = yield* makeMaterializeEvent({ schema }).pipe(Effect.provide(services))
  const bootStatusQueue = yield* Queue.unbounded<BootStatus>()
  yield* recreateDb({ schema, bootStatusQueue, materializeEvent }).pipe(Effect.provide(services))
  const persistence = yield* LeaderPersistence.make({ materializeEvent, schema }).pipe(Effect.provide(services))
  return { makeSqliteDb, db, persistence }
})
