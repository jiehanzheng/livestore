import { expect, vi } from 'vitest'

import { makeInMemoryAdapter } from '@livestore/adapter-web'
import { provideOtel } from '@livestore/common'
import { Vitest } from '@livestore/utils-dev/node-vitest'
import { Cause, Deferred, Effect, Exit, Fiber, Stream } from '@livestore/utils/effect'

import { events, makeTodoMvc, schema, tables } from '../utils/tests/fixture.ts'
import { createStore } from './create-store.ts'
import { makeShutdownDeferred, type SyncStatus } from './store-types.ts'

Vitest.describe('sync status fanout', () => {
  Vitest.live('broadcasts committed progress to every public subscriber after materialization', () =>
    Effect.gen(function* () {
      const store = yield* makeTodoMvc()
      const rows: number[][] = [[], []]
      const observers = rows.map((values) =>
        observe(store.subscribeSyncStatus, () => {
          values.push(store.query(tables.todos).length)
        }),
      )
      try {
        for (const observer of observers) yield* observer.waitFor(() => true)
        expect(observers.map((observer) => observer.seen.length)).toEqual([1, 1])
        for (let i = 1; i <= 4; i++) {
          store.commit(events.todoCreated({ id: String(i), text: `Todo ${i}`, completed: false }))
          const head = store.syncStatus().localHead
          for (const observer of observers) {
            yield* observer.waitFor((status) => status.localHead === head && status.isSynced)
          }
        }
        expect(observers[0]!.seen).toEqual(observers[1]!.seen)
        expect(rows[0]).toEqual(rows[1])
        expect([...new Set(rows[0])]).toEqual([0, 1, 2, 3, 4])
        expect(observers[1]!.seen.at(-1)).toEqual(store.syncStatus())
      } finally {
        for (const observer of observers) observer.stop()
      }
    }).pipe(Effect.scoped),
  )

  Vitest.live('unsubscribes independently and seeds late listeners with only the current status', () =>
    Effect.gen(function* () {
      const store = yield* makeTodoMvc()
      const finalized = yield* Deferred.make<void>()
      const original = store.syncStatusStream
      const spy = vi
        .spyOn(store, 'syncStatusStream')
        .mockImplementationOnce(() => original().pipe(Stream.ensuring(Deferred.succeed(finalized, undefined))))
      const observers: ReturnType<typeof observe>[] = []
      const watch = () => {
        const observer = observe(store.subscribeSyncStatus)
        observers.push(observer)
        return observer
      }
      const commit = (id: string) => store.commit(events.todoCreated({ id, text: id, completed: false }))
      const confirmed = (observer: ReturnType<typeof observe>) => {
        const head = store.syncStatus().localHead
        return observer.waitFor((status) => status.localHead === head && status.isSynced)
      }
      try {
        const first = watch()
        const second = watch()
        yield* first.waitFor(() => true)
        yield* second.waitFor(() => true)
        commit('1')
        yield* confirmed(first)
        yield* confirmed(second)
        first.stop()
        yield* Deferred.await(finalized)
        const firstCount = first.seen.length
        commit('2')
        yield* confirmed(second)
        expect(first.seen).toHaveLength(firstCount)
        const current = store.syncStatus()
        const late = watch()
        yield* late.waitFor(() => true)
        expect(late.seen).toEqual([current])
        second.stop()
        commit('3')
        yield* confirmed(late)
        late.stop()
        commit('4')
        const fresh = watch()
        yield* confirmed(fresh)
        // With no observers only the latest snapshot is retained, not old progress.
        expect(fresh.seen.every((status) => status.localHead === store.syncStatus().localHead)).toBe(true)
      } finally {
        for (const observer of observers) observer.stop()
        spy.mockRestore()
      }
    }).pipe(Effect.scoped),
  )

  Vitest.live('does not publish progress from a rolled-back local mutation', () =>
    Effect.gen(function* () {
      const shutdown = yield* makeShutdownDeferred
      const store = yield* createStore({
        schema,
        storeId: 'local-failed-status',
        adapter: makeInMemoryAdapter(),
        shutdownDeferred: shutdown,
      }).pipe(provideOtel({}))
      const first = observe(store.subscribeSyncStatus)
      const second = observe(store.subscribeSyncStatus)
      try {
        yield* first.waitFor(() => true)
        yield* second.waitFor(() => true)
        store.commit(events.todoCreated({ id: 'saved', text: 'Saved', completed: false }))
        const head = store.syncStatus().localHead
        yield* first.waitFor((status) => status.localHead === head && status.isSynced)
        yield* second.waitFor((status) => status.localHead === head && status.isSynced)
        const before = [first.seen.slice(), second.seen.slice()]
        store.commit(
          events.todoCreated({ id: 'rolled-back', text: 'Rolled back', completed: false }),
          events.todoCreated({ id: 'saved', text: 'Duplicate', completed: false }),
        )
        const exit = yield* Deferred.await(shutdown).pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit) === true) expect(Cause.pretty(exit.cause)).toMatch(/constraint|UNIQUE/i)
        expect([first.seen, second.seen]).toEqual(before)
      } finally {
        first.stop()
        second.stop()
      }
    }).pipe(Effect.scoped),
  )

  Vitest.live('ends status streams and joins their finalizers on Store shutdown', () =>
    Effect.gen(function* () {
      const store = yield* makeTodoMvc()
      const ready = yield* Deferred.make<void>()
      const finalized = yield* Deferred.make<void>()
      const listener = yield* store.syncStatusStream().pipe(
        Stream.tap(() => Deferred.succeed(ready, undefined)),
        Stream.ensuring(Deferred.succeed(finalized, undefined)),
        Stream.runDrain,
        Effect.forkChild,
      )
      yield* Deferred.await(ready)
      yield* store.shutdown()
      const exit = yield* Fiber.await(listener)
      expect(Exit.isSuccess(exit)).toBe(true)
      expect(yield* Deferred.isDone(finalized)).toBe(true)
    }).pipe(Effect.scoped),
  )

  Vitest.live('cancels a listener before its bootstrap starts without affecting another listener', () =>
    Effect.gen(function* () {
      const store = yield* makeTodoMvc()
      const cancelled = observe(store.subscribeSyncStatus)
      cancelled.stop()
      cancelled.stop()
      const survivor = observe(store.subscribeSyncStatus)
      try {
        yield* survivor.waitFor(() => true)
        store.commit(events.todoCreated({ id: 'survivor', text: 'Survivor', completed: false }))
        const head = store.syncStatus().localHead
        yield* survivor.waitFor((status) => status.localHead === head && status.isSynced)
        expect(cancelled.seen).toEqual([])
        expect(survivor.seen.at(-1)).toEqual(store.syncStatus())
      } finally {
        cancelled.stop()
        survivor.stop()
      }
    }).pipe(Effect.scoped),
  )

  Vitest.live('subscribes before an initial callback synchronously commits', () =>
    Effect.gen(function* () {
      const store = yield* makeTodoMvc()
      const first = observe(store.subscribeSyncStatus)
      let committed = false
      let second: ReturnType<typeof observe> | undefined
      try {
        yield* first.waitFor(() => true)
        second = observe(store.subscribeSyncStatus, () => {
          if (committed === false) {
            committed = true
            store.commit(events.todoCreated({ id: 'initial', text: 'Initial callback', completed: false }))
          }
        })
        yield* second.waitFor(() => true)
        const head = store.syncStatus().localHead
        yield* first.waitFor((status) => status.localHead === head && status.isSynced)
        yield* second.waitFor((status) => status.localHead === head && status.isSynced)
        expect(first.seen).toEqual(second.seen)
        expect(second.seen.at(-1)).toEqual(store.syncStatus())
        expect(store.query(tables.todos)).toHaveLength(1)
      } finally {
        first.stop()
        second?.stop()
      }
    }).pipe(Effect.scoped),
  )
})

const observe = (
  subscribe: (onUpdate: (status: SyncStatus) => void) => () => void,
  onUpdate: () => void = () => {},
) => {
  const seen: SyncStatus[] = []
  const waiters = new Set<{ predicate: (status: SyncStatus) => boolean; ready: Deferred.Deferred<void> }>()
  const stop = subscribe((status) => {
    seen.push(status)
    onUpdate()
    for (const waiter of waiters) {
      if (waiter.predicate(status) === true) {
        waiters.delete(waiter)
        Deferred.doneUnsafe(waiter.ready, Effect.void)
      }
    }
  })
  return {
    seen,
    stop,
    waitFor: (predicate: (status: SyncStatus) => boolean) =>
      Effect.suspend(() => {
        if (seen.some(predicate) === true) return Effect.void
        const ready = Deferred.makeUnsafe<void>()
        const waiter = { predicate, ready }
        waiters.add(waiter)
        return Deferred.await(ready).pipe(Effect.ensuring(Effect.sync(() => waiters.delete(waiter))))
      }),
  }
}
