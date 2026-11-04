import { expect, test, vi } from 'vitest'

import { sqliteDbFactory } from '@livestore/sqlite-wasm/browser'
import { loadSqlite3Wasm } from '@livestore/sqlite-wasm/load-wasm'
import { Effect, Exit, Scope } from '@livestore/utils/effect'
import { Opfs } from '@livestore/utils/effect/browser'

import { makeOwnedOpfsFixture } from './opfs-owner.test-fixture.ts'

const owner = async () => {
  const sqlite3 = await loadSqlite3Wasm()
  const parent = await Effect.runPromise(Scope.make())
  const make = await Effect.runPromise(sqliteDbFactory({ sqlite3 }).pipe(Scope.provide(parent)))
  const fs = makeOwnedOpfsFixture()
  const open = (fileName: string) =>
    Effect.runPromise(
      make({ _tag: 'opfs', opfsDirectory: 'review', fileName }).pipe(
        Scope.provide(parent),
        Effect.provideService(Opfs.Opfs, fs.service),
      ),
    )
  return { sqlite3, parent, make, fs, open }
}

test('repeated real SQLite imports preserve one connection owner and close its original pointer once', async () => {
  const factory = await owner()
  const source = await Effect.runPromise(factory.make({ _tag: 'in-memory' }))
  const target = await factory.open('target.db')
  const pointer = target.metadata.dbPointer
  const originalClose = target.close
  source.execute('create table imported(value text)')
  source.execute("insert into imported values ('retained')")
  const closedPointers: number[] = []
  const nativeClose = factory.sqlite3.close
  vi.spyOn(factory.sqlite3, 'close').mockImplementation((db) => {
    closedPointers.push(db)
    return nativeClose(db)
  })
  try {
    for (let index = 0; index < 50; index++) {
      target.import(source)
      expect(target.metadata.dbPointer).toBe(pointer)
      expect(target.close).toBe(originalClose)
      expect(target.select('select value from imported')).toEqual([{ value: 'retained' }])
    }
    await Effect.runPromise(factory.make.close)
    expect(closedPointers.filter((db) => db === pointer)).toHaveLength(1)
    expect(factory.fs.activeHandles()).toBe(0)
    expect(() => target.select('select value from imported')).toThrow()
  } finally {
    await Effect.runPromise(Scope.close(factory.parent, Exit.void))
  }
})

test('real SQLITE_BUSY close quarantines admission and retains pools while the native database remains live', async () => {
  const factory = await owner()
  const db = await factory.open('busy.db')
  db.execute('create table retained(value integer)')
  db.execute('insert into retained values (42)')
  const pointer = db.metadata.dbPointer
  // This statement is deliberately outside SqliteDb's tracked statements, so sqlite3_close really returns BUSY.
  const statements = factory.sqlite3.statements(pointer, 'select value from retained', { unscoped: true })
  const statement = statements[0]!
  const module = (
    factory.sqlite3 as unknown as {
      module: { cwrap: (name: string, result: string, args: string[]) => (...args: number[]) => number }
    }
  ).module
  const nativeStep = module.cwrap('sqlite3_step', 'number', ['number'])
  const nativeClose = module.cwrap('sqlite3_close', 'number', ['number'])
  const closeSpy = vi.spyOn(factory.sqlite3, 'close')
  const openSpy = vi.spyOn(factory.sqlite3, 'open_v2Sync')
  const handles = factory.fs.activeHandles()
  try {
    expect(() => db.close()).toThrow(expect.objectContaining({ code: 5 }))
    expect(closeSpy).toHaveBeenCalledExactlyOnceWith(pointer)
    // wa-sqlite drops its JS database registry before reporting BUSY; native stepping proves the pointer is live.
    expect(nativeStep(statement)).toBe(100)
    expect.soft(Exit.isFailure(await Effect.runPromiseExit(factory.make({ _tag: 'in-memory' })))).toBe(true)
    expect.soft(openSpy).not.toHaveBeenCalled()
    const failed = await Effect.runPromiseExit(factory.make.close)
    expect(Exit.isFailure(failed)).toBe(true)
    expect(factory.fs.activeHandles()).toBe(handles)
    expect(factory.fs.events.some((event) => event.startsWith('handle-close:'))).toBe(false)
    expect(Exit.isFailure(await Effect.runPromiseExit(factory.make.close))).toBe(true)
    expect(closeSpy).toHaveBeenCalledExactlyOnceWith(pointer)
  } finally {
    factory.sqlite3.finalize(statement)
    // Test-harness teardown bypasses the deliberately quarantined wrapper only after its live statement is gone.
    expect(nativeClose(pointer)).toBe(0)
    await Effect.runPromise(
      db.metadata.vfs
        .removeCapacity(db.metadata.vfs.getCapacity())
        .pipe(Effect.provideService(Opfs.Opfs, factory.fs.service)),
    )
    await Effect.runPromiseExit(Scope.close(factory.parent, Exit.void))
  }
})
