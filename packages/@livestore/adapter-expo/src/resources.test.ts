import { expect, test, vi } from 'vitest'

import { createResourceLedger, withCleanup } from './resources.ts'

test('ledger requires every acquired handle to close, including scratch handles', () => {
  const ledger = createResourceLedger(),
    main = {},
    scratch = {}
  ledger.acquire(main)
  ledger.acquire(scratch)
  ledger.release(main)
  expect(() => ledger.assertClosed()).toThrow('Native storage closure is unconfirmed')
  ledger.release(scratch)
  expect(() => ledger.assertClosed()).not.toThrow()
})
test('a recorded close failure remains poisonous after every handle releases', () => {
  const ledger = createResourceLedger(),
    handle = {},
    failure = new Error('native close')
  ledger.acquire(handle)
  ledger.failed(failure)
  ledger.release(handle)
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      ledger.assertClosed()
      throw new Error('unexpected success')
    } catch (cause) {
      expect(cause).toBeInstanceOf(AggregateError)
      expect((cause as AggregateError).errors).toContain(failure)
    }
  }
})
test('cleanup runs exactly once on successful return and failed operation', () => {
  const cleanup = vi.fn(),
    failure = new Error('operation')
  expect(withCleanup(() => 7, cleanup)).toBe(7)
  expect(() =>
    withCleanup(() => {
      throw failure
    }, cleanup),
  ).toThrow(failure)
  expect(cleanup).toHaveBeenCalledTimes(2)
})
test('operation and cleanup errors both survive, including thrown undefined', () => {
  const cleanupFailure = new Error('cleanup')
  let caught: unknown
  try {
    withCleanup(
      () => {
        throw undefined
      },
      () => {
        throw cleanupFailure
      },
    )
  } catch (cause) {
    caught = cause
  }
  expect(caught).toBeInstanceOf(AggregateError)
  expect((caught as AggregateError).errors).toEqual([undefined, cleanupFailure])
})
test('cleanup failure prevents a successful return', () => {
  const failure = new Error('cleanup')
  expect(() =>
    withCleanup(
      () => 7,
      () => {
        throw failure
      },
    ),
  ).toThrow(failure)
})
