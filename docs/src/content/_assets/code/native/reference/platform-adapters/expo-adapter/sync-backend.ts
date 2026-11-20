// ---cut---
import { makeAdapter } from '@livestore/adapter-expo'
import { makeWsSync } from '@livestore/sync-cf/client'

const adapter = makeAdapter({
  clientId: 'expo-app-client',
  sync: { backend: makeWsSync({ url: 'wss://your-sync-backend.com' }) },
})
