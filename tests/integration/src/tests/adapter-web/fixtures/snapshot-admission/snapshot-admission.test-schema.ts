import { Events, makeSchema, State } from '@livestore/common/schema'
import { Schema } from '@livestore/utils/effect'

export const rows = State.SQLite.table({
  name: 'admission_rows',
  columns: { id: State.SQLite.text({ primaryKey: true }) },
})
export const events = {
  created: Events.synced({ name: 'admission.created', schema: Schema.Struct({ id: Schema.String }) }),
}
export const schema = makeSchema({
  projectionRevision: 'snapshot-admission-v1',
  events,
  state: State.SQLite.makeState({
    tables: { rows },
    materializers: State.SQLite.materializers(events, { 'admission.created': ({ id }) => rows.insert({ id }) }),
  }),
})
