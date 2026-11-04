import { expect, test, vi } from 'vitest'

import { PreparedBindValues } from '@livestore/common'
import { inMemorySqliteDbFactory, sqliteDbFactory } from '@livestore/sqlite-wasm/browser'
import { loadSqlite3Wasm } from '@livestore/sqlite-wasm/load-wasm'
import { Effect, Exit, Fiber, Schema, Scope } from '@livestore/utils/effect'
import { Opfs } from '@livestore/utils/effect/browser'

import { makeOwnedOpfsFixture } from './opfs-owner.test-fixture.ts'

const scope = () => Effect.runPromise(Scope.make())
const close = (owned: Scope.Closeable) => Effect.runPromise(Scope.close(owned, Exit.void))
const owner = async () => {
  const sqlite3 = await loadSqlite3Wasm()
  const owned = await scope()
  const make = await Effect.runPromise(sqliteDbFactory({ sqlite3 }).pipe(Scope.provide(owned)))
  return { sqlite3, owned, make }
}
const open = async (
  factory: Awaited<ReturnType<typeof owner>>,
  fs: ReturnType<typeof makeOwnedOpfsFixture>,
  child: Scope.Closeable,
  fileName: string,
  directory = 'source',
) =>
  Effect.runPromise(
    factory
      .make({ _tag: 'opfs', opfsDirectory: directory, fileName })
      .pipe(Scope.provide(child), Effect.provideService(Opfs.Opfs, fs.service)),
  )

test('actual SQLite DB children share one physical pool and owner joins connections before every handle', async () => {
  const factory = await owner(),
    fs = makeOwnedOpfsFixture()
  const nativeClose = factory.sqlite3.close
  vi.spyOn(factory.sqlite3, 'close').mockImplementation((pointer) => {
    fs.events.push('sqlite-close')
    return nativeClose(pointer)
  })
  const first = await scope(),
    second = await scope(),
    reopened = await scope()
  try {
    const a = await open(factory, fs, first, 'eventlog.db')
    const b = await open(factory, fs, second, 'state.db')
    expect(a.metadata.vfs).toBe(b.metadata.vfs)
    b.execute('create table value(n integer)')
    b.execute('insert into value values (42)')
    const handles = fs.activeHandles()
    expect(handles).toBeGreaterThan(0)
    await close(first)
    expect(fs.activeHandles()).toBe(handles)
    expect(b.select('select n from value')).toEqual([{ n: 42 }])
    const c = await open(factory, fs, reopened, 'eventlog.db')
    expect(c.metadata.vfs).toBe(b.metadata.vfs)
    await close(factory.owned)
    expect(fs.activeHandles()).toBe(0)
    expect(fs.events.lastIndexOf('sqlite-close')).toBeLessThan(
      fs.events.findIndex((event) => event.startsWith('handle-close:')),
    )
  } finally {
    await close(first)
    await close(second)
    await close(reopened)
    await close(factory.owned)
  }
})

test('exact directory keys do not collide after path sanitization', async () => {
  const factory = await owner(),
    fs = makeOwnedOpfsFixture(),
    child = await scope()
  try {
    const a = await open(factory, fs, child, 'a.db', 'a/b')
    const b = await open(factory, fs, child, 'b.db', 'a_b')
    expect(a.metadata.vfs).not.toBe(b.metadata.vfs)
    a.execute('create table only_a(n integer)')
    expect(b.select("select name from sqlite_master where name='only_a'")).toEqual([])
  } finally {
    await close(child)
    await close(factory.owned)
  }
  expect(fs.activeHandles()).toBe(0)
})

test('two actual APIs retain independent VFS metadata for equal directory strings', async () => {
  const a = await owner(),
    b = await owner(),
    fsA = makeOwnedOpfsFixture(),
    fsB = makeOwnedOpfsFixture()
  const childA = await scope(),
    childB = await scope()
  try {
    const first = await open(a, fsA, childA, 'first.db')
    const other = await open(b, fsB, childB, 'other.db')
    const again = await open(a, fsA, childA, 'again.db')
    expect(again.metadata.vfs).toBe(first.metadata.vfs)
    expect(again.metadata.vfs).not.toBe(other.metadata.vfs)
  } finally {
    await close(childA)
    await close(childB)
    await close(a.owned)
    await close(b.owned)
  }
})

test('closed physical owners and API reuse refuse before native open or shared-memory adoption', async () => {
  const factory = await owner(),
    fs = makeOwnedOpfsFixture(),
    child = await scope()
  const nativeOpen = vi.spyOn(factory.sqlite3, 'open_v2Sync')
  await open(factory, fs, child, 'state.db')
  await close(factory.owned)
  const opened = nativeOpen.mock.calls.length
  expect(Exit.isFailure(await Effect.runPromiseExit(factory.make({ _tag: 'in-memory' })))).toBe(true)
  expect(
    Exit.isFailure(await Effect.runPromiseExit(Effect.scoped(sqliteDbFactory({ sqlite3: factory.sqlite3 })))),
  ).toBe(true)
  expect(Exit.isFailure(await Effect.runPromiseExit(inMemorySqliteDbFactory({ sqlite3: factory.sqlite3 })))).toBe(true)
  expect(nativeOpen).toHaveBeenCalledTimes(opened)
  await close(child)
})

test('user configuration failure closes an already adopted actual connection before physical handles', async () => {
  const factory = await owner(),
    fs = makeOwnedOpfsFixture(),
    child = await scope()
  const nativeClose = vi.spyOn(factory.sqlite3, 'close')
  const failure = await Effect.runPromiseExit(
    factory
      .make({
        _tag: 'opfs',
        opfsDirectory: 'source',
        fileName: 'bad.db',
        configureDb: () => {
          throw new Error('synthetic configuration failure')
        },
      })
      .pipe(Scope.provide(child), Effect.provideService(Opfs.Opfs, fs.service)),
  )
  expect(Exit.isFailure(failure)).toBe(true)
  expect(nativeClose).toHaveBeenCalledTimes(1)
  await close(factory.owned)
  expect(nativeClose).toHaveBeenCalledTimes(1)
  expect(fs.activeHandles()).toBe(0)
  await close(child)
})

test('owner cancellation joins native pool initialization before acknowledging cleanup', async () => {
  const factory = await owner(),
    fs = makeOwnedOpfsFixture(),
    child = await scope()
  const nativeOpen = vi.spyOn(factory.sqlite3, 'open_v2Sync')
  const gate = fs.pauseNextAcquisition()
  const opening = Effect.runFork(
    factory
      .make({ _tag: 'opfs', opfsDirectory: 'source', fileName: 'state.db' })
      .pipe(Scope.provide(child), Effect.provideService(Opfs.Opfs, fs.service)),
  )
  await gate.entered
  let closed = false
  const closing = close(factory.owned).then(() => {
    closed = true
    fs.events.push('owner-closed')
  })
  await Effect.runPromise(Effect.yieldNow)
  expect(closed).toBe(false)
  gate.release()
  await closing
  expect(Exit.isFailure(await Effect.runPromise(Fiber.await(opening)))).toBe(true)
  expect(fs.activeHandles()).toBe(0)
  expect(nativeOpen).not.toHaveBeenCalled()
  expect(fs.events.findIndex((event) => event.startsWith('handle-open:'))).toBeLessThan(
    fs.events.indexOf('owner-closed'),
  )
  await close(child)
})

test('failed native cleanup cannot produce successful owner close or a reusable factory', async () => {
  const factory = await owner(),
    fs = makeOwnedOpfsFixture(),
    child = await scope()
  await open(factory, fs, child, 'state.db')
  fs.failPhysicalClose()
  const result = await Effect.runPromiseExit(Scope.close(factory.owned, Exit.void))
  expect(Exit.isFailure(result)).toBe(true)
  expect(fs.activeHandles()).toBeGreaterThan(0)
  expect(Exit.isFailure(await Effect.runPromiseExit(factory.make({ _tag: 'in-memory' })))).toBe(true)
  await close(child)
})

test('memory-only APIs remain shareable across twenty DBs and cannot become physical owners', async () => {
  const sqlite3 = await loadSqlite3Wasm()
  const make = Effect.runSync(inMemorySqliteDbFactory({ sqlite3 }))
  const databases = Array.from({ length: 20 }, (_, value) => {
    const db = Effect.runSync(make({ _tag: 'in-memory' }))
    db.execute('create table value(n integer)')
    db.execute('insert into value values (?)', Schema.decodeSync(PreparedBindValues)([value]))
    return db
  })
  databases[0]!.close()
  expect(databases[19]!.select('select n from value')).toEqual([{ n: 19 }])
  expect(Exit.isFailure(await Effect.runPromiseExit(Effect.scoped(sqliteDbFactory({ sqlite3 }))))).toBe(true)
  databases.forEach((db) => db.close())
})

test('simultaneous explicit close callers share one joined physical completion', async () => {
  const factory = await owner(),
    fs = makeOwnedOpfsFixture(),
    child = await scope()
  const gate = fs.pauseNextAcquisition()
  const opening = Effect.runFork(
    factory
      .make({ _tag: 'opfs', opfsDirectory: 'source', fileName: 'state.db' })
      .pipe(Scope.provide(child), Effect.provideService(Opfs.Opfs, fs.service)),
  )
  await gate.entered
  let completed = 0
  const a = Effect.runPromise(factory.make.close).then(() => {
    completed++
  })
  const b = Effect.runPromise(factory.make.close).then(() => {
    completed++
  })
  await Effect.runPromise(Effect.yieldNow)
  expect(completed).toBe(0)
  gate.release()
  await Promise.all([a, b])
  expect(completed).toBe(2)
  expect(fs.activeHandles()).toBe(0)
  expect(Exit.isFailure(await Effect.runPromise(Fiber.await(opening)))).toBe(true)
  const closes = fs.events.filter((event) => event.startsWith('handle-close:')).length
  await close(factory.owned)
  expect(fs.events.filter((event) => event.startsWith('handle-close:'))).toHaveLength(closes)
  await close(child)
})

test('a fresh physical API reopens the retained SQLite database after joined closure', async () => {
  const fs = makeOwnedOpfsFixture(),
    first = await owner(),
    child = await scope()
  const before = await open(first, fs, child, 'retained.db')
  before.execute('create table retained(value text)')
  before.execute("insert into retained values ('saved')")
  await close(first.owned)
  expect(fs.activeHandles()).toBe(0)
  const second = await owner(),
    successor = await scope()
  try {
    const after = await open(second, fs, successor, 'retained.db')
    expect(after.select('select value from retained')).toEqual([{ value: 'saved' }])
  } finally {
    await close(child)
    await close(successor)
    await close(second.owned)
  }
  expect(fs.activeHandles()).toBe(0)
})

test('a closed unrelated caller scope cannot poison a healthy owner or its surviving database', async () => {
  const factory = await owner(),
    fs = makeOwnedOpfsFixture(),
    live = await scope(),
    ended = await scope()
  const stable = await open(factory, fs, live, 'live.db')
  await close(ended)
  const refused = await Effect.runPromiseExit(
    factory
      .make({ _tag: 'opfs', opfsDirectory: 'source', fileName: 'ended.db' })
      .pipe(Scope.provide(ended), Effect.provideService(Opfs.Opfs, fs.service)),
  )
  expect(Exit.isFailure(refused)).toBe(true)
  const additional = await open(factory, fs, live, 'additional.db')
  expect(additional.metadata.vfs).toBe(stable.metadata.vfs)
  expect(stable.select('select 1 as value')).toEqual([{ value: 1 }])
  await close(live)
  await close(factory.owned)
})

test('an initial pool failure leaves no reusable owner and no detached handles', async () => {
  const factory = await owner(),
    fs = makeOwnedOpfsFixture(),
    child = await scope()
  await fs.seedEmptyFile('source', 'existing-file')
  fs.failAcquisition()
  const result = await Effect.runPromiseExit(
    factory
      .make({ _tag: 'opfs', opfsDirectory: 'source', fileName: 'fail.db' })
      .pipe(Scope.provide(child), Effect.provideService(Opfs.Opfs, fs.service)),
  )
  expect(Exit.isFailure(result)).toBe(true)
  expect(Exit.isFailure(await Effect.runPromiseExit(factory.make({ _tag: 'in-memory' })))).toBe(true)
  await close(child)
  await close(factory.owned)
  expect(fs.activeHandles()).toBe(0)
})

test('shared memory VFS metadata remains API-local when another API opens between two calls', async () => {
  const first = await loadSqlite3Wasm(),
    second = await loadSqlite3Wasm()
  const makeA = Effect.runSync(inMemorySqliteDbFactory({ sqlite3: first }))
  const makeB = Effect.runSync(inMemorySqliteDbFactory({ sqlite3: second }))
  const a = Effect.runSync(makeA({ _tag: 'in-memory' }))
  const b = Effect.runSync(makeB({ _tag: 'in-memory' }))
  const again = Effect.runSync(makeA({ _tag: 'in-memory' }))
  expect(again.metadata.vfs).toBe(a.metadata.vfs)
  expect(again.metadata.vfs).not.toBe(b.metadata.vfs)
  a.close()
  b.close()
  again.close()
})
