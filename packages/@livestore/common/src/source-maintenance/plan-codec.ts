import { Effect, Schema } from '@livestore/utils/effect'

import { liveStoreStorageFormatVersion } from '../version.ts'
import { boundedBinding, encode, ownJson } from './codec.ts'
import { applicationBindingCodec, captureLimitsCodec, sourceSnapshotCodec } from './model-codecs.ts'
import { noSourceOpen } from './no-source-open.ts'
import { adoptionPlanDigest, plannedPostimage, snapshotDigest } from './prepare.ts'
import { SourceMaintenanceError, type RecoveryAdoptionPlan } from './types.ts'

// Keep runtime restoration and the public structural type aligned; applications own only their outer envelope.
const planCodec: Schema.Codec<RecoveryAdoptionPlan> = Schema.Struct({
  contract: Schema.Literal('livestore-source-adoption-v1'),
  binding: applicationBindingCodec,
  captureDigest: Schema.String,
  expected: sourceSnapshotCodec,
  limits: captureLimitsCodec,
  targetBackendId: Schema.String,
  targetHead: Schema.Finite,
  targetPrefixDigest: Schema.String,
  targetWitnessDigest: Schema.String,
  successorIncarnation: Schema.String,
  postimageDigest: Schema.String,
  eventDefinitionsDigest: Schema.String,
  policy: Schema.Literal('position-preserving-preserve-residual'),
  planDigest: Schema.String,
})
const fail = (code: string, cause: unknown) => new SourceMaintenanceError(code, cause)

/** Restore SDK-owned JSON, not authorization: adoption still verifies the actual SOURCE and current target under its real owner. */
export const decodeSourceAdoptionPlan = (input: unknown): Effect.Effect<RecoveryAdoptionPlan, SourceMaintenanceError> =>
  Effect.gen(function* () {
    const owned = yield* Effect.try({ try: () => ownJson(input), catch: (cause) => fail('plan-json', cause) })
    if (new TextEncoder().encode(encode(owned)).length > 1024 * 1024)
      return yield* Effect.fail(fail('plan-limit', 'Persisted SDK plan exceeds bounded JSON budget'))
    const plan = yield* Schema.decodeUnknownEffect(planCodec)(owned).pipe(
      Effect.mapError((cause) => fail('plan-codec', cause)),
    )
    yield* Effect.try({ try: () => boundedBinding(plan.binding), catch: (cause) => fail('plan-binding', cause) })
    const numbers = [plan.expected.rows, plan.expected.acknowledgedHead, plan.targetHead]
    if (
      numbers.every((value) => Number.isSafeInteger(value) && value >= 0) === false ||
      Object.values(plan.limits).every((value) => Number.isSafeInteger(value) && value > 0) === false ||
      plan.expected.rows > plan.limits.maxRows ||
      plan.targetHead > plan.limits.maxRows ||
      plan.targetHead < plan.expected.acknowledgedHead ||
      plan.expected.sourceIdentity.formatVersion !== liveStoreStorageFormatVersion ||
      plan.expected.sourceIdentity.incarnation.trim().length === 0 ||
      plan.successorIncarnation.trim().length === 0 ||
      plan.successorIncarnation === plan.expected.sourceIdentity.incarnation ||
      plan.targetBackendId.trim().length === 0 ||
      plan.targetBackendId === plan.expected.backendId ||
      (plan.expected.backendId !== null && plan.expected.backendId.trim().length === 0)
    )
      return yield* Effect.fail(
        fail('plan-semantics', 'Invalid SOURCE format, identity, head, backend or bounded limits'),
      )
    const hashes = [
      plan.captureDigest,
      plan.expected.rowDigest,
      plan.expected.eventDigest,
      plan.expected.clearedMetadataRowDigest,
      plan.expected.schemaDigest,
      plan.targetPrefixDigest,
      plan.targetWitnessDigest,
      plan.postimageDigest,
      plan.eventDefinitionsDigest,
      plan.planDigest,
    ]
    if (hashes.every((value) => /^[a-f0-9]{64}$/.test(value)) === false)
      return yield* Effect.fail(fail('plan-digest', 'Invalid SHA256 commitment encoding'))
    const { planDigest, ...base } = plan
    if (
      (yield* adoptionPlanDigest(base)) !== planDigest ||
      (yield* snapshotDigest(plannedPostimage(plan))) !== plan.postimageDigest
    )
      return yield* Effect.fail(fail('plan-digest', 'Persisted plan or planned postimage commitment differs'))
    return ownJson(plan)
  }).pipe(noSourceOpen)
