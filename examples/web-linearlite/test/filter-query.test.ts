import { DatabaseSync, type SQLInputValue } from 'node:sqlite'

import { expect, it } from 'vitest'

import { tables } from '../src/livestore/schema/index.ts'
import { filterStateToWhere } from '../src/livestore/utils.tsx'

it.each([
  { query: null, expected: [1, 2] },
  { query: '', expected: [1, 2] },
  { query: 'maintained', expected: [1] },
  { query: 'null', expected: [2] },
])('selects visible issue IDs for search $query', ({ query, expected }) => {
  const database = new DatabaseSync(':memory:')
  try {
    database.exec(
      'CREATE TABLE issue (id INTEGER PRIMARY KEY, title TEXT, deleted INTEGER, status INTEGER, priority INTEGER)',
    )
    database.exec(
      "INSERT INTO issue VALUES (1, 'Final maintained issue', NULL, 0, 0), (2, 'A literal null title', NULL, 0, 0)",
    )
    const sql = tables.issue
      .select('id')
      .where({
        ...filterStateToWhere({ query, status: null, priority: null, orderBy: 'created', orderDirection: 'desc' }),
        deleted: null,
      })
      .orderBy('id', 'asc')
      .asSql()
    const rows = database.prepare(sql.query).all(...((sql.bindValues ?? []) as SQLInputValue[]))
    expect(rows.map((row) => row.id)).toEqual(expected)
  } finally {
    database.close()
  }
})
