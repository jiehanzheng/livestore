import { Effect, Schema } from '@livestore/utils/effect'

import type { StoredEvent } from '../source-db/rows.ts'
import { digest } from './codec.ts'
import type { PrefixCoverage } from './types.ts'

/** Generations retain local coordinates; global history identity does not include those coordinates or transport metadata. */
export const logicalPrefixProjection = ({ event }: StoredEvent) => ({
  seqNum: event.seqNum.global,
  parentSeqNum: event.parentSeqNum.global,
  name: event.name,
  args: event.args,
  clientId: event.clientId,
  sessionId: event.sessionId,
})
const equivalentJson = Schema.toEquivalence(Schema.Json)

export const makeCoverage = (head: number) =>
  Effect.gen(function* () {
    let provenThrough = 0
    let status: PrefixCoverage['status'] = 'complete'
    let reason: string | null = null
    let commitment = yield* digest(['source-recovery-prefix', 1])
    let currentGlobal = 0
    let group: StoredEvent[] = []
    const refuse = (next: 'incomplete' | 'conflicting', message: string) => {
      if (status === 'complete') {
        status = next
        reason = message
      }
    }
    const flush = () =>
      Effect.gen(function* () {
        if (group.length === 0) return
        const first = group[0]!
        if (status === 'complete') {
          if (currentGlobal !== provenThrough + 1) refuse('incomplete', `Missing confirmed global ${provenThrough + 1}`)
          else {
            const body = logicalPrefixProjection(first)
            for (const item of group) {
              const parent = item.event.parentSeqNum
              // Only the global parent crosses the transport; local client/generation coordinates stay raw evidence.
              if (parent.global !== currentGlobal - 1) {
                refuse('incomplete', `Missing confirmed parent at global ${currentGlobal}`)
                break
              }
              if (equivalentJson(logicalPrefixProjection(item), body) === false) {
                refuse('conflicting', `Conflicting confirmed generations at global ${currentGlobal}`)
                break
              }
            }
            if (status === 'complete') {
              commitment = yield* digest(['source-recovery-prefix', 1, currentGlobal, commitment, body])
              provenThrough = currentGlobal
            }
          }
        }
        group = []
      })
    return {
      add: (items: readonly StoredEvent[]) =>
        Effect.gen(function* () {
          for (const item of items) {
            const seq = item.event.seqNum
            if (seq.client !== 0 || seq.global > head) continue
            if (seq.global !== currentGlobal) {
              yield* flush()
              currentGlobal = seq.global
            }
            group.push(item)
          }
        }),
      finish: () =>
        Effect.gen(function* () {
          yield* flush()
          if (provenThrough !== head) refuse('incomplete', `Missing confirmed global ${provenThrough + 1}`)
          return { acknowledgedHead: head, provenThrough, status, reason, digest: commitment } satisfies PrefixCoverage
        }),
    }
  })
