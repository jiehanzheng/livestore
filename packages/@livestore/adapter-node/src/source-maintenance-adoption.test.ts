import { expect, test } from 'vitest'

import { SyncState } from '@livestore/common'
import { LiveStoreEvent } from '@livestore/common/schema'
import { SourceEvents, SourceIdentity } from '@livestore/common/source-db'
import { adoptSource, prepareSourceAdoption } from '@livestore/common/source-maintenance'
import { withRetainedSource } from '@livestore/common/source-maintenance/internal'
import { Effect, Option } from '@livestore/utils/effect'

import { binding, definitions, payloadDigest, sequence, withFixture } from './source-maintenance-adoption-fixture.ts'

const observe = (fixture: Parameters<Parameters<typeof withFixture>[0]>[0]) =>
  Effect.runPromise(
    withRetainedSource(fixture.opener, binding, (source) =>
      Effect.gen(function* () {
        return {
          identity: yield* SourceIdentity.read(source.handle),
          rows: yield* SourceEvents.readPage(source.handle, { includeClientOnly: true }),
          head: yield* SourceEvents.readBackendHead(source.handle),
          backend: yield* SourceEvents.readBackendId(source.handle),
        }
      }),
    ),
  )

test('actual Node adoption preserves lost-ACK occurrence and client-only work, confirms once, and resumes exact postimage', async () =>
  withFixture(async (fixture) => {
    const archive = await fixture.capture()
    const before = await observe(fixture)
    const plan = await Effect.runPromise(
      prepareSourceAdoption({ capture: archive, target: fixture.target(), eventDefinitions: definitions }),
    )
    const request = {
      opener: fixture.opener,
      plan,
      intent: fixture.intent(plan.planDigest),
      currentTarget: fixture.target(payloadDigest),
      eventDefinitions: definitions,
    }
    const receipt = await Effect.runPromise(adoptSource(request))
    expect(receipt).toMatchObject({ outcome: 'applied', closure: 'joined-maintenance-owner', acknowledgedHead: 1 })
    const after = await observe(fixture)
    expect(after.identity.incarnation).toBe(plan.successorIncarnation)
    expect(after.identity.incarnation).not.toBe(before.identity.incarnation)
    expect(after.backend).toEqual(Option.some('new-backend'))
    expect(after.head).toBe(1)
    expect(after.rows.map(({ event, schemaHash }) => ({ event, schemaHash }))).toEqual(
      before.rows.map(({ event, schemaHash }) => ({ event, schemaHash })),
    )
    expect(after.rows.every((row) => Option.isNone(row.syncMetadata))).toBe(true)
    const restoredPending = after.rows
      .filter((row) => row.event.seqNum.global > 1 || row.event.seqNum.client > 0)
      .map((row) => row.event)
    const merge = await Effect.runPromise(
      SyncState.merge({
        syncState: new SyncState.SyncState({
          pending: restoredPending,
          upstreamHead: sequence(1),
          localHead: fixture.local.event.seqNum,
        }),
        payload: SyncState.PayloadUpstreamAdvance.make({
          newEvents: [LiveStoreEvent.Client.fromGlobal(LiveStoreEvent.Client.toGlobal(fixture.pending.event))],
        }),
        isClientOnlyEvent: (event) => event.name === 'local-only',
        isEqualEvent: LiveStoreEvent.Client.isEqualEncoded,
        ignoreClientOnlyEvents: true,
      }),
    )
    expect(merge._tag).toBe('advance')
    if (merge._tag !== 'advance') throw new Error('Expected ordinary confirmation')
    expect(merge.newEvents).toEqual([])
    expect(merge.confirmedEvents).toContainEqual(fixture.pending.event)
    expect(merge.newSyncState.pending.filter((event) => event.name !== 'local-only')).toEqual([])
    expect(after.rows.find((row) => row.event.name === 'local-only')!.event).toEqual(fixture.local.event)
    const replayed = await Effect.runPromise(adoptSource(request))
    expect(replayed.outcome).toBe('already-applied')
    expect(await observe(fixture)).toEqual(after)
  }))

test('unknown or wrong producer classification refuses preparation and preserves capture', async () =>
  withFixture(async (fixture) => {
    const capture = await fixture.capture(),
      before = await observe(fixture)
    for (const eventDefinitions of [
      [],
      definitions.map((definition) => ({ ...definition, schemaHash: 99 })),
      definitions.map((definition) => ({ ...definition, clientOnly: !definition.clientOnly })),
    ]) {
      expect(
        (await Effect.runPromiseExit(prepareSourceAdoption({ capture, target: fixture.target(), eventDefinitions })))
          ._tag,
      ).toBe('Failure')
    }
    expect(await observe(fixture)).toEqual(before)
    expect((await fixture.capture()).receipt.snapshot).toEqual(capture.receipt.snapshot)
  }))

test('literal shared client1 shape refuses preparation as unclassified and retains export', async () =>
  withFixture(async (fixture) => {
    const capture = await fixture.capture()
    const result = await Effect.runPromise(
      prepareSourceAdoption({ capture, target: fixture.target(), eventDefinitions: definitions }).pipe(Effect.result),
    )
    expect(result).toMatchObject({ _tag: 'Failure', failure: { code: 'unclassified-source-event' } })
    expect((await fixture.capture()).receipt.snapshot).toEqual(capture.receipt.snapshot)
  }, true))

test('changed source/context/payload/target refuses immutable plan without adoption mutations', async () =>
  withFixture(async (fixture) => {
    const capture = await fixture.capture()
    const plan = await Effect.runPromise(
      prepareSourceAdoption({ capture, target: fixture.target(), eventDefinitions: definitions }),
    )
    const request = {
      opener: fixture.opener,
      plan,
      intent: fixture.intent(plan.planDigest),
      currentTarget: fixture.target(payloadDigest),
      eventDefinitions: definitions,
    }
    const before = await observe(fixture)
    for (const altered of [
      { ...request, intent: { ...request.intent, binding: { ...binding, context: { changed: true } } } },
      {
        ...request,
        intent: { ...request.intent, payloadDigest: 'b'.repeat(64) },
        currentTarget: fixture.target('b'.repeat(64)),
      },
      { ...request, currentTarget: { ...request.currentTarget, backendId: 'unexpected-backend' } },
    ]) {
      expect((await Effect.runPromiseExit(adoptSource(altered)))._tag).toBe('Failure')
      expect(await observe(fixture)).toEqual(before)
    }
    await Effect.runPromise(
      withRetainedSource(fixture.opener, binding, (source) =>
        source.write((tx) =>
          tx.execute('UPDATE eventlog SET argsJson = ? WHERE seqNumGlobal = 2 AND seqNumClient = 0', [
            '{"actionId":"drift"}',
          ]),
        ),
      ),
    )
    const drifted = await observe(fixture)
    expect((await Effect.runPromiseExit(adoptSource(request)))._tag).toBe('Failure')
    expect(await observe(fixture)).toEqual(drifted)
  }))

test('committed adoption with failed close acknowledgement never publishes a closed receipt', async () =>
  withFixture(async (fixture) => {
    const capture = await fixture.capture()
    const plan = await Effect.runPromise(
      prepareSourceAdoption({ capture, target: fixture.target(), eventDefinitions: definitions }),
    )
    fixture.failClose()
    const result = await Effect.runPromise(
      adoptSource({
        opener: fixture.opener,
        plan,
        intent: fixture.intent(plan.planDigest),
        currentTarget: fixture.target(payloadDigest),
        eventDefinitions: definitions,
      }).pipe(Effect.result),
    )
    expect(result).toMatchObject({ _tag: 'Failure', failure: { code: 'adoption-unclosed', commitStatus: 'committed' } })
    expect(fixture.held()).toBe(true)
  }))
