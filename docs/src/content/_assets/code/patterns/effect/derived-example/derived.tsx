import { useStore } from '@livestore/react'

import { todos$ } from '../store-setup/queries.ts'
import { todoStoreOptions } from '../store-setup/store.ts'

export const TodoStats = () => {
  const store = useStore(todoStoreOptions)
  const todos = store.useQuery(todos$)
  const completed = todos.filter((todo) => todo.completed).length
  return (
    <p>
      {todos.length} total, {completed} completed, {todos.length - completed} pending
    </p>
  )
}
