import { computed, inject, onScopeDispose, type InjectionKey, type ShallowRef, shallowRef } from 'vue'

import { type Queryable, type Store, SessionIdSymbol } from '@livestore/livestore'

import type { schema } from './schema.ts'
import { tables } from './schema.ts'

export const storeKey: InjectionKey<ShallowRef<Store<typeof schema> | undefined>> = Symbol('LiveStore')

export const useStore = (): Store<typeof schema> => {
  const store = inject(storeKey)?.value
  if (store === undefined) throw new Error('Use LiveStore inside the loaded provider.')
  return store
}

export const useQuery = <A>(query: Queryable<A>): ShallowRef<A> => {
  const store = useStore()
  const value = shallowRef(store.query(query))
  const unsubscribe = store.subscribe(query, (next) => {
    value.value = next
  })
  onScopeDispose(unsubscribe)
  return value
}

export const useUiState = () => {
  const store = useStore()
  const state = useQuery(tables.uiState.get(SessionIdSymbol))
  return {
    newTodoText: computed({
      get: () => state.value.newTodoText,
      set: (newTodoText: string) => store.commit(tables.uiState.set({ newTodoText })),
    }),
    filter: computed({
      get: () => state.value.filter,
      set: (filter: typeof tables.uiState.Value.filter) => store.commit(tables.uiState.set({ filter })),
    }),
  }
}
