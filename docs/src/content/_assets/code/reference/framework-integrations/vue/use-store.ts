import { useStore } from '../../../getting-started/vue/livestore/store.ts'
import { events } from './schema.ts'

export const useCreateTodo = () => {
  const store = useStore()

  return () => store.commit(events.todoCreated({ id: crypto.randomUUID(), text: 'Eat broccoli' }))
}
