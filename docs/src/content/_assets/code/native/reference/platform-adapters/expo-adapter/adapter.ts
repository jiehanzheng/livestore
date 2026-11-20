// ---cut---
import { makeAdapter } from '@livestore/adapter-expo'

const adapter = makeAdapter({
  clientId: 'expo-app-client',
  storage: {
    // Optional: custom base directory (defaults to expo-sqlite's default)
    // directory: '/custom/path/to/databases',
    subDirectory: 'my-app',
  },
})
