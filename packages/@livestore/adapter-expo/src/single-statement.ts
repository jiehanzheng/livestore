/**
 * Expo prepareSync ignores SQL after its first statement. Bound execute must
 * refuse that tail rather than report success after applying only part of it.
 * This checks lexical boundaries only; SQLite still validates SQL grammar.
 */
export const assertSingleBoundStatement = function (sql: string): void {
  let started = false
  let terminated = false
  let index = 0
  while (index < sql.length) {
    const char = sql[index]!
    if (/[\t\n\f\r ]/.test(char) === true) {
      index++
      continue
    }
    if (char === '-' && sql[index + 1] === '-') {
      index += 2
      while (index < sql.length && sql[index] !== '\n') index++
      continue
    }
    if (char === '/' && sql[index + 1] === '*') {
      const end = sql.indexOf('*/', index + 2)
      if (end === -1) return
      index = end + 2
      continue
    }
    if (char === ';') {
      if (started === true) terminated = true
      index++
      continue
    }
    if (terminated === true) throw new Error('Bound native execute requires a single SQL statement.')
    started = true
    if (char === "'" || char === '"' || char === '`' || char === '[') {
      const endQuote = char === '[' ? ']' : char
      index++
      while (index < sql.length) {
        if (sql[index] !== endQuote) {
          index++
          continue
        }
        // SQLite escapes string/identifier quotes by doubling them. Bracket
        // identifiers instead end at their first closing bracket.
        if (char !== '[' && sql[index + 1] === endQuote) {
          index += 2
          continue
        }
        index++
        break
      }
      continue
    }
    index++
  }
}
