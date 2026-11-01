import React from 'react'

import type { LiveStoreSchema } from '@livestore/common/schema'
import type { RegistryStoreOptions, Store, SyncStatus } from '@livestore/livestore'
import type { Schema } from '@livestore/utils/effect'

import { useStoreRegistry } from './StoreRegistryContext.tsx'
import { useClientDocument } from './useClientDocument.ts'
import { useQuery } from './useQuery.ts'
import { useSyncStatus } from './useSyncStatus.ts'

// Weak identity keys follow actual store lifetimes, without keeping disposed cache entries alive.
const observedLoads = new WeakSet<Promise<unknown>>()
const resolvedLoads = new WeakMap<object, Promise<unknown>>()

/**
 * Returns a store instance augmented with hooks (`store.useQuery()` and `store.useClientDocument()`) for reactive queries.
 *
 * @example
 * ```tsx
 * function Issue() {
 *   // Suspends until loaded or returns immediately if already loaded
 *   const issueStore = useStore(issueStoreOptions('abc123'))
 *   const [issue] = issueStore.useQuery(queryDb(tables.issue.select()))
 *
 *   const toggleStatus = () =>
 *     issueStore.commit(
 *       issueEvents.issueStatusChanged({
 *         id: issue.id,
 *         status: issue.status === 'done' ? 'todo' : 'done',
 *       }),
 *     )
 *
 *   const preloadParentIssue = (issueId: string) =>
 *     storeRegistry.preload({
 *       ...issueStoreOptions(issueId),
 *       unusedCacheTime: 10_000,
 *     })
 *
 *   return (
 *     <>
 *       <h2>{issue.title}</h2>
 *       <button onClick={() => toggleStatus()}>Toggle Status</button>
 *       <button onMouseEnter={() => preloadParentIssue(issue.parentIssueId)}>Open Parent Issue</button>
 *     </>
 *   )
 * }
 * ```
 *
 * @remarks
 * - Suspends until the store is loaded.
 * - Store is cached by its `storeId` in the `StoreRegistry`. Multiple calls with the same `storeId` return the same store instance.
 * - Store is cached as long as it's being used, and after `unusedCacheTime` expires (default `60_000` ms in browser, `Infinity` in non-browser)
 * - Default store options can be configured in `StoreRegistry` constructor.
 * - Store options are only applied when the store is loaded. Subsequent calls with different options will not affect the store if it's already loaded and cached in the registry.
 *
 * @typeParam TSchema - The schema type for the store
 * @returns The loaded store instance augmented with React hooks
 * @throws unknown - store loading error or if called outside `<StoreRegistryProvider>`
 */
export const useStore = <
  TSchema extends LiveStoreSchema,
  TContext = {},
  TSyncPayloadSchema extends Schema.Codec<Schema.Json, Schema.Json> = typeof Schema.Json,
>(
  options: RegistryStoreOptions<TSchema, TContext, TSyncPayloadSchema>,
): Store<TSchema, TContext> & ReactApi => {
  const storeRegistry = useStoreRegistry()

  // Always consult the registry: cached options or storeId promises can outlive an evicted Store.
  const storeOrPromise = storeRegistry.getOrLoadPromise(options)
  let store: Store<TSchema, TContext>
  if (storeOrPromise instanceof Promise) {
    if (observedLoads.has(storeOrPromise) === false) {
      observedLoads.add(storeOrPromise)
      // Register before React.use subscribes. A normal promise-driven retry then sees the
      // identity link and completes the same promise read, as React 19.3 requires.
      void storeOrPromise.then(
        (loaded) => {
          resolvedLoads.set(loaded, storeOrPromise)
        },
        // The original rejection still reaches React; this observer must not create another unhandled rejection.
        () => undefined,
      )
    }
    store = React.use(storeOrPromise)
  } else {
    const observedLoad = resolvedLoads.get(storeOrPromise)
    if (observedLoad !== undefined) React.use(observedLoad)
    // Stores first encountered warm need no Promise. Previously suspended stores keep reading
    // their original Promise; the registry's current Store remains the source of truth.
    store = storeOrPromise
  }

  // Retain only from a committed render's effect; abandoned suspended attempts must not retain.
  // Very short unusedCacheTime can expire between render and this effect (#916); zero TTL remains unqualified.
  React.useEffect(() => storeRegistry.retain(options), [storeRegistry, options])

  return withReactApi(store)
}

/**
 * React-specific methods added to the Store when used via React hooks.
 *
 * These methods are attached by `withReactApi()` and `useStore()`, allowing you
 * to call `store.useQuery()` and `store.useClientDocument()` directly on the
 * Store instance.
 */
export type ReactApi = {
  /** Hook version of query subscription—re-renders component when query result changes */
  useQuery: typeof useQuery
  /** Hook for reading and writing client-document tables with React state semantics */
  useClientDocument: typeof useClientDocument
  /** Hook for subscribing to sync status changes */
  useSyncStatus: () => SyncStatus
}

/**
 * Augments a Store instance with React-specific methods (`useQuery`, `useClientDocument`).
 *
 * This is called automatically by `useStore()`. You typically don't need to call it
 * directly unless you're building custom integrations.
 *
 * @internal
 */
export const withReactApi = <TSchema extends LiveStoreSchema, TContext = {}>(
  store: Store<TSchema, TContext>,
): Store<TSchema, TContext> & ReactApi => {
  // @ts-expect-error TODO properly implement this
  store.useQuery = (queryable) => useQuery(queryable, { store })

  // @ts-expect-error TODO properly implement this
  store.useClientDocument = (table, idOrOptions, options) => useClientDocument(table, idOrOptions, options, { store })

  // @ts-expect-error TODO properly implement this
  store.useSyncStatus = () => useSyncStatus({ store })

  return store as Store<TSchema, TContext> & ReactApi
}
