import { Events, makeSchema, Schema, State } from '@livestore/livestore'

export const tables = {
  todos: State.SQLite.table({
    name: 'todos',
    columns: {
      id: State.SQLite.text({ primaryKey: true }),
      text: State.SQLite.text(),
      completed: State.SQLite.boolean(),
      createdAt: State.SQLite.datetime(),
    },
  }),
}

export const events = {
  todoCreated: Events.synced({
    name: 'todoCreated',
    schema: Schema.Struct({
      id: Schema.String,
      text: Schema.String,
      completed: Schema.Boolean,
      createdAt: Schema.DateFromString,
    }),
  }),
  todoToggled: Events.synced({
    name: 'todoToggled',
    schema: Schema.Struct({ id: Schema.String, completed: Schema.Boolean }),
  }),
}

const materializers = State.SQLite.materializers(events, {
  todoCreated: (todo) => tables.todos.insert(todo),
  todoToggled: ({ id, completed }) => tables.todos.update({ completed }).where({ id }),
})

export const schema = makeSchema({
  projectionRevision: 'docs-patterns-effect-store-setup-v2',
  events,
  state: State.SQLite.makeState({ tables, materializers }),
})
