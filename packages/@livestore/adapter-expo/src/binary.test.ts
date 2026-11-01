import { describe, expect, test } from 'vitest'

import { prepareBindValues } from '@livestore/common'

import { nativeBindings, normalizedRows, ownedBytes } from './binary.ts'

describe('native byte boundaries', () => {
  test('copies only the visible bytes, including zero-length offset views', () => {
    const source = new Uint8Array([90, 1, 2, 91])
    const bytes = ownedBytes(source.subarray(1, 3))
    expect([...bytes]).toEqual([1, 2])
    expect(bytes.byteOffset).toBe(0)
    expect(bytes.buffer.byteLength).toBe(2)
    source[1] = 44
    expect([...bytes]).toEqual([1, 2])
    expect(ownedBytes(source.subarray(2, 2)).buffer.byteLength).toBe(0)
  })
  test('binds positional and named blob values as exact owned ArrayBuffers', () => {
    const source = new Uint8Array([90, 1, 2, 91])
    const positional = nativeBindings(prepareBindValues([source.subarray(1, 3), null, 'text', 4], 'SELECT ?, ?, ?, ?'))
    const named = nativeBindings(prepareBindValues({ blob: source.subarray(2, 2), number: 7 }, 'SELECT $blob, $number'))
    expect(positional).toEqual([new Uint8Array([1, 2]).buffer, null, 'text', 4])
    expect(named).toEqual({ $blob: new ArrayBuffer(0), $number: 7 })
    expect((positional as unknown[])[0]).toBeInstanceOf(ArrayBuffer)
    source[1] = 55
    expect(new Uint8Array((positional as ArrayBuffer[])[0]!)).toEqual(new Uint8Array([1, 2]))
    expect(nativeBindings(undefined)).toEqual({})
  })
  test('normalizes both native row byte representations without borrowing storage', () => {
    const array = new Uint8Array([90, 1, 2, 91])
    const buffer = new Uint8Array([3, 4]).buffer
    const input = { a: array.subarray(1, 3), b: buffer, empty: new ArrayBuffer(0), text: 'unchanged', n: null }
    const [row] = normalizedRows<typeof input>([input])
    expect(row).toEqual({
      a: new Uint8Array([1, 2]),
      b: new Uint8Array([3, 4]),
      empty: new Uint8Array(),
      text: 'unchanged',
      n: null,
    })
    expect(row).not.toBe(input)
    array[1] = 55
    new Uint8Array(buffer)[0] = 66
    expect(row!.a).toEqual(new Uint8Array([1, 2]))
    expect(row!.b).toEqual(new Uint8Array([3, 4]))
  })
})
