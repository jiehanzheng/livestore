import { Effect } from '@livestore/utils/effect'
import { nanoid } from '@livestore/utils/nanoid'

import { readCaptureArchive } from './archive.ts'
import { digest, equal, ownJson } from './codec.ts'
import { verifyDefinitions } from './definitions.ts'
import { noSourceOpen } from './no-source-open.ts'
import { assertPositionPreserving, verifyTarget } from './target.ts'
import {
  SourceMaintenanceError,
  type PrepareAdoptionRequest,
  type RecoveryAdoptionPlan,
  type SourceSnapshot,
} from './types.ts'

export const snapshotDigest = (snapshot: SourceSnapshot) => digest(['source-recovery-state', 1, snapshot])
export const plannedPostimage = (
  plan: Pick<RecoveryAdoptionPlan, 'expected' | 'successorIncarnation' | 'targetBackendId'>,
): SourceSnapshot => ({
  ...plan.expected,
  sourceIdentity: { ...plan.expected.sourceIdentity, incarnation: plan.successorIncarnation },
  backendId: plan.targetBackendId,
  rowDigest: plan.expected.clearedMetadataRowDigest,
})
export const adoptionPlanDigest = (plan: Omit<RecoveryAdoptionPlan, 'planDigest'>) =>
  digest(['source-recovery-adoption-plan', 1, plan])

/** Pure preparation reads immutable capture/verification streams; it opens and mutates no local SOURCE. */
export const prepareSourceAdoption = (
  request: PrepareAdoptionRequest,
): Effect.Effect<RecoveryAdoptionPlan, SourceMaintenanceError> =>
  Effect.gen(function* () {
    const { receipt, decoded } = yield* readCaptureArchive(request.capture)
    if (receipt.coverage.status !== 'complete' || receipt.coverage.provenThrough !== receipt.snapshot.acknowledgedHead)
      return yield* Effect.fail(new SourceMaintenanceError('incomplete-acknowledged-prefix', receipt.coverage))
    const target = yield* verifyTarget(request.target, receipt.header.binding, receipt.header.limits)
    if (target.intentPayloadDigest !== null || target.backendId === receipt.snapshot.backendId)
      return yield* Effect.fail(
        new SourceMaintenanceError('prepare-target', 'Preparation requires a new backend and no future intent receipt'),
      )
    const eventDefinitionsDigest = yield* verifyDefinitions(request.eventDefinitions, decoded, target.events)
    yield* assertPositionPreserving(decoded, target.events, receipt.snapshot.acknowledgedHead)
    const successorIncarnation = nanoid()
    if (successorIncarnation === receipt.snapshot.sourceIdentity.incarnation)
      return yield* Effect.fail(
        new SourceMaintenanceError('successor-incarnation', 'Successor must differ from original SOURCE identity'),
      )
    const next = { expected: receipt.snapshot, successorIncarnation, targetBackendId: target.backendId }
    const base: Omit<RecoveryAdoptionPlan, 'planDigest'> = {
      contract: 'livestore-source-adoption-v1',
      binding: receipt.header.binding,
      captureDigest: receipt.captureDigest,
      expected: receipt.snapshot,
      limits: receipt.header.limits,
      targetBackendId: target.backendId,
      targetHead: target.head,
      targetPrefixDigest: target.prefixDigest,
      targetWitnessDigest: target.witnessDigest,
      successorIncarnation,
      postimageDigest: yield* snapshotDigest(plannedPostimage(next)),
      eventDefinitionsDigest,
      policy: 'position-preserving-preserve-residual',
    }
    const plan: RecoveryAdoptionPlan = { ...base, planDigest: yield* adoptionPlanDigest(base) }
    if (equal(plan.expected.sourceIdentity, receipt.header.sourceIdentity) === false)
      return yield* Effect.fail(new SourceMaintenanceError('prepare-identity', 'Capture identity mismatch'))
    return ownJson(plan)
  }).pipe(noSourceOpen)
