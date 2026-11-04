import { Effect, Exit } from '@livestore/utils/effect'

import { encodedSyncMetadataNone } from '../schema/state/sqlite/system-tables/eventlog-tables.ts'
import * as Identity from '../source-db/identity.ts'
import { decodeStoredEventRows, type StoredEvent } from '../source-db/rows.ts'
import { admitAdoption, classifyAdoption } from './adoption-state.ts'
import { verifyDefinitions } from './definitions.ts'
import { noSourceOpen } from './no-source-open.ts'
import { withRetainedSource } from './opener.ts'
import { snapshotDigest } from './prepare.ts'
import { scanSource } from './scan.ts'
import { assertPositionPreserving, verifyTarget } from './target.ts'
import { SourceMaintenanceError, type AdoptRequest, type ClosedAdoptionReceipt } from './types.ts'

/** One SOURCE transaction adopts the pin/incarnation; durable application intent is managed by its real owner. */
export const adoptSource = (request: AdoptRequest): Effect.Effect<ClosedAdoptionReceipt, SourceMaintenanceError> =>
  Effect.gen(function* () {
    const { plan, intent } = yield* admitAdoption(request)
    const { planDigest } = plan
    const target = yield* verifyTarget(request.currentTarget, plan.binding, plan.limits).pipe(noSourceOpen)
    if (
      target.intentPayloadDigest !== intent.payloadDigest ||
      target.backendId !== plan.targetBackendId ||
      target.head !== plan.targetHead ||
      target.prefixDigest !== plan.targetPrefixDigest
    )
      return yield* Effect.fail(
        new SourceMaintenanceError(
          'adoption-target',
          'Fresh target verification differs from the immutable planned prefix',
          'not-started',
          'joined',
        ),
      )
    let commitStatus: 'not-started' | 'unknown' | 'committed' = 'not-started'
    let closure: 'joined' | 'unknown' = 'unknown'
    const result = yield* Effect.exit(
      withRetainedSource(
        request.opener,
        plan.binding,
        (source) =>
          Effect.gen(function* () {
            const committed = yield* source.write((tx) =>
              Effect.gen(function* () {
                const decoded: StoredEvent[] = []
                const before = yield* scanSource(tx, plan.limits, (_index, rows) =>
                  decodeStoredEventRows(rows).pipe(
                    Effect.tap((items) =>
                      Effect.sync(() => {
                        decoded.push(...items)
                      }),
                    ),
                    Effect.asVoid,
                    Effect.mapError((cause) => new SourceMaintenanceError('adoption-codec', cause)),
                  ),
                )
                if (
                  (yield* verifyDefinitions(request.eventDefinitions, decoded, target.events)) !==
                  plan.eventDefinitionsDigest
                )
                  return yield* Effect.fail(
                    new SourceMaintenanceError(
                      'adoption-definitions',
                      'Current producer definitions differ from the reviewed plan',
                    ),
                  )
                yield* assertPositionPreserving(decoded, target.events, plan.expected.acknowledgedHead)
                const classification = yield* classifyAdoption(plan, before)
                if (classification === 'applied') {
                  commitStatus = 'committed'
                  return { outcome: 'already-applied' as const, snapshot: before.snapshot }
                }
                if (classification !== 'not-applied')
                  return yield* Effect.fail(
                    new SourceMaintenanceError(
                      'adoption-preimage',
                      'SOURCE is neither exact original nor exact planned postimage',
                    ),
                  )
                // Keep every occurrence/coordinate/body and ACK unchanged; only server-specific metadata is obsolete.
                commitStatus = 'unknown'
                yield* tx.execute('UPDATE eventlog SET syncMetadataJson = ?', [encodedSyncMetadataNone()])
                yield* tx.execute('UPDATE __livestore_sync_status SET backendId = ?', [plan.targetBackendId])
                yield* Identity.rotate(tx, plan.successorIncarnation)
                const after = yield* scanSource(tx, plan.limits)
                if (
                  (yield* snapshotDigest(after.snapshot)) !== plan.postimageDigest ||
                  after.snapshot.eventDigest !== plan.expected.eventDigest
                )
                  return yield* Effect.fail(
                    new SourceMaintenanceError(
                      'adoption-postimage',
                      'Atomic SOURCE postimage differs from immutable plan',
                      'unknown',
                    ),
                  )
                return { outcome: 'applied' as const, snapshot: after.snapshot }
              }),
            )
            commitStatus = 'committed'
            return committed
          }),
        intent,
      ).pipe(
        Effect.tapError((error) =>
          Effect.sync(() => {
            if (error instanceof SourceMaintenanceError) closure = error.closure
          }),
        ),
      ),
    )
    if (Exit.isFailure(result) === true)
      return yield* Effect.fail(new SourceMaintenanceError('adoption-unclosed', result.cause, commitStatus, closure))
    return {
      contract: 'livestore-source-adoption-receipt-v1',
      operationId: plan.binding.operationId,
      payloadDigest: intent.payloadDigest,
      planDigest,
      outcome: result.value.outcome,
      sourceIdentityBefore: plan.expected.sourceIdentity,
      sourceIdentityAfter: result.value.snapshot.sourceIdentity,
      backendId: plan.targetBackendId,
      acknowledgedHead: plan.expected.acknowledgedHead,
      rowDigest: result.value.snapshot.rowDigest,
      eventDigest: result.value.snapshot.eventDigest,
      targetWitnessDigest: target.witnessDigest,
      closure: 'joined-maintenance-owner',
    }
  })
