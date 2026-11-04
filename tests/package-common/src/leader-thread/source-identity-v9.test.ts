import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { expect, test } from 'vitest'

import { eventlogSystemTables, LegacyStorageFormatError, SOURCE_IDENTITY_TABLE, type SqliteDb } from '@livestore/common'
import { configureConnection } from '@livestore/common/leader-thread'
import {
  assertInitialized,
  fromSyncSource,
  initializeSource,
  SourceIdentity,
  type SourceOwner,
} from '@livestore/common/source-db'
import { loadSqlite3Wasm } from '@livestore/sqlite-wasm/load-wasm'
import { reserveNodeSource, sqliteDbFactory } from '@livestore/sqlite-wasm/node'
import { Cause, Effect, Exit, Option } from '@livestore/utils/effect'
import { PlatformNode } from '@livestore/utils/node'

type Observer = (sql: string, run: () => void) => void
type OpenedSource = { native: SqliteDb; owner: SourceOwner; observe: (observer: Observer) => void }
type SourceFile = {
  open: () => Promise<OpenedSource>
  close: (source: OpenedSource) => Promise<void>
  bytes: () => Promise<Uint8Array>
}

const sourceTest = (name: string, body: (file: SourceFile) => Promise<void>) =>
  test(name, async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'livestore-source-v9-'))
    const opened = new Set<OpenedSource>()
    let first = true
    try {
      const sqlite3 = await loadSqlite3Wasm()
      const make = await Effect.runPromise(
        sqliteDbFactory({ sqlite3 }).pipe(Effect.provide(PlatformNode.NodeFileSystem.layer)),
      )
      await body({
        open: async () => {
          const sourceCreation = first === false ? undefined : reserveNodeSource(path.join(directory, 'eventlog.db'))
          first = false
          const native = await Effect.runPromise(
            make({
              _tag: 'fs',
              directory,
              fileName: 'eventlog.db',
              create: false,
              ...(sourceCreation === undefined ? {} : { sourceCreation }),
              configureDb: (db) => Effect.runSync(configureConnection(db, { foreignKeys: true })),
            }),
          )
          let observer: Observer = (_sql, run) => run()
          // Observe the real engine under the same owner, without replacing SQL or its transaction semantics.
          const observed = new Proxy(native, {
            get: (target, property, receiver) =>
              property === 'execute'
                ? (...args: unknown[]) =>
                    observer(String(args[0]).trim(), () => Reflect.apply(target.execute, target, args))
                : Reflect.get(target, property, receiver),
          })
          const owner = await Effect.runPromise(fromSyncSource(observed, native.metadata.sourceCreation))
          const source = {
            native,
            owner,
            observe: (next: Observer) => {
              observer = next
            },
          }
          opened.add(source)
          return source
        },
        close: async (source) => {
          await Effect.runPromise(source.owner.close)
          opened.delete(source)
        },
        bytes: async () => new Uint8Array(await readFile(path.join(directory, 'eventlog.db'))),
      })
    } finally {
      for (const source of opened) await Effect.runPromise(source.owner.close)
      await rm(directory, { recursive: true, force: true })
    }
  })

const initialize = (source: OpenedSource) => initializeSource(source.owner).pipe(Effect.map((proof) => proof.identity))
const read = (source: OpenedSource) => Effect.runPromise(SourceIdentity.read(source.owner.handle))
const snapshot = ({ native }: OpenedSource) => {
  const schema = native.select<{ name: string; sql: string | null }>(
    "SELECT name, sql FROM sqlite_master WHERE type = 'table' ORDER BY name",
  )
  return {
    schema,
    rows: schema.map(({ name }) => ({
      name,
      rows: native.select(`SELECT * FROM "${name.replaceAll('"', '""')}" ORDER BY rowid`),
    })),
    bytes: Uint8Array.from(native.export()),
  }
}
const expectReadOnlyRefusal = async (source: OpenedSource, file: SourceFile) => {
  const before = snapshot(source),
    fileBytes = await file.bytes(),
    executed: string[] = []
  const observe: Observer = (sql, run) => {
    executed.push(sql)
    run()
  }
  source.observe(observe)
  const readExit = await Effect.runPromiseExit(SourceIdentity.read(source.owner.handle))
  expect(snapshot(source)).toEqual(before)
  expect(await file.bytes()).toEqual(fileBytes)
  // A persisted-invariant refusal may fence its owner; re-open rather than reuse that failed capability.
  await file.close(source)
  const validation = await file.open()
  validation.observe(observe)
  const exit = await Effect.runPromiseExit(initialize(validation))
  expect(executed).toEqual([])
  expect(snapshot(validation)).toEqual(before)
  expect(await file.bytes()).toEqual(fileBytes)
  for (const refusal of [readExit, exit]) {
    expect(Exit.isFailure(refusal)).toBe(true)
    if (Exit.isFailure(refusal) === true) {
      const failure = Cause.findErrorOption(refusal.cause)
      expect(Option.isSome(failure)).toBe(true)
      if (Option.isSome(failure) === true)
        expect(failure.value).toMatchObject({ cause: expect.any(LegacyStorageFormatError) })
    }
  }
}

const seedSourceFacts = ({ native }: OpenedSource) => {
  native.execute(`INSERT INTO eventlog (
    seqNumGlobal, seqNumClient, seqNumRebaseGeneration,
    parentSeqNumGlobal, parentSeqNumClient, parentSeqNumRebaseGeneration,
    name, argsJson, clientId, sessionId, schemaHash, syncMetadataJson
  ) VALUES (23, 0, 0, 0, 0, 0, 'retained-event', '{"id":"one"}', 'client', 'session', 11, 'null')`)
  native.execute("UPDATE __livestore_sync_status SET head = 23, backendId = 'retained-backend'")
}

sourceTest('exclusive fresh SOURCE atomically creates every format-7 table and one identity proof', async (file) => {
  const source = await file.open()
  let observedProof = false
  source.observe((sql, run) => {
    if (sql.startsWith(`INSERT INTO ${SOURCE_IDENTITY_TABLE}`) === true) {
      const tables = source.native.select<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
      expect(tables.map(({ name }) => name).sort()).toEqual(
        eventlogSystemTables.map((table) => table.sqliteDef.name).sort(),
      )
      expect(source.native.select(`SELECT * FROM ${SOURCE_IDENTITY_TABLE}`)).toEqual([])
      observedProof = true
    }
    run()
  })
  const identity = await Effect.runPromise(initialize(source))
  expect(observedProof).toBe(true)
  expect(identity.formatVersion).toBe(7)
  expect(identity.incarnation.trim().length).toBeGreaterThan(0)
  expect(await read(source)).toEqual(identity)
  expect(source.native.select(`SELECT * FROM ${SOURCE_IDENTITY_TABLE}`)).toEqual([{ id: 1, ...identity }])
  expect(source.native.select('SELECT * FROM __livestore_sync_status')).toEqual([{ head: 0, backendId: null }])
  await file.close(source)
  expect(await read(await file.open())).toEqual(identity)
})

sourceTest(
  'retained format-7 SOURCE validates without writes and preserves identity, events and backend facts',
  async (file) => {
    const source = await file.open(),
      identity = await Effect.runPromise(initialize(source))
    seedSourceFacts(source)
    const before = snapshot(source)
    await file.close(source)
    const reopened = await file.open(),
      bytes = await file.bytes(),
      executed: string[] = []
    reopened.observe((sql, run) => {
      executed.push(sql)
      run()
    })
    expect(await read(reopened)).toEqual(identity)
    expect(await Effect.runPromise(initialize(reopened))).toEqual(identity)
    expect(executed).toEqual([])
    expect(snapshot(reopened)).toEqual(before)
    expect(await file.bytes()).toEqual(bytes)
  },
)

sourceTest('a spent creation capability cannot replace a nonempty valid SOURCE', async (file) => {
  const source = await file.open(),
    identity = await Effect.runPromise(initialize(source))
  seedSourceFacts(source)
  const before = snapshot(source),
    bytes = await file.bytes(),
    executed: string[] = []
  source.observe((sql, run) => {
    executed.push(sql)
    run()
  })
  expect(Exit.isFailure(await Effect.runPromiseExit(initialize(source)))).toBe(true)
  expect(executed).toEqual([])
  expect(await read(source)).toEqual(identity)
  expect(snapshot(source)).toEqual(before)
  expect(await file.bytes()).toEqual(bytes)
})

sourceTest('retained arbitrary nonempty SOURCE refuses without writes', async (file) => {
  const source = await file.open()
  source.native.execute('CREATE TABLE retained (id INTEGER PRIMARY KEY, value TEXT)')
  source.native.execute("INSERT INTO retained VALUES (1, 'keep me')")
  await file.close(source)
  await expectReadOnlyRefusal(await file.open(), file)
})
sourceTest('retained tableless SOURCE refuses without writes', async (file) => {
  await file.close(await file.open())
  await expectReadOnlyRefusal(await file.open(), file)
})
sourceTest('format-6 SOURCE without identity preserves retained rows and bytes on refusal', async (file) => {
  const source = await file.open()
  await Effect.runPromise(initialize(source))
  seedSourceFacts(source)
  source.native.execute(`DROP TABLE ${SOURCE_IDENTITY_TABLE}`)
  await file.close(source)
  await expectReadOnlyRefusal(await file.open(), file)
})

for (const stage of ['before-proof', 'after-proof-before-commit'] as const)
  sourceTest(`failed initialization ${stage} fences and later retained open refuses to reset it`, async (file) => {
    const source = await file.open(),
      before = snapshot(source),
      bytes = await file.bytes()
    let injected = false
    source.observe((sql, run) => {
      const stop = stage === 'before-proof' ? sql.startsWith(`INSERT INTO ${SOURCE_IDENTITY_TABLE}`) : sql === 'COMMIT'
      if (stop === true) {
        injected = true
        if (stage === 'after-proof-before-commit')
          expect(source.native.select(`SELECT * FROM ${SOURCE_IDENTITY_TABLE}`)).toHaveLength(1)
        throw new Error(`Injected ${stage}`)
      }
      run()
    })
    expect(Exit.isFailure(await Effect.runPromiseExit(initialize(source)))).toBe(true)
    expect(injected).toBe(true)
    expect(Exit.isFailure(await Effect.runPromiseExit(source.owner.handle.select('SELECT 1')))).toBe(true)
    if (stage === 'before-proof') expect(snapshot(source)).toEqual(before)
    expect(await file.bytes()).toEqual(bytes)
    // Rejected COMMIT is uncertain: the owner fences, and native close settles any still-open transaction.
    await file.close(source)
    const reopened = await file.open()
    expect(snapshot(reopened)).toEqual(before)
    await expectReadOnlyRefusal(reopened, file)
  })

sourceTest(
  'COMMIT succeeding before lost acknowledgement retains proof and later validates read-only',
  async (file) => {
    const source = await file.open()
    let committedIdentity: { formatVersion: number; incarnation: string } | undefined
    source.observe((sql, run) => {
      run()
      if (sql === 'COMMIT') {
        committedIdentity = source.native.select<{ formatVersion: number; incarnation: string }>(
          `SELECT formatVersion, incarnation FROM ${SOURCE_IDENTITY_TABLE}`,
        )[0]
        throw new Error('Injected lost COMMIT acknowledgement')
      }
    })
    expect(Exit.isFailure(await Effect.runPromiseExit(initialize(source)))).toBe(true)
    expect(committedIdentity?.formatVersion).toBe(7)
    expect(Exit.isFailure(await Effect.runPromiseExit(source.owner.handle.select('SELECT 1')))).toBe(true)
    await file.close(source)
    const retained = await file.open()
    seedSourceFacts(retained)
    const before = snapshot(retained)
    await file.close(retained)
    const reopened = await file.open(),
      executed: string[] = [],
      bytes = await file.bytes()
    reopened.observe((sql, run) => {
      executed.push(sql)
      run()
    })
    expect(await Effect.runPromise(initialize(reopened))).toEqual(committedIdentity)
    expect(executed).toEqual([])
    expect(snapshot(reopened)).toEqual(before)
    expect(await file.bytes()).toEqual(bytes)
  },
)

for (const [name, corrupt] of [
  ['missing proof row', `DELETE FROM ${SOURCE_IDENTITY_TABLE}`],
  [
    'extra proof row',
    `INSERT INTO ${SOURCE_IDENTITY_TABLE} SELECT 2, formatVersion, incarnation FROM ${SOURCE_IDENTITY_TABLE}`,
  ],
  ['wrong proof id', `UPDATE ${SOURCE_IDENTITY_TABLE} SET id = 2`],
  ['old format proof', `UPDATE ${SOURCE_IDENTITY_TABLE} SET formatVersion = 6`],
  ['blank incarnation', `UPDATE ${SOURCE_IDENTITY_TABLE} SET incarnation = '   '`],
  [
    'partial proof table',
    `DROP TABLE ${SOURCE_IDENTITY_TABLE}; CREATE TABLE ${SOURCE_IDENTITY_TABLE} (id INTEGER PRIMARY KEY)`,
  ],
] as const)
  sourceTest(`${name} refuses read-only and preserves SOURCE bytes`, async (file) => {
    const source = await file.open()
    await Effect.runPromise(initialize(source))
    seedSourceFacts(source)
    for (const statement of corrupt.split(';')) source.native.execute(statement)
    await file.close(source)
    await expectReadOnlyRefusal(await file.open(), file)
  })

sourceTest('initialization proof binds the exact owner and cannot be copied', async (file) => {
  const source = await file.open(),
    initialized = await Effect.runPromise(initializeSource(source.owner)),
    before = snapshot(source)
  expect(await Effect.runPromise(assertInitialized(source.owner.handle, initialized))).toEqual(initialized.identity)
  expect(Exit.isFailure(await Effect.runPromiseExit(assertInitialized(source.owner.handle, { ...initialized })))).toBe(
    true,
  )
  expect(snapshot(source)).toEqual(before)
  // A real handoff preserves durable identity, but the new physical owner must not inherit its predecessor's proof.
  await file.close(source)
  const foreign = await file.open()
  const foreignInitialized = await Effect.runPromise(initializeSource(foreign.owner))
  expect(foreignInitialized.identity).toEqual(initialized.identity)
  expect(await Effect.runPromise(assertInitialized(foreign.owner.handle, foreignInitialized))).toEqual(
    initialized.identity,
  )
  expect(Exit.isFailure(await Effect.runPromiseExit(assertInitialized(foreign.owner.handle, initialized)))).toBe(true)
  expect(snapshot(foreign)).toEqual(before)
})
sourceTest('SOURCE rotation invalidates the issued initialization proof without further modification', async (file) => {
  const source = await file.open(),
    initialized = await Effect.runPromise(initializeSource(source.owner))
  const rotated = await Effect.runPromise(source.owner.write(SourceIdentity.rotate))
  expect(rotated.incarnation).not.toBe(initialized.identity.incarnation)
  const before = snapshot(source)
  expect(Exit.isFailure(await Effect.runPromiseExit(assertInitialized(source.owner.handle, initialized)))).toBe(true)
  expect(snapshot(source)).toEqual(before)
})
