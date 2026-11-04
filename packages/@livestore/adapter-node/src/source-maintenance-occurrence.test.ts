import { expect, test } from 'vitest'

import { SyncState } from '@livestore/common'
import { EventSequenceNumber, LiveStoreEvent } from '@livestore/common/schema'
import { SourceEvents } from '@livestore/common/source-db'
import { prepareSourceAdoption } from '@livestore/common/source-maintenance'
import { withRetainedSource } from '@livestore/common/source-maintenance/internal'
import { Effect, Result } from '@livestore/utils/effect'

import { binding, definitions, sequence, withFixture } from './source-maintenance-adoption-fixture.ts'

const merge = (
  pending: readonly LiveStoreEvent.Client.Encoded[],
  incoming: LiveStoreEvent.Client.Encoded,
  upstreamHead = sequence(1),
) =>
  Effect.runPromise(
    SyncState.merge({
      syncState: new SyncState.SyncState({
        pending: [...pending],
        upstreamHead,
        localHead: pending.at(-1)!.seqNum,
      }),
      payload: SyncState.PayloadUpstreamAdvance.make({ newEvents: [incoming] }),
      isClientOnlyEvent: (event) => event.name === 'local-only',
      isEqualEvent: LiveStoreEvent.Client.isEqualEncoded,
      ignoreClientOnlyEvents: true,
    }),
  )

test('same-body repeated attempts confirm the exact first position and preserve the later occurrence', async () =>
  withFixture(async (fixture) => {
    const later = {
      ...fixture.pending,
      event: { ...fixture.pending.event, seqNum: sequence(3, 0, 3), parentSeqNum: sequence(2, 0, 3) },
    }
    await Effect.runPromise(
      withRetainedSource(fixture.opener, binding, (source) => source.write((tx) => SourceEvents.insert(tx, [later]))),
    )
    const incoming = LiveStoreEvent.Client.fromGlobal(LiveStoreEvent.Client.toGlobal(fixture.pending.event))
    const reconciled = await merge([fixture.pending.event, fixture.local.event, later.event], incoming)
    expect(reconciled._tag).toBe('advance')
    if (reconciled._tag !== 'advance') throw new Error('Expected ordinary exact-position confirmation')
    expect(reconciled.confirmedEvents.filter((event) => event.name === 'shared')).toEqual([fixture.pending.event])
    expect(reconciled.newSyncState.pending.filter((event) => event.name === 'shared')).toEqual([later.event])
    expect(reconciled.newEvents).toEqual([])
    const capture = await fixture.capture()
    expect(capture.receipt.snapshot.rows).toBe(4)
    const prepared = await Effect.runPromise(
      Effect.result(prepareSourceAdoption({ capture, target: fixture.target(), eventDefinitions: definitions })),
    )
    // Recovery must preserve both legitimate occurrences, as ordinary reconciliation does.
    expect(Result.isSuccess(prepared)).toBe(true)
  }))

test('normal shared allocation after client-only work normalizes its wire parent and ACK leaves it unchanged', async () =>
  withFixture(async (fixture) => {
    const localPair = EventSequenceNumber.Client.nextPair({ seqNum: fixture.first.event.seqNum, isClientOnly: true })
    const local = { ...fixture.local, event: { ...fixture.local.event, ...localPair } }
    const sharedPair = EventSequenceNumber.Client.nextPair({ seqNum: local.event.seqNum, isClientOnly: false })
    const shared = { ...fixture.pending, event: { ...fixture.pending.event, ...sharedPair } }
    expect(local.event.seqNum.client).toBe(1)
    expect(shared.event.parentSeqNum).toEqual(fixture.first.event.seqNum)
    const incoming = LiveStoreEvent.Client.fromGlobal(LiveStoreEvent.Client.toGlobal(shared.event))
    const reconciled = await merge([local.event, shared.event], incoming)
    expect(reconciled._tag).toBe('advance')
    if (reconciled._tag !== 'advance') throw new Error('Expected normal acknowledgement')
    expect(reconciled.confirmedEvents).toContainEqual(shared.event)
    await Effect.runPromise(
      withRetainedSource(fixture.opener, binding, (source) =>
        source.write((tx) =>
          Effect.gen(function* () {
            yield* tx.execute('DELETE FROM eventlog')
            yield* SourceEvents.insert(tx, [fixture.first, local, shared])
            yield* SourceEvents.updateSyncMetadata(tx, [{ event: incoming, syncMetadata: shared.syncMetadata }])
            yield* SourceEvents.updateBackendHead(tx, shared.event.seqNum.global)
          }),
        ),
      ),
    )
    const capture = await fixture.capture()
    expect(capture.receipt.coverage).toMatchObject({ acknowledgedHead: 2, provenThrough: 2, status: 'complete' })
    expect(capture.receipt.snapshot.rows).toBe(3)
  }))

test('rebasing client-only work can produce a shared wire parent whose generation is absent at the prior global', async () =>
  withFixture(async (fixture) => {
    const local = {
      ...fixture.local.event,
      ...EventSequenceNumber.Client.nextPair({ seqNum: fixture.first.event.seqNum, isClientOnly: true }),
    }
    const pending = {
      ...fixture.pending.event,
      ...EventSequenceNumber.Client.nextPair({ seqNum: local.seqNum, isClientOnly: false }),
    }
    const remote = {
      ...LiveStoreEvent.Client.fromGlobal(LiveStoreEvent.Client.toGlobal(pending)),
      args: { differentRemote: true },
    }
    const rebased = await merge([local, pending], remote)
    expect(rebased._tag).toBe('rebase')
    if (rebased._tag !== 'rebase') throw new Error('Expected divergent upstream rebase')
    const [rebasedLocal, rebasedShared] = rebased.newSyncState.pending
    expect(rebasedLocal!.seqNum).toEqual(sequence(2, 1, 1))
    expect(rebasedShared!.seqNum).toEqual(sequence(3, 0, 1))
    expect(rebasedShared!.parentSeqNum).toEqual(sequence(2, 0, 1))
    expect(remote.seqNum).toEqual(sequence(2))
    const ack = await merge(
      [rebasedLocal!, rebasedShared!],
      LiveStoreEvent.Client.fromGlobal(LiveStoreEvent.Client.toGlobal(rebasedShared!)),
      sequence(2),
    )
    expect(ack._tag).toBe('advance')
    // Insert the merge's exact output as historical raw evidence; normal development parent validation is stricter.
    await Effect.runPromise(
      withRetainedSource(fixture.opener, binding, (source) =>
        source.write((tx) =>
          Effect.gen(function* () {
            yield* tx.execute('DELETE FROM eventlog')
            yield* SourceEvents.insert(tx, [
              fixture.first,
              { ...fixture.pending, event: remote },
              { ...fixture.local, event: rebasedLocal! },
              { ...fixture.pending, event: rebasedShared! },
            ])
            yield* SourceEvents.updateBackendHead(tx, sequence(3).global)
          }),
        ),
      ),
    )
    const capture = await fixture.capture()
    expect(capture.receipt.coverage).toMatchObject({ acknowledgedHead: 3, provenThrough: 3, status: 'complete' })
    expect(capture.receipt.coverage.reason).toBeNull()
  }))

for (const variant of ['gap', 'wire-conflict'] as const)
  test(`repeated-body residual ${variant} refuses preparation`, async () =>
    withFixture(async (fixture) => {
      await Effect.runPromise(
        withRetainedSource(fixture.opener, binding, (source) =>
          source.write((tx) =>
            variant === 'gap'
              ? SourceEvents.insert(tx, [
                  {
                    ...fixture.pending,
                    event: { ...fixture.pending.event, seqNum: sequence(4, 0, 3), parentSeqNum: sequence(3, 0, 3) },
                  },
                ])
              : tx.execute('UPDATE eventlog SET argsJson=? WHERE seqNumGlobal=2 AND seqNumClient=0', [
                  '{"differentWireOccurrence":true}',
                ]),
          ),
        ),
      )
      const result = await Effect.runPromise(
        Effect.result(
          prepareSourceAdoption({
            capture: await fixture.capture(),
            target: fixture.target(),
            eventDefinitions: definitions,
          }),
        ),
      )
      expect(Result.isFailure(result)).toBe(true)
      if (Result.isFailure(result) === true)
        expect(result.failure.code).toBe(
          variant === 'gap' ? 'residual-position-conflict' : 'target-occurrence-conflict',
        )
    }))
