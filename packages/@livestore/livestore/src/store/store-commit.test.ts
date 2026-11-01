import { expect, vi } from 'vitest'

import { SqliteError } from '@livestore/common'
import { Vitest } from '@livestore/utils-dev/node-vitest'
import { Effect } from '@livestore/utils/effect'

import { type LocalCommitOutcome, StoreInternalsSymbol } from '../mod.ts'
import { ChangesetCleanupError } from '../SqliteDbWrapper.ts'
import { events, makeTodoMvc, tables } from '../utils/tests/fixture.ts'

Vitest.describe('Store commit API', () => {
  Vitest.live('should materialize events returned by the commit callback', () =>
    Effect.gen(function* () {
      const store = yield* makeTodoMvc()
      const firstTodo = { id: '1', text: 'Make coffee', completed: false }
      const secondTodo = { id: '2', text: 'Buy groceries', completed: false }

      // Regression for https://github.com/livestorejs/livestore/issues/1611.
      store.commit(() => {
        expect(store.query(tables.todos)).toEqual([])
        return [events.todoCreated(firstTodo), events.todoCreated(secondTodo)]
      })

      expect(store.query(tables.todos.orderBy('id', 'asc'))).toEqual([firstTodo, secondTodo])
    }).pipe(Effect.scoped),
  )

  Vitest.live('should materialize a single callback event', () =>
    Effect.gen(function* () {
      const store = yield* makeTodoMvc()
      const todo = { id: '1', text: 'Make coffee', completed: false }
      const batch = [events.todoCreated(todo)] as const

      store.commit(() => batch)

      expect(store.query(tables.todos)).toEqual([todo])
    }).pipe(Effect.scoped),
  )

  Vitest.live('should accept an empty callback', () =>
    Effect.gen(function* () {
      const store = yield* makeTodoMvc()

      store.commit(() => [])

      expect(store.query(tables.todos)).toEqual([])
    }).pipe(Effect.scoped),
  )

  Vitest.live('should apply no events when the callback throws', () =>
    Effect.gen(function* () {
      const store = yield* makeTodoMvc()
      const todo = { id: '1', text: 'Make coffee', completed: false }
      const error = new Error('Callback failed')

      expect(() =>
        store.commit(() => {
          throw error
        }),
      ).toThrow(error)

      expect(store.query(tables.todos)).toEqual([])
      store.commit(events.todoCreated(todo))
      expect(store.query(tables.todos)).toEqual([todo])
    }).pipe(Effect.scoped),
  )

  Vitest.live('should commit multiple returned event types in order', () =>
    Effect.gen(function* () {
      const store = yield* makeTodoMvc()
      const todo = { id: '1', text: 'Make coffee', completed: false }

      store.commit(() => [events.todoCreated(todo), events.todoCompleted({ id: todo.id })])

      expect(store.query(tables.todos)).toEqual([{ ...todo, completed: true }])
    }).pipe(Effect.scoped),
  )

  for (const options of [{}, { label: 'Create todo' }]) {
    Vitest.live(`should accept callback options ${JSON.stringify(options)}`, () =>
      Effect.gen(function* () {
        const store = yield* makeTodoMvc()
        const todo = { id: '1', text: 'Make coffee', completed: false }

        store.commit(options, () => [events.todoCreated(todo)])

        expect(store.query(tables.todos)).toEqual([todo])
      }).pipe(Effect.scoped),
    )
  }

  Vitest.live('should reject callback values that are not event arrays', () =>
    Effect.gen(function* () {
      const store = yield* makeTodoMvc()

      expect(() => Reflect.apply(store.commit, store, [() => undefined])).toThrow(
        'store.commit callback must synchronously return an array of events',
      )
      expect(() => Reflect.apply(store.commit, store, [() => Promise.resolve([])])).toThrow(
        'store.commit callback must synchronously return an array of events',
      )

      expect(store.query(tables.todos)).toEqual([])
    }).pipe(Effect.scoped),
  )

  Vitest.live('should reject non-array and asynchronous callbacks at the type level', () =>
    Effect.gen(function* () {
      const store = yield* makeTodoMvc()

      // Keep invalid calls uninvoked so TypeScript checks the public overloads without executing them.
      const assertRejectedCallbackTypes = () => {
        // @ts-expect-error Commit callbacks must return an event array.
        store.commit(() => {})
        // @ts-expect-error Commit callbacks do not receive an event emitter.
        store.commit((emit: () => void) => {
          emit()
          return []
        })
        // @ts-expect-error Commit callbacks must be synchronous.
        store.commit(async () => [])
      }

      expect(assertRejectedCallbackTypes).toBeTypeOf('function')
    }).pipe(Effect.scoped),
  )

  Vitest.live('should still accept direct events with options and no events', () =>
    Effect.gen(function* () {
      const store = yield* makeTodoMvc()
      const todo = { id: '1', text: 'Make coffee', completed: false }

      store.commit()
      store.commit({ label: 'Empty commit' })
      store.commit({ label: 'Create and complete' }, events.todoCreated(todo), events.todoCompleted({ id: todo.id }))

      expect(store.query(tables.todos)).toEqual([{ ...todo, completed: true }])
    }).pipe(Effect.scoped),
  )
})

Vitest.describe('Store local commit outcomes', () => {
  Vitest.live('preserves all overloads, empty no-ops and legacy void', () =>
    Effect.gen(function* () {
      const store = yield* makeTodoMvc()
      const todo = (id: string) => events.todoCreated({ id, text: id, completed: false })
      const results: LocalCommitOutcome[] = [
        store.commitWithOutcome(),
        store.commitWithOutcome(() => []),
        store.commitWithOutcome(todo('one')),
        store.commitWithOutcome(() => [todo('two')]),
        store.commitWithOutcome({ label: 'direct' }, todo('three')),
        store.commitWithOutcome({ skipRefresh: true }, () => [todo('four')]),
      ]
      expect(results.map((result) => result._tag)).toEqual(Array(6).fill('AcceptedLocally'))
      expect(store.commit(todo('five'))).toBeUndefined()
      expect(store.query(tables.todos)).toHaveLength(5)
      const invalidTypes = () => {
        // @ts-expect-error Callback is a synchronous array builder.
        store.commitWithOutcome(async () => [])
        // @ts-expect-error Callback must return an array.
        store.commitWithOutcome(() => undefined)
      }
      expect(invalidTypes).toBeTypeOf('function')
    }).pipe(Effect.scoped),
  )

  Vitest.live('keeps callback exceptions outside receipt handling', () =>
    Effect.gen(function* () {
      const store = yield* makeTodoMvc()
      const failure = new Error('builder failed before admission')
      expect(() =>
        store.commitWithOutcome(() => {
          throw failure
        }),
      ).toThrow(failure)
      expect(store.commitWithOutcome()).toEqual({ _tag: 'AcceptedLocally' })
    }).pipe(Effect.scoped),
  )

  Vitest.live('returns an invocation-specific rejection for real SQLite failure after a successful prefix', () =>
    Effect.gen(function* () {
      const store = yield* makeTodoMvc()
      const event = events.todoCreated({ id: 'duplicate', text: 'original', completed: false })
      const result = store.commitWithOutcome(event, event)
      expect(result._tag).toBe('RejectedBeforeEnqueue')
      if (result._tag !== 'AcceptedLocally') expect(result.cause).toBeDefined()
      // A receipt does not authorize continued writes through the failed Store.
      yield* Effect.yieldNow
      expect(() => store.commitWithOutcome()).toThrow()
    }).pipe(Effect.scoped),
  )

  Vitest.live('does not claim rejection after admission when refresh fails', () =>
    Effect.gen(function* () {
      const store = yield* makeTodoMvc()
      const refresh = vi.spyOn(store[StoreInternalsSymbol].reactivityGraph, 'setRefs').mockImplementation(() => {
        throw new Error('notification failure after admission')
      })
      const result = store.commitWithOutcome(events.todoCreated({ id: 'admitted', text: 'admitted', completed: false }))
      refresh.mockRestore()
      expect(result._tag).toBe('Indeterminate')
    }).pipe(Effect.scoped),
  )

  Vitest.live('does not certify rejection when native changeset cleanup fails', () =>
    Effect.gen(function* () {
      const store = yield* makeTodoMvc()
      const db = store[StoreInternalsSymbol].sqliteDbWrapper
      const session = vi.spyOn(db, 'withChangeset').mockImplementation(() => {
        throw new ChangesetCleanupError({ cause: new Error('native session finish failure') })
      })
      const result = store.commitWithOutcome(events.todoCreated({ id: 'cleanup', text: 'cleanup', completed: false }))
      session.mockRestore()
      expect(result._tag).toBe('Indeterminate')
    }).pipe(Effect.scoped),
  )
})

Vitest.describe('Store changeset failure boundaries', () => {
  for (const point of ['acquire', 'extract', 'finish'] as const) {
    Vitest.live(`keeps native session ${point} failure indeterminate`, () =>
      Effect.gen(function* () {
        const store = yield* makeTodoMvc()
        const native = store[StoreInternalsSymbol].clientSession.sqliteDb
        const acquire = native.session.bind(native)
        const spy = vi.spyOn(native, 'session').mockImplementation(() => {
          if (point === 'acquire') throw new SqliteError({ cause: 'session acquisition failed' })
          const session = acquire()
          return {
            ...session,
            changeset: () => {
              if (point === 'extract') throw new SqliteError({ cause: 'changeset extraction failed' })
              return session.changeset()
            },
            finish: () => {
              session.finish()
              if (point === 'finish') throw new SqliteError({ cause: 'session finish failed' })
            },
          }
        })
        const result = store.commitWithOutcome(events.todoCreated({ id: point, text: point, completed: false }))
        spy.mockRestore()
        expect(result._tag).toBe('Indeterminate')
      }).pipe(Effect.scoped),
    )
  }
})
