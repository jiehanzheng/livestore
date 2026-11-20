import { makeAdapter } from '@livestore/adapter-expo'

// A separate subdirectory preserves existing data; it does not reset any store.
const adapter = makeAdapter({
  clientId: 'expo-development-client',
  storage: { subDirectory: 'development' },
})
