import { expect, test } from 'vitest'

import { Effect } from '@livestore/utils/effect'

import { digest, encode, ownJson } from './codec.ts'

test('maintenance SHA256 remains identical without WebCrypto, including legal JSON object keys', async () => {
  const value = {
    cohort: ['v1', 42, null],
    nested: { constructor: 'event field', toString: 'event field', valueOf: ['kept'] },
  }
  const nativeHash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(encode(value)))
  const expected = [...new Uint8Array(nativeHash)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto')
  try {
    Object.defineProperty(globalThis, 'crypto', { configurable: true, value: undefined })
    expect(await Effect.runPromise(digest(value))).toBe(expected)
    expect(await Effect.runPromise(digest({ nested: value.nested, cohort: value.cohort }))).toBe(expected)
  } finally {
    if (descriptor === undefined) Reflect.deleteProperty(globalThis, 'crypto')
    else Object.defineProperty(globalThis, 'crypto', descriptor)
  }
})

test('owned evidence cannot be mutated through the caller or emitted receipt aliases', () => {
  const input = { context: { revision: 1 }, values: ['kept'] }
  const owned = ownJson(input)
  input.context.revision = 2
  expect(owned.context.revision).toBe(1)
  expect(Reflect.set(owned.context, 'revision', 3)).toBe(false)
  expect(Object.isFrozen(owned.values)).toBe(true)
})
