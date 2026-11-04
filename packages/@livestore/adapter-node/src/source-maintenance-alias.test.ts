import { expect, test } from 'vitest'

import {
  adoptSource,
  prepareSourceAdoption,
  type SourceMaintenanceLocationOwner,
  type SourceMaintenanceContext,
} from '@livestore/common/source-maintenance'
import { loadSqlite3Wasm } from '@livestore/sqlite-wasm/load-wasm'
import { sqliteDbFactory } from '@livestore/sqlite-wasm/node'
import { Effect, Stream } from '@livestore/utils/effect'
import { PlatformNode } from '@livestore/utils/node'

import { binding, definitions, payloadDigest, withFixture } from './source-maintenance-adoption-fixture.ts'
import { makeNodeSourceMaintenanceOpener } from './source-maintenance.ts'

// A caller-owned descriptor can remain mutable even though the API's view of it is readonly.
const changingTarget = (
  fixture: Parameters<Parameters<typeof withFixture>[0]>[0],
  intent: string | null,
  extra = () => {},
) => {
  const original = fixture.target(intent)
  const target = {
    ...original,
    binding: { ...binding, context: structuredClone(binding.context) },
    witness: { reviewed: true },
  }
  target.prefix = original.prefix.pipe(
    Stream.tap(() =>
      Effect.sync(() => {
        target.backendId = 'different-backend'
        target.logicalHead = 0
        target.binding.operationId = 'different-operation'
        target.witness.reviewed = false
        target.intentPayloadDigest = 'b'.repeat(64)
        target.prefix = Stream.empty
        extra()
      }),
    ),
  )
  return target
}

test('preparation owns one target descriptor and prefix despite mutations by its stream', async () =>
  withFixture(async (fixture) => {
    const capture = await fixture.capture()
    const baseline = await Effect.runPromise(
      prepareSourceAdoption({ capture, target: fixture.target(), eventDefinitions: definitions }),
    )
    const target = changingTarget(fixture, null)
    const plan = await Effect.runPromise(prepareSourceAdoption({ capture, target, eventDefinitions: definitions }))
    expect(target.backendId).toBe('different-backend')
    expect(target.logicalHead).toBe(0)
    expect(plan.binding).toEqual(binding)
    expect(plan.targetBackendId).toBe(baseline.targetBackendId)
    expect(plan.targetHead).toBe(2)
    expect(plan.targetPrefixDigest).toBe(baseline.targetPrefixDigest)
    expect(plan.targetWitnessDigest).toBe(baseline.targetWitnessDigest)
    expect(Object.isFrozen(plan)).toBe(true)
    expect(Object.isFrozen(plan.expected)).toBe(true)
    expect(Object.isFrozen(plan.binding.context)).toBe(true)
    expect(Reflect.set(plan, 'targetBackendId', 'tampered')).toBe(false)
  }))

test('adoption checks the owned intent binding and target rather than rereading mutable inputs', async () =>
  withFixture(async (fixture) => {
    const capture = await fixture.capture()
    const plan = await Effect.runPromise(
      prepareSourceAdoption({ capture, target: fixture.target(), eventDefinitions: definitions }),
    )
    const suppliedPlan = structuredClone(plan)
    const suppliedIntent = fixture.intent(plan.planDigest)
    const target = changingTarget(fixture, payloadDigest, () => {
      Reflect.set(suppliedPlan, 'targetBackendId', 'tampered-backend')
      Reflect.set(suppliedIntent, 'payloadDigest', 'c'.repeat(64))
    })
    const receipt = await Effect.runPromise(
      adoptSource({
        opener: fixture.opener,
        plan: suppliedPlan,
        intent: suppliedIntent,
        currentTarget: target,
        eventDefinitions: definitions,
      }),
    )
    expect(target.intentPayloadDigest).toBe('b'.repeat(64))
    expect(suppliedIntent.payloadDigest).toBe('c'.repeat(64))
    expect(receipt).toMatchObject({
      operationId: binding.operationId,
      payloadDigest,
      backendId: 'new-backend',
      planDigest: plan.planDigest,
      outcome: 'applied',
    })
    expect(receipt.targetWitnessDigest).toBe(plan.targetWitnessDigest)
    const after = await fixture.capture()
    expect(after.receipt.snapshot.backendId).toBe('new-backend')
    expect(after.receipt.snapshot.eventDigest).toBe(capture.receipt.snapshot.eventDigest)
  }))

test('application location provider receives frozen operation and intent aliases', async () =>
  withFixture(async (fixture) => {
    const capture = await fixture.capture()
    const plan = await Effect.runPromise(
      prepareSourceAdoption({ capture, target: fixture.target(), eventDefinitions: definitions }),
    )
    const attempts: boolean[] = []
    let entered = 0
    const locationOwner: SourceMaintenanceLocationOwner = {
      run: (context: SourceMaintenanceContext, effect) =>
        Effect.sync(() => {
          // The fixture owns this unique location; this callback tests immutable evidence, not an OS-lock surrogate.
          entered++
          expect(Object.isFrozen(context)).toBe(true)
          expect(Object.isFrozen(context.binding)).toBe(true)
          if (context.purpose === 'adoption') {
            expect(Object.isFrozen(context.intent)).toBe(true)
            expect(Object.isFrozen(context.intent.receipt)).toBe(true)
            attempts.push(Reflect.set(context.binding, 'operationId', 'wrong-operation'))
            attempts.push(Reflect.set(context.intent, 'payloadDigest', 'd'.repeat(64)))
            const appContext = context.binding.context
            if (appContext !== null && typeof appContext === 'object')
              attempts.push(Reflect.set(appContext, 'revision', 999))
          }
        }).pipe(Effect.andThen(effect)),
    }
    const sqlite3 = await loadSqlite3Wasm()
    const makeSqliteDb = await Effect.runPromise(
      sqliteDbFactory({ sqlite3 }).pipe(Effect.provide(PlatformNode.NodeFileSystem.layer)),
    )
    const opener = makeNodeSourceMaintenanceOpener({
      binding,
      locationOwner,
      directory: fixture.directory,
      fileName: 'eventlog.db',
      makeSqliteDb,
    })
    const receipt = await Effect.runPromise(
      adoptSource({
        opener,
        plan,
        intent: fixture.intent(plan.planDigest),
        currentTarget: fixture.target(payloadDigest),
        eventDefinitions: definitions,
      }),
    )
    expect(entered).toBe(1)
    expect(attempts).toEqual([false, false, false])
    expect(receipt.operationId).toBe(binding.operationId)
    expect(receipt.payloadDigest).toBe(payloadDigest)
    expect(receipt.backendId).toBe('new-backend')
  }))
