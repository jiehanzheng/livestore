import { makeAdapter } from '@livestore/adapter-node'
import { createStorePromise } from '@livestore/livestore'

import { schema } from './schema.ts'

const adapter = makeAdapter({
  storage: { type: 'fs', baseDirectory: './livestore-data' },
  clientId: 'node-store-client',
  // sync: { backend: makeWsSync({ url: '...' }) },
})

export const bootstrap = async () => {
  const store = await createStorePromise({
    schema,
    adapter,
    storeId: 'some-store-id',
    disableDevtools: true,
  })

  return store
}
