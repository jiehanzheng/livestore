<script setup lang="ts">
import { onMounted, onScopeDispose, provide, shallowRef } from 'vue'

import { makePersistedAdapter } from '@livestore/adapter-web'
import LiveStoreSharedWorker from '@livestore/adapter-web/shared-worker?sharedworker'
import { createStorePromise, type Store } from '@livestore/livestore'

import LiveStoreWorker from './livestore/livestore.worker.ts?worker'
import { schema } from './livestore/schema.ts'
import { storeKey } from './livestore/store.ts'

const adapter = makePersistedAdapter({
  storage: { type: 'opfs' },
  worker: LiveStoreWorker,
  sharedWorker: LiveStoreSharedWorker,
})

const storeOptions = {
  schema,
  adapter,
  storeId: 'test_store',
}

const store = shallowRef<Store<typeof schema>>()
const error = shallowRef<unknown>()
let disposed = false
provide(storeKey, store)

// Boot can finish after unmount; that store still belongs to this provider and must close.
onScopeDispose(() => {
  disposed = true
  void store.value?.shutdownPromise().catch(console.error)
})
onMounted(async () => {
  try {
    const loaded = await createStorePromise(storeOptions)
    if (disposed) await loaded.shutdownPromise()
    else store.value = loaded
  } catch (cause) {
    error.value = cause
  }
})
</script>

<template>
  <div v-if="error" role="alert">{{ String(error) }}</div>
  <slot v-else-if="store" />
  <div v-else>Loading LiveStore...</div>
</template>
