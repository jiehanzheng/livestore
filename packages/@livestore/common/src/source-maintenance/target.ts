import { Effect, Schema, Stream } from '@livestore/utils/effect'

import * as Global from '../schema/LiveStoreEvent/global.ts'
import type { StoredEvent } from '../source-db/rows.ts'
import { digest, encode, equal, ownJson, parseJson } from './codec.ts'
import {
  SourceMaintenanceError,
  type ApplicationBinding,
  type CaptureLimits,
  type TargetVerification,
} from './types.ts'
const fail = (code: string, cause: unknown) => new SourceMaintenanceError(code, cause)
const body = (event: Pick<Global.Encoded, 'name' | 'args' | 'clientId' | 'sessionId'>) => ({
  name: event.name,
  args: event.args,
  clientId: event.clientId,
  sessionId: event.sessionId,
})
const globalProjection = (row: StoredEvent): Global.Encoded => ({
  ...body(row.event),
  seqNum: row.event.seqNum.global,
  parentSeqNum: row.event.parentSeqNum.global,
})

/** Application authenticates this transcript; SDK checks only bounded structure and exact prefix continuity. */
export const verifyTarget = (input: TargetVerification, binding: ApplicationBinding, limits: CaptureLimits) =>
  Effect.gen(function* () {
    const snapshot = yield* Effect.try({
      try: () => ({
        prefix: input.prefix,
        descriptor: ownJson({
          binding: input.binding,
          backendId: input.backendId,
          logicalHead: input.logicalHead,
          witness: input.witness,
          intentPayloadDigest: input.intentPayloadDigest,
        }),
      }),
      catch: (cause) => fail('target-json', cause),
    })
    const { prefix, descriptor: target } = snapshot
    if (
      equal(target.binding, binding) === false ||
      typeof target.backendId !== 'string' ||
      target.backendId.trim().length === 0 ||
      Number.isSafeInteger(target.logicalHead) === false ||
      target.logicalHead < 0 ||
      target.logicalHead > limits.maxRows
    )
      return yield* Effect.fail(
        fail('target-binding', 'Target identity, head or immutable application context differs'),
      )
    let commitment = yield* digest(['source-recovery-target-prefix', 1])
    let bytes = 0
    const events: Global.Encoded[] = []
    yield* Stream.runForEach(prefix, (candidate) =>
      Effect.gen(function* () {
        const event = yield* Schema.decodeEffect(Global.Encoded)(candidate).pipe(
          Effect.mapError((cause) => fail('target-event', cause)),
        )
        if (
          event.seqNum !== events.length + 1 ||
          event.parentSeqNum !== events.length ||
          events.length >= target.logicalHead
        )
          return yield* Effect.fail(
            fail('target-prefix', 'Missing, repeated, relocated or discontinuous target occurrence'),
          )
        const encoded = encode(event),
          size = new TextEncoder().encode(encoded).length
        if (size > limits.maxRowBytes || size > limits.maxBytes - bytes)
          return yield* Effect.fail(fail('target-limit', 'Target prefix exceeds explicit bounded verification budget'))
        const owned = yield* parseJson<Global.Encoded>(encoded)
        commitment = yield* digest(['source-recovery-target-prefix', 1, event.seqNum, commitment, owned])
        events.push(owned)
        bytes += size
      }),
    )
    if (events.length !== target.logicalHead)
      return yield* Effect.fail(fail('target-eof', 'Target did not provide complete prefix through declared head'))
    return {
      backendId: target.backendId,
      binding: target.binding,
      intentPayloadDigest: target.intentPayloadDigest,
      head: target.logicalHead,
      prefixDigest: commitment,
      witnessDigest: yield* digest(target.witness),
      events,
    }
  })

/** No action/body deduplication: an overlapping uncertain occurrence must prove the same retained position. */
export const assertPositionPreserving = (
  rows: readonly StoredEvent[],
  target: readonly Global.Encoded[],
  head: number,
) =>
  Effect.gen(function* () {
    if (target.length < head)
      return yield* Effect.fail(fail('target-before-ack', 'Target omits acknowledged SOURCE history'))
    const confirmed = new Map<number, StoredEvent[]>()
    for (const row of rows) {
      const seq = row.event.seqNum
      if (seq.client === 0) confirmed.set(seq.global, [...(confirmed.get(seq.global) ?? []), row])
    }
    let next = head + 1
    for (const global of [...confirmed.keys()].filter((value) => value > head).sort((left, right) => left - right)) {
      const group = confirmed.get(global)!
      const first = globalProjection(group[0]!)
      if (
        global !== next ||
        first.parentSeqNum !== global - 1 ||
        group.some((row) => equal(globalProjection(row), first) === false) === true
      )
        return yield* Effect.fail(
          fail('residual-position-conflict', 'Retained shared tail is not a contiguous, unambiguous wire history'),
        )
      next++
    }
    for (const event of target) {
      const samePosition = confirmed.get(event.seqNum) ?? []
      if (
        (event.seqNum <= head && samePosition.length === 0) ||
        samePosition.some((row) => equal(globalProjection(row), event) === false) === true
      )
        return yield* Effect.fail(fail('target-occurrence-conflict', 'Confirmed SOURCE and target occurrence differ'))
    }
  })
