import { LiveStoreClientDO as ProductionClientDO } from '../src/live-store-client-do.ts'
import { tables } from '../src/livestore/schema.ts'
import type { Env as ProductionEnv } from '../src/shared.ts'
import productionWorker from '../src/worker.ts'

export { SyncBackendDO } from '../src/sync-backend-do.ts'

export class LiveStoreClientDO extends ProductionClientDO {
  async observeCompletedTodo({ storeId, id }: { storeId: string; id: string }) {
    await super.fetch(new Request(`http://fixture/client-do?storeId=${encodeURIComponent(storeId)}`))
    const store = await this.getStore()
    let resolve!: (value: { id: string; completed: boolean }) => void
    let reject!: (error: Error) => void
    const observed = new Promise<{ id: string; completed: boolean }>((yes, no) => {
      resolve = yes
      reject = no
    })
    const timeout = setTimeout(() => reject(new Error('Client DO projection did not reach the expected row')), 10000)
    // Producer push acknowledgement is not a barrier for this independent projection.
    // Observe this actual store through its public API, including an already-present row.
    let unsubscribe = () => {}
    try {
      unsubscribe = store.subscribe(tables.todos, (rows) => {
        const row = rows.find((todo) => todo.id === id && todo.completed)
        if (row !== undefined) resolve({ id: row.id, completed: row.completed })
      })
      return await observed
    } finally {
      clearTimeout(timeout)
      unsubscribe()
    }
  }
}

type Env = Omit<ProductionEnv, 'CLIENT_DO'> & { CLIENT_DO: DurableObjectNamespace<LiveStoreClientDO> }

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url)
    if (request.method === 'POST' && url.pathname === '/__test/observe-completed') {
      const storeId = url.searchParams.get('storeId')
      const id = url.searchParams.get('id')
      if (storeId === null || storeId === '' || id === null || id === '')
        return new Response('storeId and id are required', { status: 400 })
      return Response.json(await env.CLIENT_DO.getByName(storeId).observeCompletedTodo({ storeId, id }))
    }
    return productionWorker.fetch(request, env, ctx)
  },
} satisfies CfTypes.ExportedHandler<Env>
import type { CfTypes } from '@livestore/sync-cf/cf-worker'
