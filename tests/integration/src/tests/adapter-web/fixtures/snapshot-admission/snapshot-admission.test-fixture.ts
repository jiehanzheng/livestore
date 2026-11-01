import { makePersistedAdapter, makeSingleTabAdapter } from '@livestore/adapter-web'
import LiveStoreSharedWorker from '@livestore/adapter-web/shared-worker?sharedworker'
import { OtelLiveDummy } from '@livestore/common'
import { type Store, createStore, StoreInternalsSymbol } from '@livestore/livestore'
import { Deferred, Effect, Exit, Stream } from '@livestore/utils/effect'

import { events, rows, schema } from './snapshot-admission.test-schema.ts'

/** Real web adapter/RPC smoke. Every worker and namespace belongs exclusively to this fixture. */
export const runAdapterAdmission = async (mode: 'shared' | 'single', namespace: string) => {
  if (/^fork-correctness-opfs-01a17145-[a-z0-9-]+$/.test(namespace) === false)
    throw new Error('Unowned fixture namespace')
  if (mode === 'shared' && typeof SharedWorker === 'undefined')
    throw new Error('SharedWorker unavailable; shared path unqualified')
  const workers = new Set<Worker>()
  const sharedPorts = new Set<MessagePort>()
  let stage = 'seed'
  const adapter = (sessionId: string) => {
    const options = {
      worker: ({ name }: { name: string }) => {
        const worker = new Worker(new URL('./snapshot-admission.test-worker.ts', import.meta.url), {
          type: 'module',
          name,
        })
        workers.add(worker)
        return worker
      },
      storage: { type: 'opfs' as const },
      clientId: 'admission-fixture',
      sessionId,
    }
    return mode === 'single'
      ? makeSingleTabAdapter(options)
      : makePersistedAdapter({
          ...options,
          sharedWorker: ({ name }) => {
            const worker = new LiveStoreSharedWorker({ name })
            sharedPorts.add(worker.port)
            return worker
          },
        })
  }
  const open = (sessionId: string) =>
    createStore({ schema, storeId: namespace, adapter: adapter(sessionId), disableDevtools: true })
  const waitDurable = (store: Store<typeof schema>, head: number) =>
    store[StoreInternalsSymbol].clientSession.leaderThread.syncState.changes.pipe(
      Stream.filter((state) => state.localHead.global === head),
      Stream.runHead,
    )
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* open('seed')
        store.commit(events.created({ id: 'pending-original' }))
        yield* waitDurable(store, 1)
      }).pipe(Effect.scoped, Effect.timeout('30 seconds'), Effect.provide(OtelLiveDummy)),
    )
    stage = 'cold-reopen'
    return await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* open('reopened')
        const initialRows = store.query(rows).map((row) => row.id)
        if (initialRows.join(',') !== 'pending-original')
          return yield* Effect.die('Cold opener exposed wrong projection')
        const leader = store[StoreInternalsSymbol].clientSession.leaderThread
        const pending = (yield* leader.syncState.get).pending
        if (pending.length !== 1 || pending[0]?.args.id !== 'pending-original')
          return yield* Effect.die('Cold opener lost pending identity')
        if (mode === 'shared') {
          stage = 'concurrent-opener'
          yield* Effect.gen(function* () {
            const second = yield* open('second-session')
            if (
              second
                .query(rows)
                .map((row) => row.id)
                .join(',') !== 'pending-original'
            )
              return yield* Effect.die('Concurrent opener exposed wrong projection')
            const refreshed = yield* Deferred.make<void>()
            const unsubscribe = store.subscribe(rows, (values) => {
              if (values.some((row) => row.id === 'after-admission') === true) Deferred.doneUnsafe(refreshed, Exit.void)
            })
            second.commit(events.created({ id: 'after-admission' }))
            yield* Deferred.await(refreshed).pipe(Effect.ensuring(Effect.sync(unsubscribe)))
            yield* waitDurable(second, 2)
          }).pipe(Effect.scoped)
        } else {
          store.commit(events.created({ id: 'after-admission' }))
          yield* waitDurable(store, 2)
        }
        const finalRows = store
          .query(rows)
          .map((row) => row.id)
          .toSorted()
        if (finalRows.join(',') !== 'after-admission,pending-original')
          return yield* Effect.die('Post-admission event lost')
        return {
          mode,
          namespace,
          directory: `livestore-${namespace}@6`,
          initialRows,
          finalRows,
          pending: (yield* leader.syncState.get).pending.map((event) => ({
            id: event.args.id,
            clientId: event.clientId,
            sessionId: event.sessionId,
          })),
          concurrentSessions: mode === 'shared' ? 2 : 1,
        }
      }).pipe(Effect.scoped, Effect.timeout('30 seconds'), Effect.provide(OtelLiveDummy)),
    )
  } catch (cause) {
    throw new Error(`Real ${mode} adapter failed at ${stage}`, { cause })
  } finally {
    for (const worker of workers) worker.terminate()
    for (const port of sharedPorts) port.close()
  }
}
