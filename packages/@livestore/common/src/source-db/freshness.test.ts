import { Effect } from 'effect'
import { describe, expect, test } from 'vitest'

import {
  bindFreshSource,
  consumeFreshSource,
  invalidateFreshSource,
  type FreshSource,
  type OwnedCreationBoundary,
} from './freshness.ts'
import { makeSourceDb, type AsyncSourceDriver } from './role.ts'

const source = () =>
  Effect.runPromise(
    makeSourceDb({
      execute: async () => {},
      select: async <Row extends object>() => [] as ReadonlyArray<Row>,
      export: async () => new Uint8Array(),
      import: async () => {},
      close: async () => {},
    } satisfies AsyncSourceDriver),
  )

const boundary = (isHeld = () => true): OwnedCreationBoundary => ({
  storageName: 'owned-memory-source',
  kind: 'new-memory-connection',
  isHeld,
})

describe('owned SOURCE freshness capability', () => {
  test('is opaque and consumable once by its exact SOURCE', async () => {
    const db = await source(),
      fresh = bindFreshSource(db, boundary())
    expect(Object.isFrozen(fresh)).toBe(true)
    await Effect.runPromise(consumeFreshSource(db, fresh))
    await expect(Effect.runPromise(consumeFreshSource(db, fresh))).rejects.toMatchObject({ operation: 'initialize' })
    await Effect.runPromise(db.close)
  })

  test('a spread clone does not grant authority or spend the original receipt', async () => {
    const db = await source(),
      fresh = bindFreshSource(db, boundary())
    await expect(Effect.runPromise(consumeFreshSource(db, { ...fresh } as FreshSource))).rejects.toMatchObject({
      operation: 'initialize',
    })
    await Effect.runPromise(consumeFreshSource(db, fresh))
    await Effect.runPromise(db.close)
  })

  test('a foreign SOURCE cannot transfer or recycle the receipt', async () => {
    const original = await source(),
      other = await source(),
      fresh = bindFreshSource(original, boundary())
    await expect(Effect.runPromise(consumeFreshSource(other, fresh))).rejects.toMatchObject({ operation: 'initialize' })
    await expect(Effect.runPromise(consumeFreshSource(original, fresh))).rejects.toMatchObject({
      operation: 'initialize',
    })
    expect(() => bindFreshSource(original, boundary())).toThrow('already issued')
    await Effect.runPromise(original.close)
    await Effect.runPromise(other.close)
  })

  test('loss of the creating authority refuses initialization and spends the receipt', async () => {
    let held = true
    const db = await source(),
      fresh = bindFreshSource(
        db,
        boundary(() => held),
      )
    held = false
    await expect(Effect.runPromise(consumeFreshSource(db, fresh))).rejects.toMatchObject({ operation: 'initialize' })
    held = true
    await expect(Effect.runPromise(consumeFreshSource(db, fresh))).rejects.toMatchObject({ operation: 'initialize' })
    await Effect.runPromise(db.close)
  })

  test('explicit invalidation revokes the receipt without allowing a second issuance', async () => {
    const db = await source(),
      fresh = bindFreshSource(db, boundary())
    invalidateFreshSource(db)
    invalidateFreshSource(db)
    await expect(Effect.runPromise(consumeFreshSource(db, fresh))).rejects.toMatchObject({ operation: 'initialize' })
    expect(() => bindFreshSource(db, boundary())).toThrow('already issued')
    await Effect.runPromise(db.close)
  })

  test('issuance requires both a storage name and current physical authority', async () => {
    const db = await source()
    expect(() => bindFreshSource(db, { ...boundary(), storageName: '' })).toThrow()
    expect(() =>
      bindFreshSource(
        db,
        boundary(() => false),
      ),
    ).toThrow()
    const fresh = bindFreshSource(db, boundary())
    await Effect.runPromise(consumeFreshSource(db, fresh))
    await Effect.runPromise(db.close)
  })

  test('retains the captured authority guard rather than a caller-mutable boundary object', async () => {
    const db = await source()
    let held = true
    const input = { storageName: 'owned-memory-source', kind: 'new-memory-connection' as const, isHeld: () => held }
    const fresh = bindFreshSource(db, input)
    input.isHeld = () => true
    input.storageName = 'another-source'
    held = false
    await expect(Effect.runPromise(consumeFreshSource(db, fresh))).rejects.toMatchObject({ operation: 'initialize' })
    await Effect.runPromise(db.close)
  })
})
