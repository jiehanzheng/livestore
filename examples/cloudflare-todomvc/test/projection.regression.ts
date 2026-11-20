import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'

import { createStore } from '@livestore/livestore'

import { makeAdapter } from '../../../packages/@livestore/adapter-node/src/index.ts'
import { provideOtel } from '../../../packages/@livestore/common/src/index.ts'
import { makeWsSync } from '../../../packages/@livestore/sync-cf/src/client/mod.ts'
import { Effect } from '../../../packages/@livestore/utils/src/effect/mod.ts'
import { PlatformNode } from '../../../packages/@livestore/utils/src/node/mod.ts'
import { events, schema } from '../src/livestore/schema.ts'

test('the client DO projects synced events before its normal GET is asserted', async () => {
  const origin = process.env.CF_TODOMVC_ORIGIN
  assert.ok(origin, 'Set CF_TODOMVC_ORIGIN to the PFM-owned observer fixture origin')
  const storeId = `sdk-do-observer-${crypto.randomUUID()}`
  const id = crypto.randomUUID()
  const baseDirectory = await fs.mkdtemp(path.resolve('temp_nocommit/cf-do-observer-client-'))
  const clientUrl = new URL(`/client-do?storeId=${storeId}`, origin)
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const store = yield* createStore({
            schema,
            storeId,
            disableDevtools: true,
            adapter: makeAdapter({
              storage: { type: 'fs', baseDirectory },
              clientId: 'observer-producer',
              sync: { backend: makeWsSync({ url: new URL('/sync', origin).href }) },
            }),
          })
          const initial = yield* Effect.promise(() => fetch(clientUrl, { signal: AbortSignal.timeout(10000) }))
          assert.equal(initial.status, 200)
          assert.deepEqual(yield* Effect.promise(() => initial.json()), [])
          const observed = fetch(new URL(`/__test/observe-completed?storeId=${storeId}&id=${id}`, origin), {
            method: 'POST',
            signal: AbortSignal.timeout(15000),
          })
          store.commit(events.todoCreated({ id, text: 'Observed local DO task' }), events.todoCompleted({ id }))
          const observation = yield* Effect.promise(() => observed)
          assert.equal(observation.status, 200)
          assert.deepEqual(yield* Effect.promise(() => observation.json()), { id, completed: true })
          const response = yield* Effect.promise(() => fetch(clientUrl, { signal: AbortSignal.timeout(10000) }))
          assert.equal(response.status, 200)
          const rows = yield* Effect.promise(() => response.json())
          assert.equal(rows.length, 1)
          assert.equal(rows[0].id, id)
          assert.equal(rows[0].completed, true)
        }),
      ).pipe(provideOtel({}), Effect.provide(PlatformNode.NodeFileSystem.layer)),
    )
    if (process.env.CF_TODOMVC_EVIDENCE !== undefined && process.env.CF_TODOMVC_EVIDENCE !== '') {
      await fs.writeFile(
        process.env.CF_TODOMVC_EVIDENCE,
        JSON.stringify(
          {
            status: 'PASS',
            storeId,
            barrier: 'Test-only subclass observing the actual production client store through Store.subscribe',
            normalGetRows: 1,
            completed: true,
            expectedCanonicalEvents: 2,
            scope: 'Local API/DO projection; no production HTTP ordering guarantee or Browser claim',
          },
          null,
          2,
        ) + '\n',
      )
    }
  } finally {
    await fs.rm(baseDirectory, { recursive: true, force: true })
  }
})
