import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { expect, test } from 'vitest'

import {
  eventlogSystemTables,
  LegacyStorageFormatError,
  SOURCE_IDENTITY_TABLE,
  SourceIdentity,
  type SqliteDb,
} from '@livestore/common'
import { configureConnection, Eventlog } from '@livestore/common/leader-thread'
import { loadSqlite3Wasm } from '@livestore/sqlite-wasm/load-wasm'
import { sqliteDbFactory } from '@livestore/sqlite-wasm/node'
import { Cause, Effect, Exit, Option } from '@livestore/utils/effect'
import { PlatformNode } from '@livestore/utils/node'

type SourceFile = {
  open: () => Promise<SqliteDb>
  close: (db: SqliteDb) => void
  bytes: () => Promise<Uint8Array>
}

const sourceTest = (name: string, body: (file: SourceFile) => Promise<void>) =>
  test(name, async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'livestore-source-v9-'))
    const opened = new Set<SqliteDb>()
    try {
      const sqlite3 = await loadSqlite3Wasm()
      const makeSqliteDb = await Effect.runPromise(
        sqliteDbFactory({ sqlite3 }).pipe(Effect.provide(PlatformNode.NodeFileSystem.layer)),
      )
      await body({
        open: async () => {
          const db = await Effect.runPromise(
            makeSqliteDb({
              _tag: 'fs',
              directory,
              fileName: 'eventlog.db',
              // Factory configuration precedes every write/refusal observer below.
              configureDb: (db) => Effect.runSync(configureConnection(db, { foreignKeys: true })),
            }),
          )
          opened.add(db)
          return db
        },
        close: (db) => {
          db.close()
          opened.delete(db)
        },
        bytes: async () => new Uint8Array(await readFile(path.join(directory, 'eventlog.db'))),
      })
    } finally {
      for (const db of opened) db.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

const initialize = (db: SqliteDb, sourceIsNew: boolean) => Eventlog.initEventlogDb(db, { sourceIsNew })

const snapshot = (db: SqliteDb) => {
  const schema = db.select<{ name: string; sql: string | null }>(
    "SELECT name, sql FROM sqlite_master WHERE type = 'table' ORDER BY name",
  )
  return {
    schema,
    rows: schema.map(({ name }) => ({
      name,
      rows: db.select(`SELECT * FROM "${name.replaceAll('"', '""')}" ORDER BY rowid`),
    })),
    bytes: Uint8Array.from(db.export()),
  }
}

/** Observe the real connection without replacing its SQL engine or its transaction semantics. */
const observeExecute = (db: SqliteDb, execute: (sql: string, run: () => void) => void) =>
  new Proxy(db, {
    get: (target, property, receiver) =>
      property === 'execute'
        ? (...args: unknown[]) => execute(String(args[0]).trim(), () => Reflect.apply(target.execute, target, args))
        : Reflect.get(target, property, receiver),
  })

const expectReadOnlyRefusal = async (db: SqliteDb, sourceIsNew: boolean, file: SourceFile) => {
  const before = snapshot(db)
  const fileBytes = await file.bytes()
  const executed: string[] = []
  const observed = observeExecute(db, (sql, run) => {
    executed.push(sql)
    run()
  })
  let readError: unknown
  try {
    SourceIdentity.read(observed)
  } catch (error) {
    readError = error
  }
  const exit = await Effect.runPromiseExit(initialize(observed, sourceIsNew))
  // Check preservation before error classification so malformed-proof diagnostics cannot hide writes.
  expect(executed).toEqual([])
  expect(snapshot(db)).toEqual(before)
  expect(await file.bytes()).toEqual(fileBytes)
  expect(readError).toBeInstanceOf(LegacyStorageFormatError)
  expect(Exit.isFailure(exit)).toBe(true)
  if (Exit.isFailure(exit) === true) {
    const failure = Cause.findErrorOption(exit.cause)
    expect(Option.isSome(failure)).toBe(true)
    if (Option.isSome(failure) === true) expect(failure.value).toBeInstanceOf(LegacyStorageFormatError)
  }
}

const seedSourceFacts = (db: SqliteDb) => {
  db.execute(`INSERT INTO eventlog (
    seqNumGlobal, seqNumClient, seqNumRebaseGeneration,
    parentSeqNumGlobal, parentSeqNumClient, parentSeqNumRebaseGeneration,
    name, argsJson, clientId, sessionId, schemaHash, syncMetadataJson
  ) VALUES (23, 0, 0, 0, 0, 0, 'retained-event', '{"id":"one"}', 'client', 'session', 11, 'null')`)
  db.execute("UPDATE __livestore_sync_status SET head = 23, backendId = 'retained-backend'")
}

sourceTest('fresh empty source atomically creates every format-7 table and one identity proof', async (file) => {
  const db = await file.open()
  let observedProof = false
  const observed = observeExecute(db, (sql, run) => {
    if (sql.startsWith(`INSERT INTO ${SOURCE_IDENTITY_TABLE}`) === true) {
      const tables = db.select<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
      expect(tables.map(({ name }) => name).sort()).toEqual(
        eventlogSystemTables.map((table) => table.sqliteDef.name).sort(),
      )
      expect(db.select(`SELECT * FROM ${SOURCE_IDENTITY_TABLE}`)).toEqual([])
      observedProof = true
    }
    run()
  })
  const identity = await Effect.runPromise(initialize(observed, true))
  expect(observedProof).toBe(true)
  expect(identity.formatVersion).toBe(7)
  expect(identity.incarnation.trim().length).toBeGreaterThan(0)
  expect(SourceIdentity.read(db)).toEqual(identity)
  expect(db.select(`SELECT * FROM ${SOURCE_IDENTITY_TABLE}`)).toEqual([{ id: 1, ...identity }])
  expect(db.select('SELECT * FROM __livestore_sync_status')).toEqual([{ head: 0, backendId: null }])
  file.close(db)
  const reopened = await file.open()
  expect(SourceIdentity.read(reopened)).toEqual(identity)
})

sourceTest(
  'existing format-7 source validates without writes and preserves identity, events and backend facts',
  async (file) => {
    const db = await file.open()
    const identity = await Effect.runPromise(initialize(db, true))
    seedSourceFacts(db)
    const before = snapshot(db)
    file.close(db)
    const reopened = await file.open()
    const fileBytes = await file.bytes()
    const executed: string[] = []
    const observed = observeExecute(reopened, (sql, run) => {
      executed.push(sql)
      run()
    })
    expect(SourceIdentity.read(observed)).toEqual(identity)
    expect(await Effect.runPromise(initialize(observed, false))).toEqual(identity)
    expect(executed).toEqual([])
    expect(snapshot(reopened)).toEqual(before)
    expect(await file.bytes()).toEqual(fileBytes)
  },
)

sourceTest('sourceIsNew cannot authorize replacing a nonempty valid format-7 source', async (file) => {
  const db = await file.open()
  const identity = await Effect.runPromise(initialize(db, true))
  seedSourceFacts(db)
  const before = snapshot(db)
  const bytes = await file.bytes()
  const executed: string[] = []
  const observed = observeExecute(db, (sql, run) => {
    executed.push(sql)
    run()
  })
  const exit = await Effect.runPromiseExit(initialize(observed, true))
  expect(Exit.isFailure(exit)).toBe(true)
  expect(executed).toEqual([])
  expect(SourceIdentity.read(db)).toEqual(identity)
  expect(snapshot(db)).toEqual(before)
  expect(await file.bytes()).toEqual(bytes)
})

sourceTest('sourceIsNew refuses an arbitrary nonempty source without writes', async (file) => {
  const db = await file.open()
  db.execute('CREATE TABLE retained (id INTEGER PRIMARY KEY, value TEXT)')
  db.execute("INSERT INTO retained VALUES (1, 'keep me')")
  await expectReadOnlyRefusal(db, true, file)
})

sourceTest('existing tableless source is refused without writes', async (file) => {
  const db = await file.open()
  file.close(db)
  await expectReadOnlyRefusal(await file.open(), false, file)
})

sourceTest(
  'format-6 source tables without identity proof are refused without changing retained rows or bytes',
  async (file) => {
    const db = await file.open()
    await Effect.runPromise(initialize(db, true))
    seedSourceFacts(db)
    db.execute(`DROP TABLE ${SOURCE_IDENTITY_TABLE}`)
    file.close(db)
    await expectReadOnlyRefusal(await file.open(), false, file)
  },
)

for (const stage of ['before-proof', 'after-proof-before-commit'] as const) {
  sourceTest(
    `failed initialization ${stage} rolls back and a later existing-file open refuses to reset it`,
    async (file) => {
      const db = await file.open()
      const before = snapshot(db)
      const beforeBytes = await file.bytes()
      let injected = false
      const observed = observeExecute(db, (sql, run) => {
        const stop =
          stage === 'before-proof' ? sql.startsWith(`INSERT INTO ${SOURCE_IDENTITY_TABLE}`) : sql === 'COMMIT'
        if (stop === true) {
          injected = true
          if (stage === 'after-proof-before-commit') expect(SourceIdentity.read(db).formatVersion).toBe(7)
          throw new Error(`Injected ${stage}`)
        }
        run()
      })
      const exit = await Effect.runPromiseExit(initialize(observed, true))
      expect(injected).toBe(true)
      expect(Exit.isFailure(exit)).toBe(true)
      expect(snapshot(db)).toEqual(before)
      expect(await file.bytes()).toEqual(beforeBytes)
      file.close(db)
      await expectReadOnlyRefusal(await file.open(), false, file)
    },
  )
}

sourceTest(
  'COMMIT that succeeds before throwing retains its proof and later existing-file validation succeeds',
  async (file) => {
    const db = await file.open()
    let committedIdentity: ReturnType<typeof SourceIdentity.read> | undefined
    const observed = observeExecute(db, (sql, run) => {
      run()
      if (sql === 'COMMIT') {
        committedIdentity = SourceIdentity.read(db)
        throw new Error('Injected lost COMMIT acknowledgement')
      }
    })
    const exit = await Effect.runPromiseExit(initialize(observed, true))
    expect(Exit.isFailure(exit)).toBe(true)
    expect(committedIdentity?.formatVersion).toBe(7)
    seedSourceFacts(db)
    const before = snapshot(db)
    file.close(db)
    const reopened = await file.open()
    const executed: string[] = []
    const bytes = await file.bytes()
    const readOnly = observeExecute(reopened, (sql, run) => {
      executed.push(sql)
      run()
    })
    expect(await Effect.runPromise(initialize(readOnly, false))).toEqual(committedIdentity)
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
] as const) {
  sourceTest(`${name} is refused read-only and preserves its source bytes`, async (file) => {
    const db = await file.open()
    await Effect.runPromise(initialize(db, true))
    seedSourceFacts(db)
    for (const statement of corrupt.split(';')) db.execute(statement)
    file.close(db)
    await expectReadOnlyRefusal(await file.open(), false, file)
  })
}

sourceTest('initialization context is bound to the exact database and cannot be copied', async (file) => {
  const source = await file.open()
  const initialized = await Effect.runPromise(Eventlog.initializeSource(source, { sourceIsNew: true }))
  const before = snapshot(source)
  expect(SourceIdentity.assertInitialized(source, initialized)).toEqual(initialized.identity)
  const otherHandle = await file.open()
  expect(() => SourceIdentity.assertInitialized(otherHandle, initialized)).toThrow(LegacyStorageFormatError)
  expect(() => SourceIdentity.assertInitialized(source, { ...initialized })).toThrow(LegacyStorageFormatError)
  expect(snapshot(source)).toEqual(before)
})

sourceTest('source rotation invalidates an issued initialization context without modifying source', async (file) => {
  const source = await file.open()
  const initialized = await Effect.runPromise(Eventlog.initializeSource(source, { sourceIsNew: true }))
  source.execute('BEGIN IMMEDIATE')
  const rotated = SourceIdentity.rotateWithinTransaction(source)
  source.execute('COMMIT')
  expect(rotated.incarnation).not.toBe(initialized.identity.incarnation)
  const before = snapshot(source)
  expect(() => SourceIdentity.assertInitialized(source, initialized)).toThrow(LegacyStorageFormatError)
  expect(snapshot(source)).toEqual(before)
})
