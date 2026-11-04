import { Effect } from '@livestore/utils/effect'

import { makeColumnSpec } from '../schema/state/sqlite/column-spec.ts'
import { eventlogSystemTables } from '../schema/state/sqlite/system-tables/eventlog-tables.ts'
import type { SourceReader, SourceTransaction } from './role.ts'

/** SOURCE uses the existing eventlog AST; its format is not an adapter-specific schema. */
export const sourceSchemaStatements = (): ReadonlyArray<string> =>
  eventlogSystemTables.flatMap(({ sqliteDef: { ast } }) => [
    `CREATE TABLE "${ast.name}" (${makeColumnSpec(ast)}) STRICT`,
    ...ast.indexes.map(
      (index) =>
        `CREATE ${index.unique === true ? 'UNIQUE ' : ''}INDEX "${index.name}" ON "${ast.name}" (${index.columns.map((column) => `"${column}"`).join(', ')})`,
    ),
  ])

export const listSourceTables = (source: SourceReader) =>
  source
    .select<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
    .pipe(Effect.map((rows) => new Set(rows.map((row) => row.name))))

/** Only the freshness-authorized initializer may call this inside its source transaction. */
export const createSourceSchema = (transaction: SourceTransaction) =>
  Effect.gen(function* () {
    for (const statement of sourceSchemaStatements()) yield* transaction.execute(statement)
  })
