import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { createStore, type Store } from '@livestore/livestore'

import { makeAdapter } from '../../../packages/@livestore/adapter-node/src/index.ts'
import { provideOtel } from '../../../packages/@livestore/common/src/index.ts'
import { Effect } from '../../../packages/@livestore/utils/src/effect/mod.ts'
import { PlatformNode } from '../../../packages/@livestore/utils/src/node/mod.ts'
import { schema, tables } from '../src/livestore/schema.ts'
import { createInitialTodoEvents, createTodoEvent } from '../src/todo-events.ts'

test('two script executions append distinct todos to the same retained store', async () => {
  const baseDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'script-demo-reopen-'))
  const withStore = (run: (store: Store<typeof schema>) => void) =>
    Effect.runPromise(
      Effect.scoped(
        createStore({
          schema,
          storeId: 'script-reopen',
          disableDevtools: true,
          adapter: makeAdapter({ storage: { type: 'fs', baseDirectory }, clientId: 'script-test' }),
        }).pipe(Effect.tap((store) => Effect.sync(() => run(store)))),
      ).pipe(provideOtel({}), Effect.provide(PlatformNode.NodeFileSystem.layer)),
    )

  try {
    let originalIds: string[] = []
    await withStore((store) => {
      store.commit(...createInitialTodoEvents())
      store.commit(createTodoEvent('Do something 1'))
      const todos = store.query(tables.todos)
      assert.equal(todos.length, 3)
      originalIds = todos.map((todo) => todo.id)
    })

    await withStore((store) => {
      assert.deepEqual(
        store
          .query(tables.todos)
          .map((todo) => todo.id)
          .toSorted(),
        originalIds.toSorted(),
      )
      store.commit(...createInitialTodoEvents())
      store.commit(createTodoEvent('Do something 1'))
      const todos = store.query(tables.todos)
      assert.equal(todos.length, 6)
      assert.equal(new Set(todos.map((todo) => todo.id)).size, 6)
      assert.equal(todos.filter((todo) => todo.text === 'Buy milk' && todo.completed).length, 2)
      assert.equal(todos.filter((todo) => todo.text === 'Buy bread' && !todo.completed).length, 2)
      assert.equal(todos.filter((todo) => todo.text === 'Do something 1' && !todo.completed).length, 2)
    })
  } finally {
    await fs.rm(baseDirectory, { recursive: true, force: true })
  }
})
