import { beforeEach, expect, test, vi } from 'vitest'

import { Effect } from '@livestore/utils/effect'

import { allocateExpoSourceReceipt, consumeExpoSourceAllocation, expoSourceStorageName } from './source-owner.ts'
import { fakeDatabase } from './sqlite-test-support.ts'

const native = vi.hoisted(() => ({
  openDatabaseSync: vi.fn(),
  deleteDatabaseSync: vi.fn(),
}))
vi.mock('expo-sqlite', () => native)
import { createSqliteFactory } from './sqlite.ts'

beforeEach(() => vi.resetAllMocks())
const name = expoSourceStorageName('/private/test', 'source.db')
const source = (allocation = allocateExpoSourceReceipt(name)) => ({
  _tag: 'file' as const,
  databaseName: 'source.db',
  directory: '/private/test',
  sourceOwner: 'exclusive' as const,
  sourceAllocation: allocation,
})
const physical = () => ({
  ...fakeDatabase(),
  execSync: vi.fn((_sql: string) => {}),
  getFirstSync: vi.fn(() => ({ locking_mode: 'exclusive' })),
})

test('allocation is bound to exact source path and burned on foreign use or replay', () => {
  const wrong = allocateExpoSourceReceipt(name)
  expect(() => consumeExpoSourceAllocation(wrong, `${name}-other`)).toThrow('foreign')
  expect(() => consumeExpoSourceAllocation(wrong, name)).toThrow('spent')
  const allocation = allocateExpoSourceReceipt(name)
  consumeExpoSourceAllocation(allocation, name)
  expect(() => consumeExpoSourceAllocation(allocation, name)).toThrow('spent')
})

test('native owner acquires the actual exclusive transaction before exposing creation and keeps it until close', () => {
  const db = physical()
  native.openDatabaseSync.mockReturnValue(db)
  const factory = createSqliteFactory()
  const owned = Effect.runSync(factory.makeSqliteDb(source()))
  expect(db.execSync.mock.calls).toEqual([['PRAGMA locking_mode=EXCLUSIVE'], ['BEGIN EXCLUSIVE; COMMIT']])
  expect(db.getFirstSync).toHaveBeenCalledWith('PRAGMA locking_mode')
  expect(owned.metadata.sourceCreation?.kind).toBe('exclusive-expo-source-namespace')
  expect(owned.metadata.sourceCreation?.isHeld()).toBe(true)
  expect(() => owned.destroy()).toThrow()
  expect(native.deleteDatabaseSync).not.toHaveBeenCalled()
  owned.close()
  expect(owned.metadata.sourceCreation?.isHeld()).toBe(false)
  expect(db.closeSync).toHaveBeenCalledOnce()
  factory.assertClosed()
})

test('retained source acquires physical ownership but has no fresh creation receipt', () => {
  const db = physical()
  native.openDatabaseSync.mockReturnValue(db)
  const factory = createSqliteFactory()
  const owned = Effect.runSync(
    factory.makeSqliteDb({
      _tag: 'file',
      databaseName: 'source.db',
      directory: '/private/test',
      sourceOwner: 'exclusive',
    }),
  )
  expect(owned.metadata.sourceCreation).toBeUndefined()
  expect(owned.metadata.sourceLease?.isHeld()).toBe(true)
  owned.close()
  factory.assertClosed()
})

test('lock acquisition failure closes the known connection and does not recycle allocation', () => {
  const db = physical()
  db.execSync.mockImplementation((sql) => {
    if (sql === 'BEGIN EXCLUSIVE; COMMIT') throw new Error('busy')
  })
  native.openDatabaseSync.mockReturnValue(db)
  const factory = createSqliteFactory(),
    input = source()
  expect(Effect.runSync(Effect.result(factory.makeSqliteDb(input)))).toMatchObject({
    _tag: 'Failure',
    failure: { note: 'Native SQLite acquisition failed.', cause: new Error('busy') },
  })
  expect(db.closeSync).toHaveBeenCalledOnce()
  expect(Effect.runSync(Effect.result(factory.makeSqliteDb(input)))).toMatchObject({
    _tag: 'Failure',
    failure: { cause: expect.any(Error) },
  })
  expect(native.openDatabaseSync).toHaveBeenCalledTimes(1)
  factory.assertClosed()
})

test('failed close retains physical owner and closure evidence remains unconfirmed', () => {
  const db = physical()
  db.closeSync.mockImplementation(() => {
    throw new Error('uncertain native close')
  })
  native.openDatabaseSync.mockReturnValue(db)
  const factory = createSqliteFactory(),
    owned = Effect.runSync(factory.makeSqliteDb(source()))
  expect(() => owned.close()).toThrow()
  expect(owned.metadata.sourceCreation?.isHeld()).toBe(true)
  expect(() => owned.close()).toThrow()
  expect(db.closeSync).toHaveBeenCalledOnce()
  expect(() => factory.assertClosed()).toThrow('closure is unconfirmed')
})
