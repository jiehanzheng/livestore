import { expect, test } from 'vitest'

import { assertSingleBoundStatement } from './single-statement.ts'

test.each([
  'INSERT INTO t VALUES (?)',
  '; /* empty statements */ ; INSERT INTO t VALUES (?);',
  'INSERT INTO t VALUES (?); -- terminal comment ; SELECT 2',
  'INSERT INTO t VALUES (?); /* terminal comment ; SELECT 2 */ \n',
  'INSERT INTO t VALUES (?); /* one */ -- two\n /* three */ ;',
  "INSERT INTO t VALUES ('quoted;value', ?);",
  'INSERT INTO "table;name" VALUES (?);',
  'INSERT INTO `table;name` VALUES (?);',
  'INSERT INTO [table;name] VALUES (?);',
  "INSERT INTO t VALUES ('it''s;still one', ?);",
  'INSERT INTO "double"";quote" VALUES (?);',
  'INSERT INTO `back``;tick` VALUES (?);',
  "INSERT INTO t VALUES ('--not a comment; /* neither */', ?);",
  'INSERT /* ; ignored */ INTO t VALUES (?) -- ; ignored\n;',
])('accepts one lexical statement: %s', (sql) => {
  expect(() => assertSingleBoundStatement(sql)).not.toThrow()
})

test.each([
  'INSERT INTO t VALUES (?); INSERT INTO t VALUES (2)',
  'INSERT INTO t VALUES (?);/**/DELETE FROM t',
  'INSERT INTO t VALUES (?);-- comment\nUPDATE t SET x=2',
  'INSERT INTO t VALUES (?);; SELECT 2',
  "INSERT INTO t VALUES ('it''s;one', ?); SELECT 2",
  'INSERT INTO "table;name" VALUES (?); SELECT 2',
  'INSERT INTO [table;name] VALUES (?); SELECT 2',
  'INSERT INTO `table;name` VALUES (?); SELECT 2',
  "INSERT INTO t VALUES ('backslash\\'); SELECT 2",
])('refuses a real SQL tail before native mutation: %s', (sql) => {
  expect(() => assertSingleBoundStatement(sql)).toThrow('single SQL statement')
})

test.each([
  "INSERT INTO t VALUES ('unterminated; SELECT 2, ?)",
  'INSERT INTO "unterminated; SELECT 2 VALUES (?)',
  'INSERT INTO `unterminated; SELECT 2 VALUES (?)',
  'INSERT INTO [unterminated; SELECT 2 VALUES (?)',
  'INSERT INTO t VALUES (?) /* unterminated ; SELECT 2',
  'THIS IS NOT VALID SQL (?)',
])('leaves malformed SQL to SQLite grammar validation: %s', (sql) => {
  expect(() => assertSingleBoundStatement(sql)).not.toThrow()
})
