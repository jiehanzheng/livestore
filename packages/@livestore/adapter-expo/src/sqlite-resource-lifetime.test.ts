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

test('each factory-created database is separately tracked, including core scratch databases', () => {
  const { factory, db, physical } = opening()
  const scratch = Effect.runSync(factory.makeSqliteDb({ _tag: 'in-memory' }))
  const file = Effect.runSync(
    factory.makeSqliteDb({ _tag: 'file', databaseName: 'state.db', directory: '/private/test' }),
  )
  expect(native.openDatabaseSync).toHaveBeenNthCalledWith(1, ':memory:', { useNewConnection: true })
  expect(native.openDatabaseSync).toHaveBeenLastCalledWith('state.db', { useNewConnection: true }, '/private/test')
  db.close()
  expect(physical.closeSync).toHaveBeenCalledOnce()
  expect(() => factory.assertClosed()).toThrow()
  scratch.close()
  expect(() => factory.assertClosed()).toThrow()
  file.close()
  expect(() => factory.assertClosed()).not.toThrow()
})

test('all finalizers and database close run despite one statement failure; closure stays poisoned', () => {
  const { factory, db, physical } = opening()
  const first = db.prepare('SELECT 1'),
    second = db.prepare('SELECT 2')
  physical.statements[0]!.finalizeSync.mockImplementation(() => {
    throw new Error('finalize')
  })
  const session = db.session()
  let failure: unknown
  try {
    db.close()
  } catch (cause) {
    failure = cause
  }
  expect(failure).toBeDefined()
  expect(physical.statements[1]!.finalizeSync).toHaveBeenCalledOnce()
  expect(physical.sessions[0]!.closeSync).toHaveBeenCalledOnce()
  expect(physical.closeSync).toHaveBeenCalledOnce()
  expect(() => db.close()).toThrow(failure as Error)
  expect(() => factory.assertClosed()).toThrow()
  expect(() => first.execute(prepareBindValues([], 'SELECT 1'))).toThrow()
  expect(() => second.select(prepareBindValues([], 'SELECT 2'))).toThrow()
  expect(() => first.finalize()).toThrow()
  session.finish()
})

test('successful close is idempotent; failed physical close is not retried or declared closed', () => {
  const good = opening()
  good.db.close()
  good.db.close()
  expect(good.physical.closeSync).toHaveBeenCalledOnce()
  good.factory.assertClosed()
  const bad = opening()
  bad.physical.closeSync.mockImplementation(() => {
    throw new Error('close')
  })
  expect(() => bad.db.close()).toThrow()
  expect(() => bad.db.close()).toThrow()
  expect(bad.physical.closeSync).toHaveBeenCalledOnce()
  expect(() => bad.factory.assertClosed()).toThrow()
})

test('session finish is idempotent and prevents later changeset capture', () => {
  const { db, physical, factory } = opening(),
    session = db.session()
  expect(session.changeset()).toEqual(new Uint8Array([2, 3]))
  session.finish()
  session.finish()
  expect(physical.sessions[0]!.closeSync).toHaveBeenCalledOnce()
  expect(() => session.changeset()).toThrow()
  db.close()
  factory.assertClosed()
})

for (const operation of ['invert', 'apply'] as const)
  test(`changeset ${operation} uses a temporary session, including failure`, () => {
    const { db, physical, factory } = opening(),
      bytes = new Uint8Array([90, 1, 2, 91])
    const changeset = db.makeChangeset(bytes.subarray(1, 3))
    bytes[1] = 55
    expect(physical.createSessionSync).not.toHaveBeenCalled()
    changeset[operation]()
    const session = physical.sessions[0]!
    const method = operation === 'invert' ? session.invertChangesetSync : session.applyChangesetSync
    expect(method).toHaveBeenCalledWith(new Uint8Array([1, 2]))
    expect(session.closeSync).toHaveBeenCalledOnce()
    const failing = fakeSession()
    ;(operation === 'invert' ? failing.invertChangesetSync : failing.applyChangesetSync).mockImplementation(() => {
      throw new Error(operation)
    })
    physical.createSessionSync.mockReturnValue(failing)
    expect(() => changeset[operation]()).toThrow()
    expect(failing.closeSync).toHaveBeenCalledOnce()
    db.close()
    factory.assertClosed()
  })

test('a direct statement finalization failure poisons closure even if physical close succeeds', () => {
  const { db, physical, factory } = opening(),
    statement = fakeStatement()
  statement.finalizeSync.mockImplementation(() => {
    throw new Error('finalize')
  })
  physical.prepareSync.mockReturnValue(statement)
  expect(() => db.select('SELECT 1')).toThrow()
  expect(() => db.close()).toThrow()
  expect(physical.closeSync).toHaveBeenCalledOnce()
  expect(statement.finalizeSync).toHaveBeenCalledOnce()
  expect(() => factory.assertClosed()).toThrow()
})

test('capture failure keeps the owned session available for deterministic database cleanup', () => {
  const { db, physical, factory } = opening(),
    session = db.session()
  physical.sessions[0]!.createChangesetSync.mockImplementation(() => {
    throw new Error('capture')
  })
  expect(() => session.changeset()).toThrow()
  db.close()
  expect(physical.sessions[0]!.closeSync).toHaveBeenCalledOnce()
  factory.assertClosed()
})

for (const operation of ['invert', 'apply'] as const)
  test(`changeset ${operation} session close failure blocks confirmed closure`, () => {
    const { db, physical, factory } = opening(),
      session = fakeSession()
    session.closeSync.mockImplementation(() => {
      throw new Error('session close')
    })
    physical.createSessionSync.mockReturnValue(session)
    expect(() => db.makeChangeset(new Uint8Array())[operation]()).toThrow()
    expect(session.closeSync).toHaveBeenCalledOnce()
    expect(() => db.close()).toThrow()
    expect(physical.closeSync).toHaveBeenCalledOnce()
    expect(() => factory.assertClosed()).toThrow()
  })

test('opaque native initialization failure permanently refuses positive closure evidence', () => {
  const factory = createSqliteFactory()
  native.openDatabaseSync.mockImplementationOnce(() => {
    throw new Error('native init failed before handle returned')
  })
  expect(() => Effect.runSync(factory.makeSqliteDb({ _tag: 'in-memory' }))).toThrow()
  const later = Effect.runSync(factory.makeSqliteDb({ _tag: 'in-memory' }))
  later.close()
  expect(() => factory.assertClosed()).toThrow('closure is unconfirmed')
  expect(() => factory.assertClosed()).toThrow('closure is unconfirmed')
})

test('opaque snapshot initialization failure remains uncertain after destination closes', () => {
  const { factory, db, physical } = opening()
  native.deserializeDatabaseSync.mockImplementationOnce(() => {
    throw new Error('snapshot init failed before handle returned')
  })
  expect(() => db.import(snapshotBytes())).toThrow()
  expect(native.backupDatabaseSync).not.toHaveBeenCalled()
  db.close()
  expect(physical.closeSync).toHaveBeenCalledOnce()
  expect(() => factory.assertClosed()).toThrow('closure is unconfirmed')
})

const nativeFailure = (message: string, code = 'ERR_INTERNAL_SQLITE_ERROR') =>
  Object.assign(new Error(message), { code })

for (const mode of ['execute', 'read', 'reset'] as const)
  test(`reported native ${mode} error survives confirmed statement destruction`, () => {
    const { db, physical, factory } = opening(),
      statement = fakeStatement()
    const original = nativeFailure('UNIQUE constraint failed')
    physical.prepareSync.mockReturnValue(statement)
    if (mode === 'execute')
      statement.executeSync.mockImplementation(() => {
        throw original
      })
    if (mode === 'read')
      statement.result.getAllSync.mockImplementation(() => {
        throw original
      })
    if (mode === 'reset')
      statement.result.resetSync.mockImplementation(() => {
        throw original
      })
    statement.finalizeSync.mockImplementation(() => {
      throw nativeFailure('UNIQUE constraint failed')
    })
    statement.getColumnNamesSync.mockImplementation(() => {
      throw nativeFailure('Access to closed resource', 'ERR_ACCESS_CLOSED_RESOURCE')
    })
    expect(() => db.select('SELECT value FROM t')).toThrow(expect.objectContaining({ cause: original }))
    expect(statement.executeSync).toHaveBeenCalledOnce()
    expect(statement.finalizeSync).toHaveBeenCalledOnce()
    expect(statement.getColumnNamesSync).toHaveBeenCalledOnce()
    db.close()
    factory.assertClosed()
  })

for (const probe of ['open', 'unknown'] as const)
  test(`unconfirmed destruction after SQL failure stays refused: ${probe}`, () => {
    const { db, physical, factory } = opening(),
      statement = fakeStatement()
    physical.prepareSync.mockReturnValue(statement)
    statement.executeSync.mockImplementation(() => {
      throw nativeFailure('SQL failure')
    })
    statement.finalizeSync.mockImplementation(() => {
      throw nativeFailure('SQL failure')
    })
    if (probe === 'unknown')
      statement.getColumnNamesSync.mockImplementation(() => {
        throw new Error('Inspection failed')
      })
    expect(() => db.select('SELECT value FROM t')).toThrow()
    expect(() => db.close()).toThrow()
    expect(() => factory.assertClosed()).toThrow()
    expect(statement.finalizeSync).toHaveBeenCalledOnce()
  })

test('unknown finalizer error is not excused by an earlier SQL failure', () => {
  const { db, physical, factory } = opening(),
    statement = fakeStatement()
  physical.prepareSync.mockReturnValue(statement)
  statement.executeSync.mockImplementation(() => {
    throw nativeFailure('SQL failure')
  })
  statement.finalizeSync.mockImplementation(() => {
    throw new Error('Unknown finalizer failure')
  })
  expect(() => db.select('SELECT value FROM t')).toThrow()
  expect(statement.getColumnNamesSync).not.toHaveBeenCalled()
  expect(() => db.close()).toThrow()
  expect(() => factory.assertClosed()).toThrow()
})

for (const priorFailure of [false, true])
  test(`unreported finalizer errors remain observable after successful execution; prior failure=${priorFailure}`, () => {
    const { db, physical, factory } = opening(),
      statement = fakeStatement()
    physical.prepareSync.mockReturnValue(statement)
    const prepared = db.prepare('UPDATE t SET value = ?')
    const values = prepareBindValues([1], prepared.sql)
    if (priorFailure === true) {
      statement.executeSync.mockImplementationOnce(() => {
        throw nativeFailure('Prior SQL failure')
      })
      expect(() => prepared.execute(values)).toThrow()
    }
    prepared.execute(values)
    statement.finalizeSync.mockImplementation(() => {
      throw nativeFailure('Previously unreported finalizer error')
    })
    expect(() => prepared.finalize()).toThrow()
    expect(statement.getColumnNamesSync).not.toHaveBeenCalled()
    expect(() => db.close()).toThrow()
    expect(() => factory.assertClosed()).toThrow()
  })

test('successful statement finalization does not need closed-handle probing', () => {
  const { db, physical, factory } = opening(),
    statement = fakeStatement()
  physical.prepareSync.mockReturnValue(statement)
  db.select('SELECT value FROM t')
  expect(statement.getColumnNamesSync).not.toHaveBeenCalled()
  db.close()
  factory.assertClosed()
})

for (const allSqlite of [true, false])
  test(`combined read/reset failures attest only previously reported SQL errors: ${allSqlite}`, () => {
    const { db, physical, factory } = opening(),
      statement = fakeStatement()
    physical.prepareSync.mockReturnValue(statement)
    statement.result.getAllSync.mockImplementation(() => {
      throw allSqlite === true ? nativeFailure('Read failed') : new Error('Row conversion failed')
    })
    statement.result.resetSync.mockImplementation(() => {
      throw nativeFailure('Reset repeated SQL failure')
    })
    statement.finalizeSync.mockImplementation(() => {
      throw nativeFailure('Finalize repeated SQL failure')
    })
    statement.getColumnNamesSync.mockImplementation(() => {
      throw nativeFailure('Closed', 'ERR_ACCESS_CLOSED_RESOURCE')
    })
    expect(() => db.select('SELECT value FROM t')).toThrow()
    if (allSqlite === true) {
      db.close()
      factory.assertClosed()
    } else {
      expect(statement.getColumnNamesSync).not.toHaveBeenCalled()
      expect(() => db.close()).toThrow()
      expect(() => factory.assertClosed()).toThrow()
    }
  })
