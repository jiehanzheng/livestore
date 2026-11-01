import { makeSchema, State } from '@livestore/livestore'

export const schema = makeSchema({
  projectionRevision: 'test-fixture-v1',
  events: {},
  state: State.SQLite.makeState({
    tables: {},
    materializers: {},
  }),
})
