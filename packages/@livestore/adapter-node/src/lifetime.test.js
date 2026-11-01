import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { expect, test, vi } from 'vitest'

import { provideOtel } from '@livestore/common'
import { Events, makeSchema, State } from '@livestore/common/schema'
import { createStore } from '@livestore/livestore'
import { Effect, Exit, Schema, Scope } from '@livestore/utils/effect'

import { makeAdapter } from './index.ts'

const handles = vi.hoisted(() => [])
vi.mock('@livestore/sqlite-wasm/node', async (original) => {
  const real = await original()
  return {
    ...real,
    sqliteDbFactory: (options) =>
      real.sqliteDbFactory(options).pipe(
        Effect.map(
          (make) => (input) =>
            make(input).pipe(
              Effect.map((db) => {
                const record = { closed: false, closes: 0 }
                const close = db.close.bind(db)
                db.close = () => {
                  close()
                  record.closed = true
                  record.closes++
                }
                handles.push(record)
                return db
              }),
            ),
        ),
      ),
  }
})

const rows = State.SQLite.table({
  name: 'lifetime_entries',
  columns: {
    id: State.SQLite.text({ primaryKey: true }),
    text: State.SQLite.text(),
  },
})
const events = {
  created: Events.synced({ name: 'created', schema: Schema.Struct({ id: Schema.String, text: Schema.String }) }),
}
const schema = makeSchema({
  projectionRevision: 'adapter-node-fixture-v1',
  events,
  state: State.SQLite.makeState({
    tables: { rows },
    materializers: State.SQLite.materializers(events, { created: (value) => rows.insert(value) }),
  }),
})
const run = (effect) => Effect.runPromise(Effect.scoped(effect).pipe(provideOtel({})))

test('immediate commit then shutdown drains source write before every connection closes, and offline reopen retains it', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'node-adapter-final-push-'))
  const start = handles.length
  try {
    await run(
      Effect.gen(function* () {
        for (let iteration = 0; iteration < 3; iteration++) {
          const lifetime = yield* Effect.acquireRelease(Scope.make(), (scope) => Scope.close(scope, Exit.void))
          const store = yield* createStore({
            schema,
            storeId: 'immediate-close',
            disableDevtools: true,
            adapter: makeAdapter({ storage: { type: 'fs', baseDirectory: directory }, clientId: 'retained-client' }),
          }).pipe(Scope.provide(lifetime))
          expect(store.storageMode).toBe('persisted')
          expect(store.query(rows)).toHaveLength(iteration)
          store.commit(events.created({ id: String(iteration), text: `Dinner ${iteration}` }))
          // Deliberately do not wait for a persistence-status callback before closing.
          yield* store.shutdown()
          yield* Scope.close(lifetime, Exit.void)
          expect(handles.slice(start).every((value) => value.closed && value.closes === 1)).toBe(true)
        }
        const reopened = yield* createStore({
          schema,
          storeId: 'immediate-close',
          disableDevtools: true,
          adapter: makeAdapter({ storage: { type: 'fs', baseDirectory: directory }, clientId: 'retained-client' }),
        })
        expect(reopened.query(rows)).toEqual([0, 1, 2].map((i) => ({ id: String(i), text: `Dinner ${i}` })))
        yield* reopened.shutdown()
      }),
    )
    expect(handles.length - start).toBeGreaterThanOrEqual(12)
    expect(handles.slice(start).every((value) => value.closed && value.closes === 1)).toBe(true)
  } finally {
    fs.rmSync(directory, { recursive: true })
  }
})

test('in-memory storage is truthfully reported and all connections are scoped', async () => {
  const start = handles.length
  await run(
    Effect.gen(function* () {
      const store = yield* createStore({
        schema,
        storeId: 'memory-lifetime',
        disableDevtools: true,
        adapter: makeAdapter({ clientId: 'fixture-client', storage: { type: 'in-memory' } }),
      })
      expect(store.storageMode).toBe('in-memory')
      store.commit(events.created({ id: 'memory', text: 'Ephemeral' }))
      expect(store.query(rows)).toEqual([{ id: 'memory', text: 'Ephemeral' }])
      yield* store.shutdown()
    }),
  )
  expect(handles.length - start).toBeGreaterThanOrEqual(3)
  expect(handles.slice(start).every((value) => value.closed && value.closes === 1)).toBe(true)
})

test('cancelling blocked initial synchronization joins acquired databases', async () => {
  const start = handles.length
  await run(
    Effect.gen(function* () {
      const { Deferred, Fiber } = yield* Effect.promise(() => import('@livestore/utils/effect'))
      const entered = yield* Deferred.make()
      const boot = yield* Effect.scoped(
        createStore({
          schema,
          storeId: 'cancelled-boot',
          disableDevtools: true,
          adapter: makeAdapter({
            clientId: 'fixture-client',
            storage: { type: 'in-memory' },
            sync: {
              backend: () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
              initialSyncOptions: { _tag: 'Blocking', timeout: 10000 },
            },
          }),
        }),
      ).pipe(Effect.forkScoped)
      yield* Deferred.await(entered)
      yield* Fiber.interrupt(boot)
    }),
  )
  expect(handles.length - start).toBeGreaterThanOrEqual(2)
  expect(handles.slice(start).every((value) => value.closed && value.closes === 1)).toBe(true)
})

test('failed initial synchronization joins acquired databases without exposing a Store', async () => {
  const start = handles.length
  const result = await run(
    Effect.scoped(
      createStore({
        schema,
        storeId: 'failed-boot',
        disableDevtools: true,
        adapter: makeAdapter({
          clientId: 'fixture-client',
          storage: { type: 'in-memory' },
          sync: {
            backend: () => Effect.die(new Error('Deliberate backend factory failure')),
            initialSyncOptions: { _tag: 'Blocking', timeout: 10000 },
            onSyncError: 'shutdown',
          },
        }),
      }),
    ).pipe(Effect.exit),
  )
  expect(Exit.isFailure(result)).toBe(true)
  expect(handles.length - start).toBeGreaterThanOrEqual(2)
  expect(handles.slice(start).every((value) => value.closed && value.closes === 1)).toBe(true)
})

test('unsupported DevTools is refused before acquiring any SQLite handles', async () => {
  const start = handles.length
  const result = await run(
    Effect.scoped(
      createStore({
        schema,
        storeId: 'unsupported-devtools',
        adapter: makeAdapter({ clientId: 'fixture-client', storage: { type: 'in-memory' } }),
      }),
    ).pipe(Effect.exit),
  )
  expect(Exit.isFailure(result)).toBe(true)
  expect(handles.length).toBe(start)
})
