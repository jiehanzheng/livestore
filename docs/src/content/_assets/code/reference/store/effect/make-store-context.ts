import { makeAdapter } from '@livestore/adapter-node'
import { Store } from '@livestore/livestore/effect'

import { schema } from './schema.ts'

// ---cut---
// Define a typed store context with your schema
export const TodoStore = Store.Tag(schema, 'todos')

// Create a layer to initialize the store
const adapter = makeAdapter({
  storage: { type: 'fs', baseDirectory: './livestore-data' },
  clientId: 'node-effect-client',
})

export const TodoStoreLayer = TodoStore.layer({
  adapter,
  disableDevtools: true,
  batchUpdates: (cb) => cb(), // For Node.js; use React's unstable_batchedUpdates in React apps
})
