import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { expect, test } from 'vitest'

import { liveStoreStorageFormatVersion, provideOtel } from '@livestore/common'
import { makeSchema, State } from '@livestore/common/schema'
import { createStore } from '@livestore/livestore'
import { loadSqlite3Wasm } from '@livestore/sqlite-wasm/load-wasm'
import { sqliteDbFactory } from '@livestore/sqlite-wasm/node'
import { Effect } from '@livestore/utils/effect'
import { PlatformNode } from '@livestore/utils/node'

import { makeAdapter } from './index.ts'
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
