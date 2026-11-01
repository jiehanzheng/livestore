import { DurableObject } from 'cloudflare:workers'

import {
  EventlogSqliteDb,
  MaterializationJournal,
  migrateTable,
  SourceIdentity,
  StateHead,
  StateSnapshot,
  StateSqliteDb,
  stateSystemTables,
} from '@livestore/common'
import { Eventlog, LeaderPersistence, makeMaterializeEvent } from '@livestore/common/leader-thread'
import { Events, makeSchema, State } from '@livestore/common/schema'
import { CF_SQL_VFS_REQUIRED_PRAGMAS, sqliteDbFactory } from '@livestore/sqlite-wasm/cf'
import { loadSqlite3Wasm } from '@livestore/sqlite-wasm/load-wasm'
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Option, Schema, Scope } from '@livestore/utils/effect'

import { makeSqliteDb_ } from '../make-sqlite-db.ts'
import { makeTransactionHost } from '../transaction-host.ts'

const projectionTable = State.SQLite.table({
  name: 'projection_value',
  columns: {
    id: State.SQLite.text({ primaryKey: true }),
    value: State.SQLite.text(),
  },
})
const created = Events.clientOnly({ name: 'Created', schema: Schema.Struct({ id: Schema.String }) })
const schema = makeSchema({
  projectionRevision: 'cf-host-confirmation-v1',
  events: { created },
  state: State.SQLite.makeState({
    tables: { projectionTable },
    materializers: { Created: ({ id }) => projectionTable.insert({ id, value: 'old' }) },
  }),
})
const fileName = 'state-v9-host.db'
const fullHead = { global: 23, client: 0, rebaseGeneration: 2 }

export class WasmHostProbe extends DurableObject {
  instanceId = crypto.randomUUID()
  state
  sqlite3
  native
  depth = 0
  transactions = 0
  outsideWrites = []
  closeEvidence = []
  loseNextAck = false
  confirmations = 0
  closeCalls = 0
  failNextClose = false
  rollbackPause
  constructor(ctx, env) {
    super(ctx, env)
    this.stage('constructor')
    const sql = new Proxy(ctx.storage.sql, {
      get: (target, property) => {
        if (property === 'exec')
          return (statement, ...bindings) => {
            if (/^\s*(?:INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER)/i.test(statement) === true && this.depth === 0)
              this.outsideWrites.push(statement)
            return target.exec(statement, ...bindings)
          }
        const value = Reflect.get(target, property, target)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    this.storageView = new Proxy(ctx.storage, {
      get: (target, property) => {
        if (property === 'sql') return sql
        if (property === 'transaction')
          return async (callback) => {
            this.transactions++
            return await target.transaction(async (transaction) => {
              this.depth++
              try {
                return await callback(transaction)
              } catch (error) {
                if (this.rollbackPause !== undefined) {
                  this.rollbackPause.entered.resolve()
                  await this.rollbackPause.release.promise
                }
                throw error
              } finally {
                this.depth--
              }
            })
          }
        if (property === 'sync')
          return async () => {
            await target.sync()
            this.confirmations++
            if (this.loseNextAck === true) {
              this.loseNextAck = false
              throw new Error('injected-confirmed-host-ack-loss')
            }
          }
        const value = Reflect.get(target, property, target)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    this.host = makeTransactionHost(this.storageView, () => {
      this.closeCalls++
      if (this.failNextClose === true) throw new Error('injected-state-close-failure')
      if (this.state === undefined) return
      const before = this.pages()
      const outsideBefore = this.outsideWrites.length
      const advanced = this.stateFacts()
      this.state.close()
      this.state = undefined
      this.closeEvidence.push({
        before,
        after: this.pages(),
        outsideWrites: this.outsideWrites.slice(outsideBefore),
        advanced,
      })
    })
    this.native = makeSqliteDb_({
      sqlStorage: sql,
      metadata: { persistenceInfo: { fileName: 'cf-native' }, configureDb: () => {} },
    })
    this.native.transactionHost = this.host
  }
  stage(stage) {
    console.log('CF_WASM_STAGE ' + JSON.stringify({ instanceId: this.instanceId, stage }))
  }
  pages() {
    return this.ctx.storage.sql
      .exec('SELECT file_path, page_no, hex(page_data) AS bytes FROM vfs_pages ORDER BY file_path, page_no')
      .toArray()
  }
  sourceFacts() {
    return {
      identity: SourceIdentity.read(this.native),
      events: this.native.select('SELECT * FROM eventlog ORDER BY seqNumGlobal, seqNumClient, seqNumRebaseGeneration'),
      sync: this.native.select('SELECT * FROM __livestore_sync_status'),
      head: Eventlog.getClientHeadFromDb(this.native),
    }
  }
  stateFacts() {
    return {
      values: this.state.select('SELECT * FROM projection_value ORDER BY id'),
      journal: this.state.select(
        'SELECT seqNumGlobal, seqNumClient, seqNumRebaseGeneration, hex(changeset) AS changeset FROM __livestore_materialization_journal',
      ),
      head: StateHead.readFromDb(this.state),
      proof: StateSnapshot.readProvenance(this.state),
    }
  }
  async openState() {
    this.sqlite3 ??= await loadSqlite3Wasm()
    this.state = await Effect.runPromise(
      sqliteDbFactory({ sqlite3: this.sqlite3 })({
        _tag: 'storage',
        storage: this.storageView,
        fileName,
        configureDb: (db) => db.execute(CF_SQL_VFS_REQUIRED_PRAGMAS.map((pragma) => 'PRAGMA ' + pragma).join(';\n')),
      }),
    )
    this.state.transactionHost = this.host
  }
  persistence() {
    const dbs = Layer.mergeAll(StateSqliteDb.layer(this.state), EventlogSqliteDb.layer(this.native))
    const services = Layer.mergeAll(StateHead.layer, MaterializationJournal.layer).pipe(Layer.provide(dbs))
    return Effect.gen(function* () {
      const materializeEvent = yield* makeMaterializeEvent({ schema })
      return yield* LeaderPersistence.make({ schema, materializeEvent })
    }).pipe(Effect.provide(Layer.merge(dbs, services)))
  }
  async setup() {
    await Effect.runPromise(Eventlog.initializeSource(this.native, { sourceIsNew: true }))
    await Effect.runPromise(
      this.host.runTransaction(
        Effect.gen({ self: this }, function* () {
          yield* Effect.promise(() => this.openState())
          for (const table of [...stateSystemTables, projectionTable]) {
            yield* migrateTable({
              db: this.state,
              behaviour: 'create-if-not-exists',
              tableAst: table.sqliteDef.ast,
              skipMetaTable: true,
            })
          }
          this.native
            .execute(`INSERT INTO eventlog (seqNumGlobal,seqNumClient,seqNumRebaseGeneration,parentSeqNumGlobal,parentSeqNumClient,parentSeqNumRebaseGeneration,name,argsJson,clientId,sessionId,schemaHash,syncMetadataJson)
        VALUES (23,0,2,0,0,0,'Created','{"id":"one"}','client','session',1,'{"_tag":"None"}')`)
          this.native.execute("UPDATE __livestore_sync_status SET head = 23, backendId = 'retained-backend'")
          this.state.execute("INSERT INTO projection_value VALUES ('one', 'old')")
          this.state.execute('INSERT INTO __livestore_state_head VALUES (1,23,0,2)')
          this.state.execute('INSERT INTO __livestore_materialization_journal VALUES (23,0,2,NULL)')
          StateSnapshot.writeProvenance(this.state, {
            proofVersion: 1,
            ownerId: this.instanceId,
            transitionId: 'old-completed',
            sourceIncarnation: SourceIdentity.read(this.native).incarnation,
            projection: StateSnapshot.getProjectionIdentity(schema),
          })
        }),
      ),
    )
  }
  async fetch(request) {
    const operation = new URL(request.url).pathname.slice(1)
    if (operation === 'cancellation-settlement') {
      const deferred = () => {
        let resolve
        const promise = new Promise((complete) => {
          resolve = complete
        })
        return { promise, resolve }
      }
      this.rollbackPause = { entered: deferred(), release: deferred() }
      const result = await Effect.runPromise(
        Effect.scoped(
          Effect.gen({ self: this }, function* () {
            const scope = yield* Scope.Scope
            const entered = yield* Deferred.make()
            const target = yield* this.host
              .runTransaction(
                Effect.gen({ self: this }, function* () {
                  this.native.execute('CREATE TABLE cancelled_control (id INTEGER PRIMARY KEY)')
                  this.native.execute('INSERT INTO cancelled_control VALUES (1)')
                  yield* Deferred.succeed(entered, undefined)
                  yield* Effect.never
                }),
              )
              .pipe(Effect.forkIn(scope))
            yield* Deferred.await(entered)
            let interruptSettled = false
            const interruption = yield* Fiber.interrupt(target).pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  interruptSettled = true
                }),
              ),
              Effect.forkIn(scope),
            )
            yield* Effect.addFinalizer(() => Effect.sync(() => this.rollbackPause.release.resolve()))
            yield* Effect.promise(() => this.rollbackPause.entered.promise)
            const during = { interruptSettled, closeCalls: this.closeCalls }
            this.rollbackPause.release.resolve()
            yield* Fiber.join(interruption)
            const transactions = this.transactions
            const fenced = yield* Effect.exit(this.host.runTransaction(Effect.void))
            return {
              during,
              closeCalls: this.closeCalls,
              fenced: Exit.isFailure(fenced),
              reusedHost: this.transactions !== transactions,
              tables: this.native.select("SELECT name FROM sqlite_master WHERE name='cancelled_control'"),
            }
          }),
        ).pipe(Effect.ensuring(Effect.sync(() => this.rollbackPause.release.resolve()))),
      )
      return Response.json(result)
    }
    if (operation === 'host-ownership') {
      const result = await Effect.runPromise(
        Effect.scoped(
          Effect.gen({ self: this }, function* () {
            const scope = yield* Scope.Scope
            const attempted = yield* Deferred.make()
            const lateRelease = yield* Deferred.make()
            let childRan = false
            let lateRan = false
            let child
            let late
            let inside
            yield* this.host.runTransaction(
              Effect.gen({ self: this }, function* () {
                // The child inherits the frame while it is active, but must wait for the parent's host confirmation.
                child = yield* Effect.gen({ self: this }, function* () {
                  yield* Deferred.succeed(attempted, undefined)
                  return yield* this.host.runTransaction(
                    Effect.sync(() => {
                      childRan = true
                      return this.confirmations
                    }),
                  )
                }).pipe(Effect.forkIn(scope))
                late = yield* Effect.gen({ self: this }, function* () {
                  yield* Deferred.await(lateRelease)
                  return yield* this.host.runTransaction(
                    Effect.sync(() => {
                      lateRan = true
                      return this.confirmations
                    }),
                  )
                }).pipe(Effect.forkIn(scope))
                yield* Deferred.await(attempted)
                const nested = yield* this.host.runTransaction(Effect.succeed('same-fiber-nested'))
                inside = { childRan, lateRan, nested, transactions: this.transactions }
              }),
            )
            const childConfirmation = yield* Fiber.join(child)
            yield* Deferred.succeed(lateRelease, undefined)
            const lateConfirmation = yield* Fiber.join(late)
            return {
              inside,
              childConfirmation,
              lateConfirmation,
              transactions: this.transactions,
              confirmations: this.confirmations,
            }
          }),
        ),
      )
      return Response.json(result)
    }
    if (operation === 'nested-caught-failure') {
      const exit = await Effect.runPromiseExit(
        this.host.runTransaction(
          Effect.gen({ self: this }, function* () {
            this.native.execute('CREATE TABLE nested_control (id INTEGER PRIMARY KEY)')
            yield* this.host
              .runTransaction(
                Effect.gen({ self: this }, function* () {
                  this.native.execute('INSERT INTO nested_control VALUES (1)')
                  return yield* Effect.fail('nested-failure-caught-by-caller')
                }),
              )
              .pipe(Effect.catchCause(() => Effect.void))
            this.native.execute('INSERT INTO nested_control VALUES (2)')
          }),
        ),
      )
      const tables = this.native.select("SELECT name FROM sqlite_master WHERE name='nested_control'")
      return Response.json({ failed: Exit.isFailure(exit), tables, transactions: this.transactions })
    }
    if (operation === 'rollback' || operation === 'lost-ack' || operation === 'close-failure') {
      await this.setup()
      const before = { source: this.sourceFacts(), state: this.stateFacts(), pages: this.pages() }
      let tentative
      if (operation === 'lost-ack') this.loseNextAck = true
      if (operation === 'close-failure') this.failNextClose = true
      const exit = await Effect.runPromiseExit(
        this.host.runTransaction(
          Effect.gen({ self: this }, function* () {
            this.state.execute('BEGIN')
            this.native.execute(
              `UPDATE eventlog SET syncMetadataJson = '{"_tag":"Some","value":{"confirmed":true}}' WHERE seqNumGlobal = 23`,
            )
            this.state.execute('DELETE FROM __livestore_materialization_journal')
            const proof = StateSnapshot.readProvenance(this.state)
            StateSnapshot.writeProvenance(this.state, { ...proof, transitionId: 'confirmation-only-completed' })
            this.state.execute('COMMIT')
            tentative = this.stateFacts()
            this.stage('wasm-committed-before-host-resolution')
            if (operation !== 'lost-ack') return yield* Effect.fail('injected-outer-host-rollback')
          }),
        ),
      )
      const after = {
        source: this.sourceFacts(),
        pages: this.pages(),
        closeEvidence: this.closeEvidence,
        outsideWrites: this.outsideWrites,
        failed: Exit.isFailure(exit),
        stateRetained: this.state !== undefined,
        closeCalls: this.closeCalls,
        cause: Exit.isFailure(exit) === true ? Cause.pretty(exit.cause) : undefined,
      }
      const transactions = this.transactions
      const fenced = await Effect.runPromiseExit(this.host.runTransaction(Effect.void))
      await this.env.GATE.fetch('https://gate/wasm-result', {
        method: 'POST',
        body: JSON.stringify({
          instanceId: this.instanceId,
          operation,
          before,
          tentative,
          after,
          fenced: Exit.isFailure(fenced),
        }),
      })
      return Response.json({
        instanceId: this.instanceId,
        operation,
        before,
        tentative,
        after,
        fenced: Exit.isFailure(fenced),
        reusedHost: this.transactions !== transactions,
      })
    }
    if (operation === 'abort') {
      this.stage('explicit-abort')
      this.ctx.abort('new-owner-control')
    }
    if (operation === 'reopen') {
      await Effect.runPromise(Eventlog.initializeSource(this.native, { sourceIsNew: false }))
      let previous
      let admission
      await Effect.runPromise(
        this.host.runTransaction(
          Effect.gen({ self: this }, function* () {
            yield* Effect.promise(() => this.openState())
            previous = this.stateFacts()
            const persistence = yield* this.persistence()
            admission = yield* persistence.admitSnapshot({
              expectedProjection: StateSnapshot.getProjectionIdentity(schema),
              candidate: previous.proof,
            })
          }),
        ),
      )
      return Response.json({
        instanceId: this.instanceId,
        source: this.sourceFacts(),
        previous,
        current: this.stateFacts(),
        admission: { _tag: admission._tag, provenance: admission.provenance },
        outsideWrites: this.outsideWrites,
      })
    }
    if (operation === 'row-count') {
      this.ctx.storage.sql.exec('CREATE TABLE counts (id INTEGER PRIMARY KEY, value TEXT)')
      this.ctx.storage.sql.exec('CREATE INDEX counts_value ON counts(value)')
      const results = []
      for (const statement of [
        "INSERT INTO counts VALUES (1, 'a'), (2, 'b')",
        "UPDATE counts SET value = 'c'",
        "UPDATE counts SET value = 'd' RETURNING id",
        'DELETE FROM counts WHERE id = 1 RETURNING id',
        'DELETE FROM counts WHERE id = 2',
      ]) {
        let changed
        this.native.execute(statement, undefined, {
          onRowsChanged: (count) => {
            changed = count
          },
        })
        results.push(changed)
      }
      let unsupported
      try {
        this.native.execute('BEGIN IMMEDIATE')
      } catch (error) {
        unsupported = error._tag
      }
      return Response.json({ results, unsupported })
    }
    throw new Error('Unknown operation: ' + operation)
  }
}
export default {
  async fetch(request, env) {
    const [, name, operation] = new URL(request.url).pathname.split('/')
    return await env.OBJECTS.get(env.OBJECTS.idFromName(name)).fetch('https://object/' + operation)
  },
}
