import { Effect } from 'effect'

import { Store } from '@livestore/livestore/effect'

import { schema } from './schema.ts'
import { adapter } from './store.ts'
import { makeTodoEvent } from './todo-input.ts'

export class TodoStore extends Store.Tag(schema, 'effect-guide-todos') {}

// Alternative application owner: provide this layer when Effect owns store lifetime.
export const TodoStoreLayer = TodoStore.layer({ adapter, batchUpdates: (run) => run() })
export const createTodo = (draft: string) => Effect.flatMap(makeTodoEvent(draft), (event) => TodoStore.commit(event))
