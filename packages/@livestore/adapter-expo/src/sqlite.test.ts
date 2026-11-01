import { Effect } from 'effect'
import { beforeEach, expect, test, vi } from 'vitest'

import { prepareBindValues } from '@livestore/common'

import { fakeDatabase, fakeSession, fakeStatement, snapshotBytes } from './sqlite-test-support.ts'

const native = vi.hoisted(() => ({
  openDatabaseSync: vi.fn(),
  deserializeDatabaseSync: vi.fn(),
  backupDatabaseSync: vi.fn(),
  deleteDatabaseSync: vi.fn(),
}))
vi.mock('expo-sqlite', () => native)
import { createSqliteFactory } from './sqlite.ts'

beforeEach(() => {
  vi.resetAllMocks()
  native.openDatabaseSync.mockImplementation(() => fakeDatabase())
  native.deserializeDatabaseSync.mockImplementation(() => fakeDatabase())
})
const opening = function () {
  const factory = createSqliteFactory()
  const db = Effect.runSync(factory.makeSqliteDb({ _tag: 'in-memory' }))
  const physical = native.openDatabaseSync.mock.results.at(-1)!.value as ReturnType<typeof fakeDatabase>
  return { factory, db, physical }
}

test('object import borrows source and closes only its own temporary copy', () => {
  const { factory, db, physical } = opening()
  const source = Effect.runSync(factory.makeSqliteDb({ _tag: 'in-memory' }))
  const sourcePhysical = native.openDatabaseSync.mock.results.at(-1)!.value as ReturnType<typeof fakeDatabase>
  const sourceBytes = new Uint8Array([90, ...snapshotBytes(), 91])
  sourcePhysical.serializeSync.mockReturnValue(sourceBytes.subarray(1, -1))
  db.import(source)
  const temporary = native.deserializeDatabaseSync.mock.results[0]!.value as ReturnType<typeof fakeDatabase>
  expect(native.deserializeDatabaseSync).toHaveBeenCalledWith(snapshotBytes(), { useNewConnection: true })
  expect(native.backupDatabaseSync).toHaveBeenCalledWith({ sourceDatabase: temporary, destDatabase: physical })
  expect(temporary.closeSync).toHaveBeenCalledOnce()
  expect(sourcePhysical.closeSync).not.toHaveBeenCalled()
  expect(source.export()).toEqual(snapshotBytes())
  db.close()
  expect(() => factory.assertClosed()).toThrow()
  source.close()
  factory.assertClosed()
})

for (const closeFails of [false, true])
  test(`byte import cleans up on backup failure; temporary close fails=${closeFails}`, () => {
    const { factory, db, physical } = opening(),
      temporary = fakeDatabase()
    native.deserializeDatabaseSync.mockReturnValue(temporary)
    native.backupDatabaseSync.mockImplementation(() => {
      throw new Error('backup')
    })
    if (closeFails === true)
      temporary.closeSync.mockImplementation(() => {
        throw new Error('temporary close')
      })
    expect(() => db.import(new Uint8Array([1]))).toThrow()
    expect(temporary.closeSync).toHaveBeenCalledOnce()
    db.close()
    expect(physical.closeSync).toHaveBeenCalledOnce()
    if (closeFails === true) expect(() => factory.assertClosed()).toThrow()
    else factory.assertClosed()
  })

test('temporary close failure also rejects an otherwise successful import', () => {
  const { factory, db } = opening(),
    temporary = fakeDatabase()
  temporary.closeSync.mockImplementation(() => {
    throw new Error('close')
  })
  native.deserializeDatabaseSync.mockReturnValue(temporary)
  expect(() => db.import(new Uint8Array())).toThrow()
  db.close()
  expect(() => factory.assertClosed()).toThrow()
})

test('unbound multi-statement SQL executes the entire script; bound calls notify row changes', () => {
  const { db, physical, factory } = opening()
  const script = 'PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;'
  db.execute(script)
  expect(physical.execSync).toHaveBeenCalledWith(script)
  expect(physical.prepareSync).not.toHaveBeenCalled()
  const changed = vi.fn()
  db.execute('UPDATE t SET blob=?', prepareBindValues([new Uint8Array([2])], 'UPDATE t SET blob=?'), {
    onRowsChanged: changed,
  })
  expect(changed).toHaveBeenCalledWith(3)
  expect(physical.statements[0]!.executeSync).toHaveBeenCalledWith([new Uint8Array([2]).buffer])
  expect(physical.statements[0]!.result.resetSync).toHaveBeenCalledOnce()
  expect(physical.statements[0]!.finalizeSync).toHaveBeenCalledOnce()
  db.close()
  factory.assertClosed()
})

for (const mode of ['execute', 'read', 'reset'] as const)
  test(`direct statement ${mode} failure still finalizes`, () => {
    const { db, physical, factory } = opening(),
      statement = fakeStatement()
    physical.prepareSync.mockReturnValue(statement)
    if (mode === 'execute')
      statement.executeSync.mockImplementation(() => {
        throw new Error(mode)
      })
    if (mode === 'read')
      statement.result.getAllSync.mockImplementation(() => {
        throw new Error(mode)
      })
    if (mode === 'reset')
      statement.result.resetSync.mockImplementation(() => {
        throw new Error(mode)
      })
    expect(() => db.select('SELECT blob FROM t', prepareBindValues([], 'SELECT blob FROM t'))).toThrow()
    expect(statement.finalizeSync).toHaveBeenCalledOnce()
    expect(statement.result.resetSync).toHaveBeenCalledTimes(mode === 'execute' ? 0 : 1)
    db.close()
    factory.assertClosed()
  })

test('prepare failure leaves no statement; callback failure still finalizes successful execute', () => {
  const { db, physical, factory } = opening()
  physical.prepareSync.mockImplementationOnce(() => {
    throw new Error('prepare')
  })
  expect(() => db.select('SELECT 1')).toThrow()
  const changed = vi.fn(() => {
    throw new Error('observer')
  })
  expect(() =>
    db.execute('UPDATE t SET x=?', prepareBindValues([1], 'UPDATE t SET x=?'), { onRowsChanged: changed }),
  ).toThrow('observer')
  expect(physical.statements[0]!.finalizeSync).toHaveBeenCalledOnce()
  db.close()
  factory.assertClosed()
})

test('selected native blobs and exported snapshots are owned Uint8Arrays', () => {
  const { db, physical, factory } = opening(),
    statement = fakeStatement()
  const buffer = new Uint8Array([1, 2]).buffer
  statement.result.getAllSync.mockReturnValue([{ blob: buffer }])
  physical.prepareSync.mockReturnValue(statement)
  const rows = db.select<{ blob: Uint8Array }>('SELECT blob')
  new Uint8Array(buffer)[0] = 44
  expect(rows[0]!.blob).toEqual(new Uint8Array([1, 2]))
  const serialized = snapshotBytes().buffer
  physical.serializeSync.mockReturnValue(serialized)
  const bytes = db.export()
  new Uint8Array(serialized)[16] = 55
  expect(bytes).toEqual(snapshotBytes())
  physical.serializeSync.mockReturnValue(new Uint8Array([1, 2]))
  expect(() => db.export()).toThrow(expect.objectContaining({ cause: 'Invalid SQLite header' }))
  db.close()
  factory.assertClosed()
})

for (const closeFails of [false, true])
  test(`session attach failure always attempts close; close fails=${closeFails}`, () => {
    const { db, physical, factory } = opening(),
      session = fakeSession()
    session.attachSync.mockImplementation(() => {
      throw new Error('attach')
    })
    if (closeFails === true)
      session.closeSync.mockImplementation(() => {
        throw new Error('session close')
      })
    physical.createSessionSync.mockReturnValue(session)
    expect(() => db.session()).toThrow()
    expect(session.closeSync).toHaveBeenCalledOnce()
    if (closeFails === true) {
      expect(() => db.close()).toThrow()
      expect(() => factory.assertClosed()).toThrow()
    } else {
      db.close()
      factory.assertClosed()
    }
  })

test('execute reset failure suppresses row-change callback and still finalizes', () => {
  const { db, physical, factory } = opening(),
    statement = fakeStatement(),
    changed = vi.fn()
  statement.result.resetSync.mockImplementation(() => {
    throw new Error('reset')
  })
  physical.prepareSync.mockReturnValue(statement)
  expect(() =>
    db.execute('UPDATE t SET x=?', prepareBindValues([1], 'UPDATE t SET x=?'), { onRowsChanged: changed }),
  ).toThrow()
  expect(changed).not.toHaveBeenCalled()
  expect(statement.finalizeSync).toHaveBeenCalledOnce()
  db.close()
  factory.assertClosed()
})

test('unbound SQL scripts execute every statement even when a change callback is requested', () => {
  const { db, physical, factory } = opening()
  const script = 'INSERT INTO t VALUES (1); INSERT INTO t VALUES (2);'
  const changed = vi.fn()
  physical.totalChanges = 5
  physical.execSync.mockImplementation(() => {
    physical.totalChanges += 2
  })
  db.execute(script, undefined, { onRowsChanged: changed })
  expect(physical.execSync).toHaveBeenCalledExactlyOnceWith(script)
  expect(physical.prepareSync).toHaveBeenCalledTimes(2)
  for (const statement of physical.statements) {
    expect(statement.result.resetSync).toHaveBeenCalledOnce()
    expect(statement.finalizeSync).toHaveBeenCalledOnce()
  }
  expect(changed).toHaveBeenCalledExactlyOnceWith(2)
  db.close()
  factory.assertClosed()
})

for (const failedQuery of ['before', 'after'] as const)
  test(`script total-changes ${failedQuery} query finalization failure permanently poisons closure`, () => {
    const { db, physical, factory } = opening()
    const statement = fakeStatement()
    statement.result.getAllSync.mockReturnValue([{ changes: 0 }])
    const cause = new Error('total changes query finalize failed')
    statement.finalizeSync.mockImplementation(() => {
      throw cause
    })
    if (failedQuery === 'before') physical.prepareSync.mockReturnValueOnce(statement)
    else {
      const before = fakeStatement()
      before.result.getAllSync.mockReturnValue([{ changes: 0 }])
      physical.prepareSync.mockReturnValueOnce(before).mockReturnValueOnce(statement)
    }
    const changed = vi.fn()
    expect(() =>
      db.execute('INSERT INTO t VALUES (1); INSERT INTO t VALUES (2);', undefined, { onRowsChanged: changed }),
    ).toThrow()
    expect(changed).not.toHaveBeenCalled()
    expect(physical.execSync).toHaveBeenCalledTimes(failedQuery === 'before' ? 0 : 1)
    expect(statement.finalizeSync).toHaveBeenCalledOnce()
    expect(() => db.close()).toThrow()
    expect(physical.closeSync).toHaveBeenCalledOnce()
    expect(statement.finalizeSync).toHaveBeenCalledOnce()
    expect(() => factory.assertClosed()).toThrow()
    expect(() => factory.assertClosed()).toThrow()
  })
