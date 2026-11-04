import { expect, test, vi } from 'vitest'

import { liveStoreStorageFormatVersion } from '@livestore/common'
import { sqliteDbFactory, type OpfsSourceInventory } from '@livestore/sqlite-wasm/browser'
import { consumeOpfsSourceInventory } from '@livestore/sqlite-wasm/browser/internal-source'
import { loadSqlite3Wasm } from '@livestore/sqlite-wasm/load-wasm'
import { Effect, Exit, Scope } from '@livestore/utils/effect'
import { Opfs } from '@livestore/utils/effect/browser'

import { makeOwnedOpfsFixture } from './opfs-owner.test-fixture.ts'
import { discoverPersistedSource } from './persisted-sqlite.ts'
import { acquireSourceNamespace } from './source-namespace.ts'

const locks = () => {
  type Request = { grant: () => void; reject: (cause: unknown) => void }
  const queued: Request[] = []
  let active = false
  const names: string[] = []
  const manager = {
    request: (name: string, options: LockOptions, body: (lock: Lock | null) => Promise<unknown>) =>
      new Promise((resolve, reject) => {
        names.push(name)
        const request: Request = {
          reject,
          grant: () => {
            if (options.signal?.aborted === true) return
            active = true
            void body({ name, mode: 'exclusive' } as Lock).then((value) => {
              active = false
              resolve(value)
              queued.shift()?.grant()
            }, reject)
          },
        }
        options.signal?.addEventListener('abort', () => {
          const index = queued.indexOf(request)
          if (index !== -1) queued.splice(index, 1)
          if (active === false || index !== -1) reject(new DOMException('cancelled', 'AbortError'))
        })
        if (active === true) queued.push(request)
        else queueMicrotask(request.grant)
      }),
  } as unknown as LockManager
  return { manager, names, active: () => active }
}
const scope = () => Effect.runPromise(Scope.make())
const close = (value: Scope.Closeable) => Effect.runPromise(Scope.close(value, Exit.void))
const directory = `livestore-owned@${liveStoreStorageFormatVersion}`
const options = { storageOptions: { type: 'opfs' as const }, storeId: 'owned' }
const factory = async () => {
  const owned = await scope()
  const sqlite3 = await loadSqlite3Wasm()
  const make = await Effect.runPromise(sqliteDbFactory({ sqlite3 }).pipe(Scope.provide(owned)))
  return { owned, make }
}

const inventoryOf = (discovery: { inventory?: OpfsSourceInventory }): OpfsSourceInventory => {
  if (discovery.inventory === undefined) throw new Error('Owned discovery must return an inventory')
  return discovery.inventory
}

test('exact namespace serializes owners and release joins physical owner before next callback', async () => {
  const native = locks(),
    first = await scope(),
    second = await scope()
  const entered = Promise.withResolvers<void>(),
    finish = Promise.withResolvers<void>()
  const a = await Effect.runPromise(
    acquireSourceNamespace({
      directory,
      locks: native.manager,
      closePhysicalOwner: Effect.promise(async () => {
        entered.resolve()
        await finish.promise
      }),
    }).pipe(Scope.provide(first)),
  )
  const admitted = { second: false }
  const next = Effect.runPromise(
    acquireSourceNamespace({ directory, locks: native.manager, closePhysicalOwner: Effect.void }).pipe(
      Scope.provide(second),
    ),
  ).then((value) => {
    admitted.second = true
    return value
  })
  const closing = close(first)
  await entered.promise
  expect(a.isHeld()).toBe(true)
  expect(admitted.second).toBe(false)
  finish.resolve()
  await closing
  const b = await next
  expect(a.isHeld()).toBe(false)
  expect(b.isHeld()).toBe(true)
  expect(native.names).toEqual([
    `livestore-source-authority:opfs:${directory}`,
    `livestore-source-authority:opfs:${directory}`,
  ])
  await close(second)
  expect(native.active()).toBe(false)
})

test('actual SQLite first source association yields a held receipt only after flush and strict inventory', async () => {
  const native = locks(),
    owner = await factory(),
    namespaceScope = await scope(),
    child = await scope()
  const fs = makeOwnedOpfsFixture()
  const namespace = await Effect.runPromise(
    acquireSourceNamespace({ directory, locks: native.manager, closePhysicalOwner: owner.make.close }).pipe(
      Scope.provide(namespaceScope),
    ),
  )
  try {
    const discovery = await Effect.runPromise(
      discoverPersistedSource({ ...options, namespace }).pipe(Effect.provideService(Opfs.Opfs, fs.service)),
    )
    expect(discovery.sourceIsNew).toBe(true)
    expect(discovery.inventory).toBeDefined()
    const db = await Effect.runPromise(
      owner
        .make({
          _tag: 'opfs',
          opfsDirectory: directory,
          fileName: 'eventlog.db',
          sourceInventory: inventoryOf(discovery),
        })
        .pipe(Scope.provide(child), Effect.provideService(Opfs.Opfs, fs.service)),
    )
    expect(fs.events.some((event) => event.endsWith(':/eventlog.db'))).toBe(true)
    expect(db.metadata.sourceCreation).toMatchObject({
      kind: 'exclusive-opfs-source-association',
      storageName: `opfs:${directory}/eventlog.db`,
    })
    expect(db.metadata.sourceCreation?.isHeld()).toBe(true)
    expect(() => consumeOpfsSourceInventory(discovery.inventory!, directory)).toThrow('spent')
    await close(child)
    expect(db.metadata.sourceCreation?.isHeld()).toBe(false)
    expect(namespace.isHeld()).toBe(true)
    expect(fs.activeHandles()).toBeGreaterThan(0)
    await close(namespaceScope)
    expect(fs.activeHandles()).toBe(0)
    expect(native.active()).toBe(false)
  } finally {
    await close(child)
    await close(namespaceScope)
    await close(owner.owned)
  }
})

test('existing associated empty SOURCE never receives another creation receipt', async () => {
  const native = locks(),
    fs = makeOwnedOpfsFixture()
  const first = await factory(),
    aScope = await scope(),
    aChild = await scope()
  const a = await Effect.runPromise(
    acquireSourceNamespace({ directory, locks: native.manager, closePhysicalOwner: first.make.close }).pipe(
      Scope.provide(aScope),
    ),
  )
  const discovered = await Effect.runPromise(
    discoverPersistedSource({ ...options, namespace: a }).pipe(Effect.provideService(Opfs.Opfs, fs.service)),
  )
  await Effect.runPromise(
    first
      .make({
        _tag: 'opfs',
        opfsDirectory: directory,
        fileName: 'eventlog.db',
        sourceInventory: inventoryOf(discovered),
      })
      .pipe(Scope.provide(aChild), Effect.provideService(Opfs.Opfs, fs.service)),
  )
  await close(aChild)
  await close(aScope)
  await close(first.owned)
  const second = await factory(),
    bScope = await scope(),
    bChild = await scope()
  const b = await Effect.runPromise(
    acquireSourceNamespace({ directory, locks: native.manager, closePhysicalOwner: second.make.close }).pipe(
      Scope.provide(bScope),
    ),
  )
  try {
    const retained = await Effect.runPromise(
      discoverPersistedSource({ ...options, namespace: b }).pipe(Effect.provideService(Opfs.Opfs, fs.service)),
    )
    expect(retained.sourceIsNew).toBe(false)
    const db = await Effect.runPromise(
      second
        .make({
          _tag: 'opfs',
          opfsDirectory: directory,
          fileName: 'eventlog.db',
          sourceInventory: inventoryOf(retained),
        })
        .pipe(Scope.provide(bChild), Effect.provideService(Opfs.Opfs, fs.service)),
    )
    expect(db.metadata.sourceCreation).toBeUndefined()
  } finally {
    await close(bChild)
    await close(bScope)
    await close(second.owned)
  }
})

test('physical teardown failure keeps namespace authority and pool handles held', async () => {
  const native = locks(),
    fs = makeOwnedOpfsFixture(),
    owner = await factory(),
    namespaceScope = await scope(),
    child = await scope()
  const namespace = await Effect.runPromise(
    acquireSourceNamespace({ directory, locks: native.manager, closePhysicalOwner: owner.make.close }).pipe(
      Scope.provide(namespaceScope),
    ),
  )
  const discovered = await Effect.runPromise(
    discoverPersistedSource({ ...options, namespace }).pipe(Effect.provideService(Opfs.Opfs, fs.service)),
  )
  await Effect.runPromise(
    owner
      .make({
        _tag: 'opfs',
        opfsDirectory: directory,
        fileName: 'eventlog.db',
        sourceInventory: inventoryOf(discovered),
      })
      .pipe(Scope.provide(child), Effect.provideService(Opfs.Opfs, fs.service)),
  )
  fs.failPhysicalClose()
  expect(await Effect.runPromiseExit(Scope.close(namespaceScope, Exit.void))).toMatchObject({ _tag: 'Failure' })
  expect(namespace.isHeld()).toBe(true)
  expect(native.active()).toBe(true)
  expect(fs.activeHandles()).toBeGreaterThan(0)
  // Synthetic failed native resources deliberately remain quarantined; there is no inferred teardown or lock release.
  await Effect.runPromiseExit(Scope.close(owner.owned, Exit.void))
})

test('foreign or expired inventory refuses before permissive pool initialization', async () => {
  const native = locks(),
    fs = makeOwnedOpfsFixture(),
    owner = await factory(),
    namespaceScope = await scope()
  const namespace = await Effect.runPromise(
    acquireSourceNamespace({ directory, locks: native.manager, closePhysicalOwner: owner.make.close }).pipe(
      Scope.provide(namespaceScope),
    ),
  )
  const discovery = await Effect.runPromise(
    discoverPersistedSource({ ...options, namespace }).pipe(Effect.provideService(Opfs.Opfs, fs.service)),
  )
  const inventory = inventoryOf(discovery)
  const forged = { ...inventory }
  expect(
    await Effect.runPromiseExit(
      owner
        .make({ _tag: 'opfs', opfsDirectory: directory, fileName: 'eventlog.db', sourceInventory: forged })
        .pipe(Effect.provideService(Opfs.Opfs, fs.service), Scope.provide(owner.owned)),
    ),
  ).toMatchObject({ _tag: 'Failure' })
  expect(fs.activeHandles()).toBe(0)
  expect(fs.events).toEqual([])
  await close(namespaceScope)
  expect(() => consumeOpfsSourceInventory(inventory, directory)).toThrow('no longer owned')
  await close(owner.owned)
})

test('uncertain actual SQLite open keeps namespace and pool rather than releasing an untracked native pointer', async () => {
  const native = locks(),
    fs = makeOwnedOpfsFixture(),
    owned = await scope(),
    namespaceScope = await scope()
  const sqlite3 = await loadSqlite3Wasm()
  const make = await Effect.runPromise(sqliteDbFactory({ sqlite3 }).pipe(Scope.provide(owned)))
  const namespace = await Effect.runPromise(
    acquireSourceNamespace({ directory, locks: native.manager, closePhysicalOwner: make.close }).pipe(
      Scope.provide(namespaceScope),
    ),
  )
  const discovery = await Effect.runPromise(
    discoverPersistedSource({ ...options, namespace }).pipe(Effect.provideService(Opfs.Opfs, fs.service)),
  )
  const nativeOpen = sqlite3.open_v2Sync
  vi.spyOn(sqlite3, 'open_v2Sync').mockImplementation((...args) => {
    nativeOpen(...args)
    throw new Error('controlled failure after native pointer allocation')
  })
  expect(
    await Effect.runPromiseExit(
      make({
        _tag: 'opfs',
        opfsDirectory: directory,
        fileName: 'eventlog.db',
        sourceInventory: inventoryOf(discovery),
      }).pipe(Effect.provideService(Opfs.Opfs, fs.service), Scope.provide(owned)),
    ),
  ).toMatchObject({ _tag: 'Failure' })
  expect(await Effect.runPromiseExit(Scope.close(namespaceScope, Exit.void))).toMatchObject({ _tag: 'Failure' })
  expect(namespace.isHeld()).toBe(true)
  expect(fs.activeHandles()).toBeGreaterThan(0)
  await Effect.runPromiseExit(Scope.close(owned, Exit.void))
})
