import { type ChangeEvent, useCallback } from 'react'

import { useStore } from '@livestore/react'

import { todos$ } from './queries.ts'
import { events } from './schema.ts'
import { todoStoreOptions } from './store.ts'

export const TodoList = () => {
  const store = useStore(todoStoreOptions)
  const todos = store.useQuery(todos$)
  const toggleTodo = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const todo = todos.find(({ id }) => id === event.currentTarget.dataset.todoId)
      if (todo !== undefined) store.commit(events.todoToggled({ id: todo.id, completed: !todo.completed }))
    },
    [store, todos],
  )
  return (
    <ul>
      {todos.map((todo) => (
        <li key={todo.id}>
          <label>
            <input type="checkbox" checked={todo.completed} data-todo-id={todo.id} onChange={toggleTodo} />
            {todo.text}
          </label>
        </li>
      ))}
    </ul>
  )
}
