import { makePersistedAdapter } from '@livestore/adapter-web'
import LiveStoreSharedWorker from '@livestore/adapter-web/shared-worker?sharedworker'
import LiveStoreWorker from '@livestore/adapter-web/worker?worker'
import { storeOptions } from '@livestore/livestore'

import { schema } from './schema.ts'

export const adapter = makePersistedAdapter({
  storage: { type: 'opfs' },
  worker: LiveStoreWorker,
  sharedWorker: LiveStoreSharedWorker,
})

export const todoStoreOptions = storeOptions({
  storeId: 'effect-guide-todos',
  schema,
  adapter,
})
