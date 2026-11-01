import { describe, expect, test } from 'vitest'

import { Schema } from '@livestore/utils/effect'

import { hasJsonStringEncoding } from './has-json-string-encoding.ts'

describe('JSON string encoding representation', () => {
  test('recognizes arrays, nullable codecs, named references and suspended codecs', () => {
    const array = Schema.fromJsonString(Schema.Array(Schema.String))
    for (const schema of [
      array,
      Schema.NullOr(array),
      array.annotate({ identifier: 'NamedJsonArray' }),
      Schema.suspend(() => array),
    ]) {
      expect(hasJsonStringEncoding(schema.ast)).toBe(true)
    }
  })

  test('does not treat plain strings, dates, media annotations or nested JSON strings as a JSON column', () => {
    for (const schema of [
      Schema.String,
      Schema.DateFromString,
      Schema.String.annotate({ contentMediaType: 'application/json' }),
      Schema.String.annotate({ contentMediaType: 'text/plain' }),
      Schema.Array(Schema.fromJsonString(Schema.String)),
    ]) {
      expect(hasJsonStringEncoding(schema.ast)).toBe(false)
    }
  })
})
