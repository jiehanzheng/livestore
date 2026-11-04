import fs from 'node:fs/promises'
import path from 'node:path'

import { expect, test, vi } from 'vitest'

import {
  adoptSource,
  inspectSourceAdoption,
  prepareSourceAdoption,
  SourceMaintenanceError,
  type SourceMaintenanceLocationOwner,
} from '@livestore/common/source-maintenance'
import { withRetainedSource } from '@livestore/common/source-maintenance/internal'
import type { NodeDatabaseInput, NodeDatabaseMetadata } from '@livestore/sqlite-wasm/node'
import { Effect, Result } from '@livestore/utils/effect'

import { binding, definitions, payloadDigest, withFixture } from './source-maintenance-adoption-fixture.ts'
import { makeNodeSourceMaintenanceOpener } from './source-maintenance.ts'

test('local inspection classifies exact original and lost-ACK postimage without network or SOURCE/STATE writes', async () =>
  withFixture(async (fixture) => {
    const capture = await fixture.capture()
    const plan = await Effect.runPromise(
      prepareSourceAdoption({ capture, target: fixture.target(), eventDefinitions: definitions }),
    )
    const request = { opener: fixture.opener, plan, intent: fixture.intent(plan.planDigest) }
    const inspect = async (outcome: 'applied' | 'not-applied') => {
      const before = await fs.readFile(path.join(fixture.directory, 'eventlog.db'))
      const files = await fs.readdir(fixture.directory)
      const sql: string[] = []
      const opener = makeNodeSourceMaintenanceOpener({
        binding,
        directory: fixture.directory,
        fileName: 'eventlog.db',
        locationOwner: fixture.locationOwner,
        makeSqliteDb: <
          TInput extends NodeDatabaseInput,
          TMetadata extends NodeDatabaseMetadata & { _tag: TInput['_tag'] } = NodeDatabaseMetadata & {
            _tag: TInput['_tag']
          },
        >(
          input: TInput,
        ) =>
          fixture.makeSqliteDb<TInput, TMetadata>(input).pipe(
            Effect.tap((native) =>
              Effect.sync(() => {
                const execute = native.execute.bind(native)
                vi.spyOn(native, 'execute').mockImplementation((statement, ...args) => {
                  sql.push(String(statement))
                  return execute(statement, ...args)
                })
              }),
            ),
          ),
      })
      try {
        expect(await Effect.runPromise(inspectSourceAdoption({ ...request, opener }))).toEqual({
          contract: 'livestore-source-adoption-inspection-v1',
          operationId: binding.operationId,
          payloadDigest,
          planDigest: plan.planDigest,
          outcome,
          closure: 'joined-maintenance-owner',
        })
      } finally {
        vi.restoreAllMocks()
      }
      expect(
        sql.filter((statement) => /^(INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|REPLACE)\b/i.test(statement.trim())),
      ).toEqual([])
      expect(await fs.readFile(path.join(fixture.directory, 'eventlog.db'))).toEqual(before)
      expect(await fs.readdir(fixture.directory)).toEqual(files)
      expect(fixture.held()).toBe(false)
    }
    await inspect('not-applied')
    await Effect.runPromise(
      adoptSource({ ...request, currentTarget: fixture.target(payloadDigest), eventDefinitions: definitions }),
    )
    // No target/auth argument exists: this resolves local outcome even when the old server grant is now denied.
    await inspect('applied')
    await inspect('applied')
    await Effect.runPromise(
      withRetainedSource(fixture.opener, binding, (source) =>
        source.write((tx) => tx.execute('UPDATE __livestore_sync_status SET backendId = ?', ['old-backend'])),
      ),
    )
    expect(await Effect.runPromise(inspectSourceAdoption(request))).toMatchObject({
      outcome: 'foreign',
      closure: 'joined-maintenance-owner',
    })
  }))

test('changed raw SOURCE is foreign and malformed plans/intent refuse before location admission', async () =>
  withFixture(async (fixture) => {
    const capture = await fixture.capture()
    const plan = await Effect.runPromise(
      prepareSourceAdoption({ capture, target: fixture.target(), eventDefinitions: definitions }),
    )
    const request = { opener: fixture.opener, plan, intent: fixture.intent(plan.planDigest) }
    const released = fixture.released()
    for (const altered of [
      { ...request, plan: { ...plan, targetHead: plan.targetHead + 1 } },
      { ...request, intent: { ...request.intent, planDigest: 'b'.repeat(64) } },
    ])
      expect((await Effect.runPromiseExit(inspectSourceAdoption(altered)))._tag).toBe('Failure')
    expect(fixture.released()).toBe(released)
    await Effect.runPromise(
      withRetainedSource(fixture.opener, binding, (source) =>
        source.write((tx) =>
          tx.execute('UPDATE eventlog SET argsJson = ? WHERE seqNumGlobal = 2 AND seqNumClient = 0', [
            '{"value":"tampered"}',
          ]),
        ),
      ),
    )
    const before = await fs.readFile(path.join(fixture.directory, 'eventlog.db'))
    expect(await Effect.runPromise(inspectSourceAdoption(request))).toMatchObject({
      outcome: 'foreign',
      closure: 'joined-maintenance-owner',
    })
    expect(await fs.readFile(path.join(fixture.directory, 'eventlog.db'))).toEqual(before)
  }))

test('inspection read failure joins close, while failed close retains the app owner and yields no classification', async () =>
  withFixture(async (fixture) => {
    const capture = await fixture.capture()
    const plan = await Effect.runPromise(
      prepareSourceAdoption({ capture, target: fixture.target(), eventDefinitions: definitions }),
    )
    let held = false
    let observed: SourceMaintenanceError | undefined
    const locationOwner: SourceMaintenanceLocationOwner = {
      run: (context, effect) =>
        fixture.locationOwner.run(
          context,
          Effect.gen(function* () {
            held = true
            const result = yield* Effect.result(effect)
            if (Result.isFailure(result) === true) {
              if (result.failure instanceof SourceMaintenanceError) observed = result.failure
              if (observed?.closure === 'joined') held = false
              return yield* Effect.fail(result.failure)
            }
            held = false
            return result.success
          }),
        ),
    }
    const opener = makeNodeSourceMaintenanceOpener({
      binding,
      directory: fixture.directory,
      fileName: 'eventlog.db',
      locationOwner,
      makeSqliteDb: <
        TInput extends NodeDatabaseInput,
        TMetadata extends NodeDatabaseMetadata & { _tag: TInput['_tag'] } = NodeDatabaseMetadata & {
          _tag: TInput['_tag']
        },
      >(
        input: TInput,
      ) =>
        fixture.makeSqliteDb<TInput, TMetadata>(input).pipe(
          Effect.tap((native) =>
            Effect.sync(() => {
              const select = native.select.bind(native)
              vi.spyOn(native, 'select').mockImplementation((statement, ...args) => {
                if (String(statement).includes('COUNT(*)') === true) throw new Error('actual scan read failed')
                return select(statement, ...args)
              })
            }),
          ),
        ),
    })
    try {
      expect(
        (await Effect.runPromiseExit(inspectSourceAdoption({ opener, plan, intent: fixture.intent(plan.planDigest) })))
          ._tag,
      ).toBe('Failure')
      expect(observed).toMatchObject({ closure: 'joined', commitStatus: 'not-started' })
      expect(held).toBe(false)
    } finally {
      vi.restoreAllMocks()
    }
    fixture.failClose()
    const result = await Effect.runPromise(
      inspectSourceAdoption({ opener: fixture.opener, plan, intent: fixture.intent(plan.planDigest) }).pipe(
        Effect.result,
      ),
    )
    expect(result).toMatchObject({
      _tag: 'Failure',
      failure: { code: 'adoption-inspection-unclosed', closure: 'unknown', commitStatus: 'not-started' },
    })
    expect(fixture.held()).toBe(true)
  }))
