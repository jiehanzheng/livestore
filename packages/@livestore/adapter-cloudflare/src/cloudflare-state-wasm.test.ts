import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'

import { build } from 'esbuild'
import { convertV4MiniflareOptions, Miniflare, Response } from 'miniflare'

const reservedPort = (name: string) => {
  const value = Number(process.env[name])
  assert(Number.isInteger(value) && value > 0, `${name} must contain its PFM-reserved port`)
  return value
}

const object = (value: unknown): Record<string, unknown> => {
  assert(value !== null && typeof value === 'object' && !Array.isArray(value))
  return value as Record<string, unknown>
}

const items = (value: unknown): unknown[] => {
  assert(Array.isArray(value))
  return value
}

test(
  'actual CF native source and WASM VFS settle host failures before close, then cold-owner admission',
  { timeout: 30_000 },
  async (context) => {
    let wasmPath: string | undefined
    const bundle = await build({
      entryPoints: [path.join(import.meta.dirname, 'test-fixtures/state-wasm-host.worker.js')],
      bundle: true,
      format: 'esm',
      platform: 'browser',
      conditions: ['workerd', 'browser'],
      write: false,
      target: 'es2022',
      external: ['cloudflare:workers'],
      logLevel: 'silent',
      plugins: [
        {
          name: 'workerd-wasm-module',
          setup: (builder) => {
            builder.onResolve({ filter: /wa-sqlite\.wasm$/ }, async (args) => {
              if (args.pluginData === 'resolved-wasm') return undefined
              const resolved = await builder.resolve(args.path, {
                resolveDir: args.resolveDir,
                kind: args.kind,
                pluginData: 'resolved-wasm',
              })
              if (resolved.errors.length > 0) return { errors: resolved.errors }
              wasmPath = resolved.path
              return { path: './livestore-sqlite.wasm', external: true }
            })
          },
        },
      ],
    })
    assert(wasmPath !== undefined)
    const worker = bundle.outputFiles[0]
    assert(worker !== undefined)
    const observations: Record<string, unknown> = { stages: [], gatePayloads: [] }
    const stages: unknown[] = []
    const gatePayloads: unknown[] = []
    observations.stages = stages
    observations.gatePayloads = gatePayloads
    const save = async () => {
      if (process.env.CF_V9_EVIDENCE_PATH !== undefined)
        await writeFile(process.env.CF_V9_EVIDENCE_PATH, JSON.stringify(observations, null, 2) + '\n')
    }
    const mf = new Miniflare(
      convertV4MiniflareOptions({
        host: '127.0.0.1',
        cf: false,
        port: reservedPort('PFM_CF_V9_HTTP_PORT'),
        inspectorHost: '127.0.0.1',
        inspectorPort: reservedPort('PFM_CF_V9_INSPECTOR_PORT'),
        compatibilityDate: '2026-10-23',
        compatibilityFlags: ['nodejs_compat'],
        modulesRoot: import.meta.dirname,
        modules: [
          { type: 'ESModule', path: path.join(import.meta.dirname, 'compiled-probe.js'), contents: worker.text },
          {
            type: 'CompiledWasm',
            path: path.join(import.meta.dirname, 'livestore-sqlite.wasm'),
            contents: await readFile(wasmPath),
          },
        ],
        durableObjects: { OBJECTS: { className: 'WasmHostProbe', useSQLite: true } },
        handleStructuredLogs: (log) => {
          stages.push(log)
        },
        serviceBindings: {
          GATE: async (request) => {
            gatePayloads.push(await request.json())
            await save()
            return new Response('observed')
          },
        },
      }),
    )
    let disposal: Promise<void> | undefined
    const dispose = () => (disposal ??= mf.dispose())
    const abort = () => {
      void dispose().catch((error) => console.error(error))
    }
    context.signal.addEventListener('abort', abort, { once: true })
    try {
      await mf.ready
      const fetchJson = async (route: string, status = 200) => {
        const response = await mf.dispatchFetch('https://probe/' + route)
        const text = await response.text()
        let body: unknown
        try {
          body = JSON.parse(text)
        } catch {
          body = text
        }
        observations[route] = { status: response.status, body }
        await save()
        assert.equal(response.status, status, text)
        return body
      }
      assert.deepEqual(await fetchJson('row-count/row-count'), { results: [2, 2, 2, 1, 1], unsupported: 'SqliteError' })
      const ownership = object(await fetchJson('ownership/host-ownership'))
      assert.deepEqual(ownership.inside, {
        childRan: false,
        lateRan: false,
        nested: 'same-fiber-nested',
        transactions: 1,
      })
      assert.equal(ownership.childConfirmation, 1)
      assert.equal(ownership.lateConfirmation, 2)
      assert.equal(ownership.transactions, 3)
      assert.equal(ownership.confirmations, 3)
      assert.deepEqual(await fetchJson('nested/nested-caught-failure'), { failed: true, tables: [], transactions: 1 })
      assert.deepEqual(await fetchJson('cancellation/cancellation-settlement'), {
        during: { interruptSettled: false, closeCalls: 0 },
        closeCalls: 1,
        fenced: true,
        reusedHost: false,
        tables: [],
      })
      for (const failure of ['rollback', 'lost-ack']) {
        const result = object(await fetchJson(`${failure}/${failure}`))
        const before = object(result.before)
        const priorState = object(before.state)
        const tentative = object(result.tentative)
        const after = object(result.after)
        assert.equal(after.failed, true)
        assert.equal(result.fenced, true)
        assert.deepEqual(after.outsideWrites, [])
        assert.deepEqual(tentative.head, priorState.head)
        assert.deepEqual(tentative.values, priorState.values)
        assert.equal(items(priorState.journal).length, 1)
        assert.deepEqual(tentative.journal, [])
        assert.notEqual(object(tentative.proof).transitionId, object(priorState.proof).transitionId)
        const closed = object(items(after.closeEvidence)[0])
        assert.deepEqual(closed.before, closed.after)
        assert.deepEqual(closed.outsideWrites, [])
        assert.deepEqual(object(closed.advanced).proof, tentative.proof)
        if (failure === 'rollback') {
          assert.deepEqual(after.source, before.source)
          assert.deepEqual(after.pages, before.pages)
        } else {
          assert.notDeepEqual(after.source, before.source)
          assert.notDeepEqual(after.pages, before.pages)
        }
        await fetchJson(`${failure}/abort`, 500)
        const reopened = object(await fetchJson(`${failure}/reopen`))
        assert.notEqual(reopened.instanceId, result.instanceId)
        assert.deepEqual(reopened.source, after.source)
        const previous = object(reopened.previous)
        assert.deepEqual(previous.head, priorState.head)
        assert.deepEqual(previous.proof, failure === 'rollback' ? priorState.proof : tentative.proof)
        const current = object(reopened.current)
        assert.notEqual(object(current.proof).ownerId, object(previous.proof).ownerId)
        assert.equal(object(reopened.admission)._tag, 'StaleSnapshot')
        assert.deepEqual(reopened.outsideWrites, [])
      }
      const closeFailure = object(await fetchJson('close-failure/close-failure'))
      const closeBefore = object(closeFailure.before)
      const closeAfter = object(closeFailure.after)
      assert.equal(closeAfter.failed, true)
      assert.equal(closeAfter.stateRetained, true)
      assert.equal(closeAfter.closeCalls, 1)
      assert.equal(closeFailure.fenced, true)
      assert.equal(closeFailure.reusedHost, false)
      assert.match(String(closeAfter.cause), /injected-state-close-failure/)
      assert.deepEqual(closeAfter.source, closeBefore.source)
      assert.deepEqual(closeAfter.pages, closeBefore.pages)
      assert.deepEqual(closeAfter.outsideWrites, [])
      await fetchJson('close-failure/abort', 500)
      const afterFailedClose = object(await fetchJson('close-failure/reopen'))
      assert.notEqual(afterFailedClose.instanceId, closeFailure.instanceId)
      assert.deepEqual(afterFailedClose.source, closeBefore.source)
      assert.deepEqual(afterFailedClose.previous, closeBefore.state)
    } finally {
      await save()
      await dispose()
      context.signal.removeEventListener('abort', abort)
    }
  },
)
