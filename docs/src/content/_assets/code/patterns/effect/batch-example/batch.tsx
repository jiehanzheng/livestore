import { useCallback } from 'react'

import { useStore } from '@livestore/react'

import { activeTodos$ } from '../store-setup/queries.ts'
import { events } from '../store-setup/schema.ts'
import { todoStoreOptions } from '../store-setup/store.ts'

export const CompleteAllButton = () => {
  const store = useStore(todoStoreOptions)
  const activeTodos = store.useQuery(activeTodos$)
  const completeAll = useCallback(() => {
    store.commit(...activeTodos.map(({ id }) => events.todoToggled({ id, completed: true })))
  }, [store, activeTodos])
  return (
    <button type="button" disabled={activeTodos.length === 0} onClick={completeAll}>
      Complete all
    </button>
  )
}
