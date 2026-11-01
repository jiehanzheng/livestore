import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { test } from 'node:test'

import { convertV4MiniflareOptions, Miniflare, Response } from 'miniflare'

const worker = String.raw`
import { DurableObject } from 'cloudflare:workers'
export class HostProbe extends DurableObject {
  order = []
  instanceId = crypto.randomUUID()
  constructor(ctx, env) { super(ctx, env); this.stage('constructor', 'created') }
  setupSourceState() {
    const sql = this.ctx.storage.sql
    sql.exec('CREATE TABLE source_events (id INTEGER PRIMARY KEY, value TEXT)')
    sql.exec('CREATE TABLE derived_state (id INTEGER PRIMARY KEY, value TEXT)')
    sql.exec('CREATE TABLE transition_marker (id INTEGER PRIMARY KEY, value TEXT)')
    sql.exec('CREATE TABLE parent (id INTEGER PRIMARY KEY)')
    sql.exec('CREATE TABLE child (id INTEGER PRIMARY KEY, parentId INTEGER REFERENCES parent(id) DEFERRABLE INITIALLY DEFERRED)')
    sql.exec("INSERT INTO source_events VALUES (1, 'old-event')")
    sql.exec("INSERT INTO derived_state VALUES (1, 'old-projection')")
    sql.exec("INSERT INTO transition_marker VALUES (1, 'committed-v1')")
  }
  sourceState() {
    const sql = this.ctx.storage.sql
    return {
      source: sql.exec('SELECT * FROM source_events ORDER BY id').toArray(),
      derived: sql.exec('SELECT * FROM derived_state ORDER BY id').toArray(),
      marker: sql.exec('SELECT * FROM transition_marker ORDER BY id').toArray(),
      child: sql.exec('SELECT * FROM child ORDER BY id').toArray(),
    }
  }
  tables() { return this.ctx.storage.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").toArray() }
  stage(operation, stage) { console.log('CFV9_STAGE ' + JSON.stringify({ operation, stage, instanceId: this.instanceId })) }
  rows() { return this.ctx.storage.sql.exec('SELECT id, value FROM probe ORDER BY id').toArray() }
  async fetch(request) {
    const operation = new URL(request.url).pathname.slice(1)
    const sql = this.ctx.storage.sql
    if (operation === 'origin') {
      const before = this.tables()
      await this.ctx.storage.get('missing')
      const afterGet = this.tables()
      const listed = [...await this.ctx.storage.list()]
      return Response.json({ before, afterGet, afterList: this.tables(), listed })
    }
    if (operation === 'existing-kv') {
      await this.ctx.storage.put('application-key', 'retained-value')
      const before = this.tables()
      const value = await this.ctx.storage.get('application-key')
      const listed = [...await this.ctx.storage.list()]
      return Response.json({ before, after: this.tables(), value, listed })
    }
    if (operation === 'read-state') {
      return Response.json({ instanceId: this.instanceId, state: this.sourceState(), kv: await this.ctx.storage.get('application-key') ?? null })
    }
    if (operation === 'abort-owner') {
      this.stage(operation, 'requested')
      this.ctx.abort('explicit-owner-reopen-control')
    }
    if (operation === 'sync-positive') {
      this.setupSourceState()
      await this.ctx.storage.sync()
      await this.ctx.storage.transaction(async () => {
        sql.exec("INSERT INTO source_events VALUES (2, 'healthy-event')")
        sql.exec("UPDATE derived_state SET value = 'healthy-projection'")
        sql.exec("UPDATE transition_marker SET value = 'committed-v2'")
        this.stage(operation, 'callback-returning')
      })
      this.stage(operation, 'transaction-resolved')
      this.stage(operation, 'sync-enter')
      await this.ctx.storage.sync()
      this.stage(operation, 'sync-resolved')
      await this.env.GATE.fetch('https://gate/sync-positive-confirmed')
      return Response.json({ instanceId: this.instanceId, state: this.sourceState(), confirmed: true })
    }
    if (operation === 'commit-failure' || operation === 'commit-failure-sync') {
      this.setupSourceState()
      await this.ctx.storage.sync()
      await this.env.GATE.fetch('https://gate/commit-old-source-confirmed', {
        method: 'POST', body: JSON.stringify({ instanceId: this.instanceId, state: this.sourceState() }),
      })
      let callbackReturned = false
      let hostResolved = false
      let error
      try {
        await this.ctx.storage.transaction(async () => {
          sql.exec("INSERT INTO source_events VALUES (2, 'tentative-event')")
          sql.exec("UPDATE derived_state SET value = 'tentative-projection'")
          sql.exec("UPDATE transition_marker SET value = 'uncommitted-v2'")
          sql.exec('INSERT INTO child VALUES (1, 999)')
          callbackReturned = true
          this.stage(operation, 'callback-returning')
          return 'callback-success'
        })
        hostResolved = true
        this.stage(operation, 'transaction-resolved')
        if (operation === 'commit-failure-sync') {
          this.stage(operation, 'sync-enter')
          await this.ctx.storage.sync()
          this.stage(operation, 'sync-resolved')
        }
        await this.env.GATE.fetch('https://gate/' + operation + '-host-resolved')
      } catch (cause) {
        error = cause.message
        this.stage(operation, 'caught:' + error)
      }
      return Response.json({ instanceId: this.instanceId, callbackReturned, hostResolved, error, state: this.sourceState() })
    }
    if (operation === 'commit-lost-ack') {
      sql.exec('CREATE TABLE committed (id INTEGER PRIMARY KEY, value TEXT)')
      let callbackReturned = false
      let hostCommitted = false
      let error
      const hostBoundary = async (callback) => {
        await this.ctx.storage.transaction(callback)
        this.stage(operation, 'transaction-resolved')
        await this.ctx.storage.sync()
        this.stage(operation, 'sync-resolved')
        await this.env.GATE.fetch('https://gate/lost-ack-confirmed')
        hostCommitted = true
        throw new Error('injected-host-acknowledgement-loss')
      }
      try {
        await hostBoundary(async () => {
          sql.exec("INSERT INTO committed VALUES (1, 'durable-source-proof')")
          callbackReturned = true
        })
      } catch (cause) { error = cause.message }
      return Response.json({ callbackReturned, hostCommitted, error, rows: sql.exec('SELECT * FROM committed').toArray() })
    }
    if (operation === 'rollback') {
      sql.exec('CREATE TABLE probe (id INTEGER PRIMARY KEY, value TEXT)')
      sql.exec("INSERT INTO probe VALUES (1, 'committed')")
      try {
        await this.ctx.storage.transaction(async () => {
          this.order.push('transaction-enter')
          sql.exec("INSERT INTO probe VALUES (2, 'tentative')")
          this.order.push('tentative-written')
          await this.env.GATE.fetch('https://gate/transaction-paused')
          this.order.push('transaction-resumed')
          throw new Error('rollback-control')
        })
      } catch (error) { this.order.push('rollback-observed:' + error.message) }
      return Response.json({ rows: this.rows(), order: this.order })
    }
    if (operation === 'observer') {
      this.order.push('observer-enter')
      const seen = this.rows()
      sql.exec("INSERT INTO probe VALUES (3, 'independent')")
      this.order.push('observer-written')
      return Response.json({ seen, rows: this.rows(), order: this.order })
    }
    if (operation === 'rows') return Response.json({ rows: this.rows(), order: this.order })
    if (operation === 'atomic') {
      let inside
      try {
        await this.ctx.storage.transaction(async () => {
          sql.exec('CREATE TABLE source (id INTEGER PRIMARY KEY, value TEXT)')
          sql.exec('CREATE TABLE derived (id INTEGER PRIMARY KEY, value TEXT)')
          sql.exec("INSERT INTO source VALUES (1, 'event')")
          await this.env.GATE.fetch('https://gate/atomic-await')
          sql.exec("INSERT INTO derived VALUES (1, 'projection')")
          inside = { tables: this.tables(), source: sql.exec('SELECT * FROM source').toArray(), derived: sql.exec('SELECT * FROM derived').toArray() }
          throw new Error('rollback-after-async-source-and-derived')
        })
      } catch (error) {
        return Response.json({ inside, after: this.tables(), error: error.message })
      }
      throw new Error('Atomic control did not roll back')
    }
    if (operation === 'changes') {
      sql.exec('CREATE TABLE changed (id INTEGER PRIMARY KEY, value TEXT)')
      sql.exec('CREATE INDEX changed_value ON changed (value)')
      const results = []
      const execute = (label, statement) => {
        const cursor = sql.exec(statement)
        const returned = cursor.toArray()
        results.push({ label, returned, rowsWritten: cursor.rowsWritten, changes: sql.exec('SELECT changes() AS changed').one().changed })
      }
      execute('insert-without-returning', "INSERT INTO changed VALUES (1, 'a'), (2, 'b')")
      execute('update-without-returning', "UPDATE changed SET value = value || '-updated'")
      execute('update-with-returning', "UPDATE changed SET value = value || '-returned' RETURNING id")
      execute('delete-with-returning', 'DELETE FROM changed WHERE id = 1 RETURNING id')
      execute('delete-without-returning', 'DELETE FROM changed WHERE id = 2')
      return Response.json(results)
    }
    throw new Error('Unknown operation: ' + operation)
  }
}
export default {
  async fetch(request, env) {
    const [, name, operation] = new URL(request.url).pathname.split('/')
    const pending = env.OBJECTS.get(env.OBJECTS.idFromName(name)).fetch('https://object/' + operation)
    if (operation === 'observer') await env.GATE.fetch('https://gate/observer-dispatched')
    return await pending
  }
}
`

const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>((next) => {
    resolve = next
  })
  return { promise, resolve }
}

const port = (name: string) => {
  const value = Number(process.env[name])
  assert(Number.isInteger(value) && value > 0, `${name} must contain its PFM-reserved port`)
  return value
}

test(
  'pinned Cloudflare host primitives: origin, asynchronous rollback, concurrent admission and DML changes',
  { timeout: 30_000 },
  async (testContext) => {
    const observations: Record<string, unknown> = { gates: [], stages: [], gatePayloads: {} }
    const gatePayloads: Record<string, unknown> = {}
    observations.gatePayloads = gatePayloads
    const stages: unknown[] = []
    observations.stages = stages
    const gateEvents: string[] = []
    observations.gates = gateEvents
    const persist = () => {
      if (process.env.CF_V9_EVIDENCE_PATH !== undefined) {
        writeFileSync(process.env.CF_V9_EVIDENCE_PATH, JSON.stringify(observations, null, 2) + '\n')
      }
    }
    const paused = deferred()
    const release = deferred()
    const observerDispatched = deferred()
    const mf = new Miniflare(
      convertV4MiniflareOptions({
        host: '127.0.0.1',
        cf: false,
        handleStructuredLogs: (log) => {
          stages.push(log)
          persist()
        },
        port: port('PFM_CF_V9_HTTP_PORT'),
        inspectorHost: '127.0.0.1',
        inspectorPort: port('PFM_CF_V9_INSPECTOR_PORT'),
        modules: true,
        script: worker,
        compatibilityDate: '2026-10-23',
        durableObjects: { OBJECTS: { className: 'HostProbe', useSQLite: true } },
        serviceBindings: {
          GATE: async (request) => {
            const operation = new URL(request.url).pathname
            gateEvents.push(operation)
            if (request.method === 'POST') gatePayloads[operation] = await request.json()
            persist()
            if (operation === '/transaction-paused') {
              paused.resolve()
              await release.promise
            } else if (operation === '/observer-dispatched') {
              observerDispatched.resolve()
            }
            return new Response('released')
          },
        },
      }),
    )
    const pending: Promise<unknown>[] = []
    let disposal: Promise<void> | undefined
    const dispose = () => (disposal ??= mf.dispose())
    const abort = () => {
      release.resolve()
      void dispose().catch((error) => console.error('Miniflare disposal failed', error))
    }
    testContext.signal.addEventListener('abort', abort, { once: true })
    try {
      await mf.ready
      const fetchJson = async (route: string, expectedStatus = 200): Promise<unknown> => {
        const response = await mf.dispatchFetch('https://probe/' + route)
        const text = await response.text()
        let body: unknown
        try {
          body = JSON.parse(text)
        } catch {
          body = text
        }
        observations[route] = { status: response.status, body }
        persist()
        assert.equal(response.status, expectedStatus, text)
        return body
      }
      const origin = await fetchJson('origin/origin')
      const existingKv = await fetchJson('healthy/existing-kv')
      const first = fetchJson('concurrent/rollback')
      pending.push(first)
      await Promise.race([
        paused.promise,
        first.then(() => {
          throw new Error('Transaction completed before its pause')
        }),
      ])
      const observer = fetchJson('concurrent/observer')
      pending.push(observer)
      await Promise.race([
        observerDispatched.promise,
        observer.then(() => {
          throw new Error('Observer completed before dispatch acknowledgement')
        }),
      ])
      release.resolve()
      const [rolledBack, concurrentObserver] = await Promise.all([first, observer])
      const final = await fetchJson('concurrent/rows')
      const atomic = await fetchJson('atomic/atomic')
      const changes = await fetchJson('changes/changes')
      const syncPositive = await fetchJson('healthy/sync-positive')
      await fetchJson('healthy/abort-owner', 500)
      const positiveReopen = await fetchJson('healthy/read-state')
      const commitLostAck = await fetchJson('commit-lost-ack/commit-lost-ack')
      const commitFailure = await fetchJson('commit-failure-sync/commit-failure-sync', 500)
      const failureReopen = await fetchJson('commit-failure-sync/read-state')
      const evidence = {
        origin,
        existingKv,
        rolledBack,
        concurrentObserver,
        final,
        atomic,
        changes,
        commitFailure,
        commitLostAck,
        syncPositive,
        positiveReopen,
        failureReopen,
      }
      console.log(JSON.stringify(evidence, null, 2))
      assert.deepEqual(origin, { before: [], afterGet: [], afterList: [], listed: [] })
      assert.deepEqual(existingKv, {
        before: [{ name: '_cf_KV' }],
        after: [{ name: '_cf_KV' }],
        value: 'retained-value',
        listed: [['application-key', 'retained-value']],
      })
      assert.equal(typeof commitFailure, 'string')
      assert(
        syncPositive && typeof syncPositive === 'object' && 'instanceId' in syncPositive && 'state' in syncPositive,
      )
      assert(
        positiveReopen &&
          typeof positiveReopen === 'object' &&
          'instanceId' in positiveReopen &&
          'state' in positiveReopen,
      )
      assert.notEqual(positiveReopen.instanceId, syncPositive.instanceId)
      assert.deepEqual(positiveReopen.state, syncPositive.state)
      assert('kv' in positiveReopen && positiveReopen.kv === 'retained-value')
      const oldSource = gatePayloads['/commit-old-source-confirmed']
      assert(oldSource && typeof oldSource === 'object' && 'instanceId' in oldSource && 'state' in oldSource)
      assert(
        failureReopen && typeof failureReopen === 'object' && 'instanceId' in failureReopen && 'state' in failureReopen,
      )
      assert.notEqual(failureReopen.instanceId, oldSource.instanceId)
      assert.deepEqual(failureReopen.state, oldSource.state)
      assert(!gateEvents.includes('/commit-failure-sync-host-resolved'))
      assert.deepEqual(commitLostAck, {
        callbackReturned: true,
        hostCommitted: true,
        error: 'injected-host-acknowledgement-loss',
        rows: [{ id: 1, value: 'durable-source-proof' }],
      })
      assert.deepEqual(
        concurrentObserver !== null && typeof concurrentObserver === 'object' && 'seen' in concurrentObserver
          ? concurrentObserver.seen
          : undefined,
        [{ id: 1, value: 'committed' }],
      )
      assert.deepEqual(final !== null && typeof final === 'object' && 'rows' in final ? final.rows : undefined, [
        { id: 1, value: 'committed' },
        { id: 3, value: 'independent' },
      ])
      assert.deepEqual(
        atomic !== null && typeof atomic === 'object' && 'after' in atomic ? atomic.after : undefined,
        [],
      )
      assert(Array.isArray(changes))
      assert.deepEqual(
        changes.map((row) => row.changes),
        [2, 2, 2, 1, 1],
      )
    } finally {
      release.resolve()
      persist()
      await Promise.allSettled(pending)
      await dispose()
      testContext.signal.removeEventListener('abort', abort)
    }
  },
)
