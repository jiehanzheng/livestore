import { expect, test } from 'vitest'

import { LiveStoreEvent } from '@livestore/common/schema'
import {
  adoptSource,
  decodeSourceAdoptionPlan,
  inspectSourceAdoption,
  prepareSourceAdoption,
  SourceMaintenanceError,
} from '@livestore/common/source-maintenance'
import { Effect, Stream } from '@livestore/utils/effect'

import { definitions, payloadDigest, withFixture } from './source-maintenance-adoption-fixture.ts'

test('same-head target body drift and malformed local inspection refuse with joined SDK closure before opener admission', async () =>
  withFixture(async (fixture) => {
    const capture = await fixture.capture()
    const plan = await Effect.runPromise(
      prepareSourceAdoption({ capture, target: fixture.target(), eventDefinitions: definitions }),
    )
    const released = fixture.released()
    const target = fixture.target(payloadDigest)
    const altered = {
      ...target,
      prefix: Stream.fromIterable(
        [fixture.first, { ...fixture.pending, event: { ...fixture.pending.event, args: { changed: true } } }].map(
          ({ event }) => LiveStoreEvent.Client.toGlobal(event),
        ),
      ),
    }
    const refused = await Effect.runPromise(
      adoptSource({
        opener: fixture.opener,
        plan,
        intent: fixture.intent(plan.planDigest),
        currentTarget: altered,
        eventDefinitions: definitions,
      }).pipe(Effect.result),
    )
    expect(refused).toMatchObject({
      _tag: 'Failure',
      failure: { code: 'adoption-target', closure: 'joined', commitStatus: 'not-started' },
    })
    const malformed = { ...plan, targetHead: plan.targetHead + 1 }
    expect(
      await Effect.runPromise(
        inspectSourceAdoption({
          opener: fixture.opener,
          plan: malformed,
          intent: fixture.intent(plan.planDigest),
        }).pipe(Effect.result),
      ),
    ).toMatchObject({ _tag: 'Failure', failure: { closure: 'joined', commitStatus: 'not-started' } })
    expect(await Effect.runPromise(decodeSourceAdoptionPlan(malformed).pipe(Effect.result))).toMatchObject({
      _tag: 'Failure',
      failure: { closure: 'joined', commitStatus: 'not-started' },
    })
    expect(fixture.released()).toBe(released)
  }))

test('pure preparation attests no SDK SOURCE while retaining an unsafe caller stream error as nested cause', async () =>
  withFixture(async (fixture) => {
    const capture = await fixture.capture()
    const unsafe = new SourceMaintenanceError(
      'caller-stream-resource',
      'unjoined caller resource',
      'unknown',
      'unknown',
    )
    const released = fixture.released()
    const result = await Effect.runPromise(
      prepareSourceAdoption({
        capture,
        target: { ...fixture.target(), prefix: Stream.fail(unsafe) },
        eventDefinitions: definitions,
      }).pipe(Effect.result),
    )
    expect(result).toMatchObject({
      _tag: 'Failure',
      failure: { closure: 'joined', commitStatus: 'not-started', cause: unsafe },
    })
    expect(unsafe.closure).toBe('unknown')
    expect(fixture.released()).toBe(released)
  }))
