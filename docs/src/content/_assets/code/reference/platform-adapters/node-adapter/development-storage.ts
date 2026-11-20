// ---cut---
import { makeAdapter } from '@livestore/adapter-node'

// A separate directory preserves existing data; it does not reset any store.
const adapter = makeAdapter({
  storage: { type: 'fs', baseDirectory: './livestore-development-data' },
  clientId: 'node-development-client',
})
