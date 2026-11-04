import fs from 'node:fs/promises'
import path from 'node:path'

import { expect, test } from 'vitest'

import {
  adoptSource,
  decodeSourceAdoptionPlan,
  prepareSourceAdoption,
  SourceMaintenanceError,
} from '@livestore/common/source-maintenance'
import { Effect, Result, Schema } from '@livestore/utils/effect'

import { definitions, payloadDigest, withFixture } from './source-maintenance-adoption-fixture.ts'

const prepare = async (fixture: Parameters<Parameters<typeof withFixture>[0]>[0]) =>
  Effect.runPromise(
    prepareSourceAdoption({
      capture: await fixture.capture(),
      target: fixture.target(),
      eventDefinitions: definitions,
    }),
  )
const persistedJson = (value: unknown): unknown => {
  const parsed: unknown = JSON.parse(JSON.stringify(value))
  return Schema.decodeUnknownSync(Schema.Json)(parsed)
}
const refused = async (input: unknown, code: string) => {
  const result = await Effect.runPromise(Effect.result(decodeSourceAdoptionPlan(input)))
  expect(Result.isFailure(result)).toBe(true)
  if (Result.isFailure(result) === true) {
    expect(result.failure).toBeInstanceOf(SourceMaintenanceError)
    expect(result.failure.code).toBe(code)
  }
}

test('public unknown decoder restores a persisted plan without SOURCE, then adopts after reopening', async () =>
  withFixture(async (fixture) => {
    const original = await prepare(fixture)
    const persisted = persistedJson(original)
    const sourcePath = path.join(fixture.directory, 'eventlog.db')
    const unavailablePath = path.join(fixture.directory, 'unavailable.db')
    await fs.rename(sourcePath, unavailablePath)
    const released = fixture.released()
    const restored = await Effect.runPromise(decodeSourceAdoptionPlan(persisted))
    expect(restored).toEqual(original)
    expect(fixture.released()).toBe(released)
    expect(await fs.readdir(fixture.directory)).toEqual(['unavailable.db'])
    await fs.rename(unavailablePath, sourcePath)
    const receipt = await Effect.runPromise(
      adoptSource({
        opener: fixture.opener,
        plan: restored,
        intent: fixture.intent(restored.planDigest),
        currentTarget: fixture.target(payloadDigest),
        eventDefinitions: definitions,
      }),
    )
    expect(receipt).toMatchObject({
      outcome: 'applied',
      planDigest: original.planDigest,
      backendId: original.targetBackendId,
    })
  }))

test('decoder rejects malformed structural fields and unsupported contract', async () =>
  withFixture(async (fixture) => {
    const plan = await prepare(fixture)
    for (const value of [
      null,
      [],
      'plan',
      {},
      { ...plan, contract: 'livestore-source-adoption-v2' },
      { ...plan, policy: 'discard-residual' },
      { ...plan, binding: { operationId: 17, context: null } },
      { ...plan, expected: { ...plan.expected, rows: '3' } },
      { ...plan, limits: null },
    ])
      await refused(value, 'plan-codec')
  }))

test('decoder rejects invalid source identity, head, backend and bounded limits before digest acceptance', async () =>
  withFixture(async (fixture) => {
    const plan = await prepare(fixture)
    const variants: unknown[] = [
      {
        ...plan,
        expected: { ...plan.expected, sourceIdentity: { ...plan.expected.sourceIdentity, formatVersion: -1 } },
      },
      { ...plan, expected: { ...plan.expected, sourceIdentity: { ...plan.expected.sourceIdentity, incarnation: '' } } },
      { ...plan, successorIncarnation: plan.expected.sourceIdentity.incarnation },
      { ...plan, successorIncarnation: ' ' },
      { ...plan, targetBackendId: plan.expected.backendId },
      { ...plan, targetBackendId: '' },
      { ...plan, targetHead: -1 },
      { ...plan, targetHead: 0 },
      { ...plan, targetHead: Number.MAX_SAFE_INTEGER + 1 },
      { ...plan, expected: { ...plan.expected, acknowledgedHead: 1.5 } },
      { ...plan, expected: { ...plan.expected, rows: -1 } },
      { ...plan, limits: { ...plan.limits, pageSize: 0 } },
      { ...plan, limits: { ...plan.limits, maxBytes: -1 } },
      { ...plan, limits: { ...plan.limits, maxRowBytes: 1.5 } },
      { ...plan, limits: { ...plan.limits, maxRows: 1 } },
    ]
    for (const value of variants) await refused(value, 'plan-semantics')
  }))

test('decoder rejects commitment tampering and oversized JSON and owns nested frozen input', async () =>
  withFixture(async (fixture) => {
    const plan = await prepare(fixture)
    await refused({ ...plan, planDigest: 'invalid' }, 'plan-digest')
    await refused({ ...plan, planDigest: 'f'.repeat(64) }, 'plan-digest')
    await refused({ ...plan, postimageDigest: 'e'.repeat(64) }, 'plan-digest')
    await refused({ ...plan, expected: { ...plan.expected, rowDigest: 'd'.repeat(64) } }, 'plan-digest')
    await refused({ ...plan, binding: { ...plan.binding, context: 'x'.repeat(1024 * 1024) } }, 'plan-limit')
    const input = {
      ...plan,
      binding: { ...plan.binding },
      expected: { ...plan.expected, sourceIdentity: { ...plan.expected.sourceIdentity } },
      limits: { ...plan.limits },
    }
    const restored = await Effect.runPromise(decodeSourceAdoptionPlan(input))
    input.binding.operationId = 'changed-after-decode'
    input.expected.sourceIdentity.incarnation = 'changed-after-decode'
    input.limits.maxRows = 1
    expect(restored).toEqual(plan)
    for (const value of [
      restored,
      restored.binding,
      restored.binding.context,
      restored.expected,
      restored.expected.sourceIdentity,
      restored.limits,
    ])
      expect(Object.isFrozen(value)).toBe(true)
    expect(Reflect.set(restored.expected.sourceIdentity, 'incarnation', 'mutated')).toBe(false)
  }))
