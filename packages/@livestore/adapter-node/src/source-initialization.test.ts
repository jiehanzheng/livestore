import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { expect, test } from 'vitest'

import { liveStoreStorageFormatVersion, provideOtel } from '@livestore/common'
import { makeSchema, State } from '@livestore/common/schema'
import { assertInitialized, type InitializedSource, type SourceOwner } from '@livestore/common/source-db'
import { createStore } from '@livestore/livestore'
import { loadSqlite3Wasm } from '@livestore/sqlite-wasm/load-wasm'
import { sqliteDbFactory } from '@livestore/sqlite-wasm/node'
import { Effect } from '@livestore/utils/effect'
import { PlatformNode } from '@livestore/utils/node'

import { makeAdapter } from './index.ts'
import { openDatabases, type NodeStorage } from './storage.ts'
const schema = makeSchema({
  projectionRevision: 'source-initialization-v1',
  events: {},
  state: State.SQLite.makeState({ tables: {}, materializers: {} }),
})
test('actual retained source without identity refuses before any state factory and preserves raw source', async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'source-proof-'))
  const directory = path.join(base, 'replica')
  await fs.mkdir(directory)
  const sourceName = `eventlog@${liveStoreStorageFormatVersion}.db`
  try {
    const sqlite3 = await loadSqlite3Wasm()
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const make = yield* sqliteDbFactory({ sqlite3 })
          yield* Effect.acquireRelease(make({ _tag: 'fs', directory, fileName: sourceName }), (db) =>
            Effect.sync(() => db.close()),
          ).pipe(
            Effect.tap((db) =>
              Effect.sync(() => {
                db.execute('CREATE TABLE retained_raw (value TEXT)')
                db.execute("INSERT INTO retained_raw VALUES ('keep')")
              }),
            ),
          )
        }),
      ).pipe(Effect.provide(PlatformNode.NodeFileSystem.layer)),
    )
    const before = await fs.readFile(path.join(directory, sourceName))
    await expect(
      Effect.runPromise(
        Effect.scoped(
          createStore({
            schema,
            storeId: 'replica',
            disableDevtools: true,
            adapter: makeAdapter({ storage: { type: 'fs', baseDirectory: base }, clientId: 'stable' }),
          }),
        ).pipe(provideOtel({}), Effect.provide(PlatformNode.NodeFileSystem.layer)),
      ),
    ).rejects.toThrow()
    expect((await fs.readdir(directory)).filter((name) => name.startsWith('state'))).toEqual([])
    expect(await fs.readFile(path.join(directory, sourceName))).toEqual(before)
  } finally {
    await fs.rm(base, { recursive: true, force: true })
  }
})

test.each(['in-memory', 'fs'] as const)(
  'actual %s SOURCE admission closes its owner and invalidates proof',
  async (type) => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'source-owner-'))
    let owner: SourceOwner | undefined
    let proof: InitializedSource | undefined
    try {
      const sqlite3 = await loadSqlite3Wasm()
      const storage: NodeStorage = type === 'fs' ? { type, baseDirectory: base } : { type }
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const make = yield* sqliteDbFactory({ sqlite3 })
            const opened = yield* openDatabases({ schema, storeId: 'replica' }, storage, make)
            owner = opened.dbEventlog
            proof = opened.initializedSource
            const identity = yield* assertInitialized(owner.handle, opened.initializedSource)
            expect(identity.incarnation.length).toBeGreaterThan(0)
            expect(owner.fresh).toBeDefined()
            expect(owner.image).toBeDefined()
          }),
        ).pipe(Effect.provide(PlatformNode.NodeFileSystem.layer)),
      )
      if (owner === undefined || proof === undefined) throw new Error('No SOURCE owner/proof returned')
      expect((await Effect.runPromiseExit(assertInitialized(owner.handle, proof)))._tag).toBe('Failure')
      expect((await Effect.runPromiseExit(owner.handle.select('SELECT 1')))._tag).toBe('Failure')
      if (type === 'fs') {
        await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const make = yield* sqliteDbFactory({ sqlite3 })
              const retained = yield* openDatabases({ schema, storeId: 'replica' }, storage, make)
              expect(retained.dbEventlog.fresh).toBeUndefined()
              yield* assertInitialized(retained.dbEventlog.handle, retained.initializedSource)
            }),
          ).pipe(Effect.provide(PlatformNode.NodeFileSystem.layer)),
        )
      }
    } finally {
      await fs.rm(base, { recursive: true, force: true })
    }
  },
)
