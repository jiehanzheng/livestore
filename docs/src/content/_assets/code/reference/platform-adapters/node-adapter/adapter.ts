// ---cut---
import { makeAdapter } from '@livestore/adapter-node'
import { makeWsSync } from '@livestore/sync-cf/client'

const adapter = makeAdapter({
  storage: { type: 'fs', baseDirectory: './livestore-data' },
  clientId: 'node-client',
  // or in-memory:
  // storage: { type: 'in-memory' },
  sync: { backend: makeWsSync({ url: 'ws://localhost:8787' }) },
})
