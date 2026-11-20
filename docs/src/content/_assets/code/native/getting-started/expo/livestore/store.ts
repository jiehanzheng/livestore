import { randomUUID } from 'expo-crypto'
import { unstable_batchedUpdates as batchUpdates } from 'react-native'

import { makeAdapter } from '@livestore/adapter-expo'
import type { Store } from '@livestore/livestore'
import { type ReactApi, useStore } from '@livestore/react'
import { makeWsSync } from '@livestore/sync-cf/client'

import { events, schema, tables } from './schema.ts'

const syncUrl = 'https://example.org/sync'

const adapter = makeAdapter({
  clientId: 'expo-todomvc-client',
  sync: { backend: makeWsSync({ url: syncUrl }) },
})

export const useAppStore = (): Store<typeof schema> & ReactApi =>
  useStore({
    storeId: 'expo-todomvc',
    schema,
    adapter,
    disableDevtools: true,
    batchUpdates: (run) => batchUpdates(run, undefined),
    boot: (store) => {
      if (store.query(tables.todos.count()) === 0) {
        store.commit(events.todoCreated({ id: randomUUID(), text: 'Make coffee' }))
      }
    },
  })
