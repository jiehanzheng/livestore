import { queryDb } from '@livestore/livestore'

import { tables } from './schema.ts'

export const todos$ = queryDb(tables.todos.orderBy('createdAt', 'asc'), { label: 'effect-guide:todos' })
export const activeTodos$ = queryDb(tables.todos.where({ completed: false }), { label: 'effect-guide:activeTodos' })
