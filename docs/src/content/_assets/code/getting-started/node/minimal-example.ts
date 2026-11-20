// ---cut---
import { makeAdapter } from '@livestore/adapter-node'
import { createStorePromise } from '@livestore/livestore'

import { schema, tables } from './livestore/schema.ts'

const adapter = makeAdapter({
  storage: { type: 'fs', baseDirectory: './livestore-data' },
  clientId: 'node-demo-client',
  // sync: { backend: makeWsSync({ url: 'ws://localhost:8787' }) },
})

const main = async () => {
  const store = await createStorePromise({ adapter, schema, storeId: 'demo-store', disableDevtools: true })

  try {
    const todos = store.query(tables.todos)
    console.log(todos)
  } finally {
    await store.shutdownPromise()
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
