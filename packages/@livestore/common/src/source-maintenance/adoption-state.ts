import { Effect } from '@livestore/utils/effect'

import { equal, ownJson } from './codec.ts'
import { noSourceOpen } from './no-source-open.ts'
import { decodeSourceAdoptionPlan } from './plan-codec.ts'
import { snapshotDigest } from './prepare.ts'
import {
  SourceMaintenanceError,
  type DurableIntent,
  type RecoveryAdoptionPlan,
  type SourceSnapshot,
  type PrefixCoverage,
} from './types.ts'

/** Both mutation and local inspection admit the same owned, immutable application intent. */
export const admitAdoption = (request: { readonly plan: RecoveryAdoptionPlan; readonly intent: DurableIntent }) =>
  Effect.gen(function* () {
    const restored = yield* Effect.try({
      try: () => ownJson({ plan: request.plan, intent: request.intent }),
      catch: (cause) => new SourceMaintenanceError('adoption-json', cause),
    })
    const plan = yield* decodeSourceAdoptionPlan(restored.plan)
    const { intent } = restored
    if (
      intent.planDigest !== plan.planDigest ||
      equal(intent.binding, plan.binding) === false ||
      typeof intent.payloadDigest !== 'string' ||
      /^[a-f0-9]{64}$/.test(intent.payloadDigest) === false
    )
      return yield* Effect.fail(
        new SourceMaintenanceError(
          'adoption-intent',
          'Exact immutable application intent differs from the validated SDK plan',
        ),
      )
    return { plan, intent }
  }).pipe(noSourceOpen)

/** Exact raw commitments classify local outcome without implying current server access or authorization. */
export const classifyAdoption = (
  plan: RecoveryAdoptionPlan,
  scan: { readonly snapshot: SourceSnapshot; readonly coverage: PrefixCoverage },
) =>
  Effect.gen(function* () {
    if ((yield* snapshotDigest(scan.snapshot)) === plan.postimageDigest) return 'applied' as const
    if (equal(scan.snapshot, plan.expected) === true && scan.coverage.status === 'complete')
      return 'not-applied' as const
    return 'foreign' as const
  })
