import { expect } from 'vitest'

import { Vitest } from '@livestore/utils-dev/node-vitest'
import { Effect } from '@livestore/utils/effect'

import { events, makeTodoMvc, tables } from '../utils/tests/fixture.ts'

Vitest.describe('Store subscription disposal', () => {
  Vitest.live('allows a callback to dispose subscriptions invalidated by the same commit', () =>
    Effect.gen(function* () {
      const store = yield* makeTodoMvc()
      const stops: (() => void)[] = []
      const seen: string[] = []
      let armed = false
      try {
        stops.push(
          store.subscribe(tables.todos, (todos) => {
            seen.push(`first:${todos.length}`)
            if (armed === true) {
              for (const stop of stops.splice(0)) stop()
              stops.push(store.subscribe(tables.todos, (rows) => seen.push(`replacement:${rows.length}`)))
            }
          }),
        )
        stops.push(
          store.subscribe(tables.todos.where({ completed: true }), (todos) => {
            seen.push(`second:${todos.length}`)
          }),
        )
        seen.length = 0
        armed = true

        store.commit(events.todoCreated({ id: '1', text: 'First', completed: true }))
        expect(seen).toEqual(['first:1', 'replacement:1'])
        store.commit(events.todoCreated({ id: '2', text: 'Second', completed: true }))
        expect(seen).toEqual(['first:1', 'replacement:1', 'replacement:2'])
        expect(store.query(tables.todos)).toHaveLength(2)
      } finally {
        for (const stop of stops.splice(0)) stop()
      }
    }).pipe(Effect.scoped),
  )
})
