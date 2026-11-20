import { events } from './livestore/schema.ts'

// A store URL can be reopened or shared, so each creation needs a new identity.
export const createTodoEvent = (text: string) => events.todoCreated({ id: crypto.randomUUID(), text })

export const createInitialTodoEvents = () => {
  const milk = createTodoEvent('Buy milk')
  return [milk, createTodoEvent('Buy bread'), events.todoCompleted({ id: milk.args.id })]
}
