import { expect, test, vi } from 'vitest'

import { fromSyncSource, initializeSource, SourceIdentity } from '@livestore/common/source-db'
import { type ApplicationBinding, type SourceMaintenanceLocationOwner } from '@livestore/common/source-maintenance'
import { SourceMaintenanceError } from '@livestore/common/source-maintenance'
import { withRetainedSource } from '@livestore/common/source-maintenance/internal'
import { loadSqlite3Wasm } from '@livestore/sqlite-wasm/load-wasm'
import { Effect } from '@livestore/utils/effect'
import { Opfs } from '@livestore/utils/effect/browser'

import { sqliteDbFactory } from '../mod.ts'
import { AccessHandlePoolVFS } from './AccessHandlePoolVFS.ts'
import { makeOwnedOpfsFixture } from './maintenance-fixture.ts'
import { makeOpfsSourceMaintenanceOpener } from './maintenance.ts'
import { acquireOpfsSourceNamespace, certifyOpfsSourceInventory } from './source-allocation.ts'

const freshApi = Effect.tryPromise({
  try: () => loadSqlite3Wasm(),
  catch: (cause) => new SourceMaintenanceError('test-api', cause),
})
const directory = 'retained@7'
const binding: ApplicationBinding = { operationId: 'opfs-test', context: { physical: directory } }
const locks = (events: string[]) =>
  ({
    request: async (_name: string, _options: LockOptions, use: (lock: Lock) => Promise<unknown>) => {
      events.push('lease')
      const result = await use({} as Lock)
      events.push('lease-release')
      return result
    },
  }) as unknown as LockManager
const free = () => {
  const data = new Uint8Array(4096)
  new Uint32Array(data.buffer, 516, 2).set([0xfecc5f80, 0xaccec037])
  return data
}
const associated = () => {
  const data = free()
  new TextEncoder().encodeInto('/eventlog.db', data)
  new DataView(data.buffer).setUint32(512, 0x100)
  new Uint32Array(data.buffer, 516, 2).set([3306171757, 1434404358])
  return data
}
const mutations = (events: string[]) => events.filter((event) => /write|truncate|create/.test(event))
const locationOwner = (events: string[]): SourceMaintenanceLocationOwner => ({
  run: (_context, effect) =>
    effect.pipe(
      Effect.onExit(() =>
        Effect.sync(() => {
          events.push('location-exit')
        }),
      ),
    ),
})

test('strict startup refuses corrupt and incomplete-free headers without repair, capacity, or directory creation', async () => {
  const corrupt = associated()
  corrupt[516] = corrupt[516]! ^ 1
  const invalidFreeFlags = free()
  new DataView(invalidFreeFlags.buffer).setUint32(512, 0x100)
  const incompleteFree = new Uint8Array(4097)
  incompleteFree.set(free())
  for (const bytes of [corrupt, invalidFreeFlags, incompleteFree, free().subarray(0, 516), free()]) {
    const fs = makeOwnedOpfsFixture()
    await fs.seedPoolFile(directory, 'pool', bytes)
    fs.events.length = 0
    const sqlite3 = await loadSqlite3Wasm()
    const result = await Effect.runPromiseExit(
      Effect.scoped(
        AccessHandlePoolVFS.create(
          'strict-test',
          directory,
          (sqlite3 as typeof sqlite3 & { module: unknown }).module,
          true,
        ).pipe(Effect.provideService(Opfs.Opfs, fs.service)),
      ),
    )
    expect(result._tag).toBe('Failure')
    expect(mutations(fs.events)).toEqual([])
    expect(fs.activeHandles()).toBe(0)
  }
})

test('missing authoritative eventlog or missing directory refuses without CREATE', async () => {
  for (const existing of [false, true]) {
    const fs = makeOwnedOpfsFixture()
    if (existing === true) await fs.seedPoolFile(directory, 'free', free())
    fs.events.length = 0
    const sqlite3 = await loadSqlite3Wasm()
    const opener = makeOpfsSourceMaintenanceOpener({
      binding,
      directory,
      makeSqliteApi: Effect.succeed(sqlite3),
      opfs: fs.service,
      locks: locks(fs.events),
      locationOwner: locationOwner(fs.events),
    })
    expect((await Effect.runPromiseExit(withRetainedSource(opener, binding, () => Effect.void)))._tag).toBe('Failure')
    expect(mutations(fs.events)).toEqual([])
    expect(fs.activeHandles()).toBe(0)
    expect(fs.events).toContain('lease-release')
  }
})

const seed = async (fs: ReturnType<typeof makeOwnedOpfsFixture>) => {
  const sqlite3 = await loadSqlite3Wasm()
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const make = yield* sqliteDbFactory({ sqlite3 })
        const namespace = yield* acquireOpfsSourceNamespace({
          locks: locks(fs.events),
          directory,
          closePhysicalOwner: make.close,
        })
        const native = yield* make({
          _tag: 'opfs',
          opfsDirectory: directory,
          fileName: 'eventlog.db',
          sourceInventory: certifyOpfsSourceInventory(namespace, directory, true),
        })
        const source = yield* Effect.acquireRelease(fromSyncSource(native, native.metadata.sourceCreation), (owner) =>
          owner.close.pipe(Effect.orDie),
        )
        yield* initializeSource(source)
      }).pipe(Effect.provideService(Opfs.Opfs, fs.service)),
    ),
  )
}

test('actual ordinary SQLite provider opens retained SOURCE and Scope joins every handle before namespace release', async () => {
  const fs = makeOwnedOpfsFixture()
  await seed(fs)
  fs.events.length = 0
  const close = vi.spyOn(AccessHandlePoolVFS.prototype, 'close')
  try {
    const sqlite3 = await loadSqlite3Wasm()
    const nativeOpen = vi.spyOn(sqlite3, 'open_v2Sync')
    const opener = makeOpfsSourceMaintenanceOpener({
      binding,
      directory,
      makeSqliteApi: Effect.succeed(sqlite3),
      opfs: fs.service,
      locks: locks(fs.events),
      locationOwner: locationOwner(fs.events),
    })
    expect(
      await Effect.runPromise(withRetainedSource(opener, binding, (source) => SourceIdentity.read(source.handle))),
    ).toMatchObject({ formatVersion: 7 })
    expect(fs.activeHandles()).toBe(0)
    expect(mutations(fs.events)).toEqual([])
    expect(fs.events.lastIndexOf('lease-release')).toBeGreaterThan(
      fs.events.findLastIndex((event) => event.startsWith('handle-close:')),
    )
    expect(close).not.toHaveBeenCalled()
    expect(nativeOpen).toHaveBeenCalledWith('eventlog.db', 2, expect.any(String))
  } finally {
    close.mockRestore()
  }
})

test('uncertain physical handle close retains namespace and never yields a closed capture', async () => {
  const fs = makeOwnedOpfsFixture()
  await seed(fs)
  fs.events.length = 0
  fs.failPhysicalClose()
  const sqlite3 = await loadSqlite3Wasm()
  const opener = makeOpfsSourceMaintenanceOpener({
    binding,
    directory,
    makeSqliteApi: Effect.succeed(sqlite3),
    opfs: fs.service,
    locks: locks(fs.events),
    locationOwner: locationOwner(fs.events),
  })
  expect(
    (await Effect.runPromiseExit(withRetainedSource(opener, binding, (source) => SourceIdentity.read(source.handle))))
      ._tag,
  ).toBe('Failure')
  expect(fs.events).not.toContain('lease-release')
  expect(fs.activeHandles()).toBeGreaterThan(0)
})

test('one opaque opener supports repeated acquisitions with a fresh actual API each time', async () => {
  const fs = makeOwnedOpfsFixture()
  await seed(fs)
  fs.events.length = 0
  const opener = makeOpfsSourceMaintenanceOpener({
    binding,
    directory,
    makeSqliteApi: freshApi,
    opfs: fs.service,
    locks: locks(fs.events),
    locationOwner: locationOwner(fs.events),
  })
  const first = await Effect.runPromise(
    withRetainedSource(opener, binding, (source) => SourceIdentity.read(source.handle)),
  )
  const second = await Effect.runPromise(
    withRetainedSource(opener, binding, (source) => SourceIdentity.read(source.handle)),
  )
  expect(second).toEqual(first)
  expect(fs.activeHandles()).toBe(0)
  expect(fs.events.filter((event) => event === 'lease-release')).toHaveLength(2)
})

test('a cached API is refused by the existing physical ownership guard on a second attempt', async () => {
  const fs = makeOwnedOpfsFixture()
  await seed(fs)
  fs.events.length = 0
  const cached = await loadSqlite3Wasm()
  const opener = makeOpfsSourceMaintenanceOpener({
    binding,
    directory,
    makeSqliteApi: Effect.succeed(cached),
    opfs: fs.service,
    locks: locks(fs.events),
    locationOwner: locationOwner(fs.events),
  })
  await Effect.runPromise(withRetainedSource(opener, binding, (source) => SourceIdentity.read(source.handle)))
  expect((await Effect.runPromiseExit(withRetainedSource(opener, binding, () => Effect.void)))._tag).toBe('Failure')
  expect(fs.activeHandles()).toBe(0)
  expect(mutations(fs.events)).toEqual([])
  expect(fs.events.filter((event) => event === 'lease')).toHaveLength(1)
})
