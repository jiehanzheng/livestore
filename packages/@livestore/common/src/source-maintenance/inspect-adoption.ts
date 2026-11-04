import { Effect, Exit } from '@livestore/utils/effect'

import { admitAdoption, classifyAdoption } from './adoption-state.ts'
import { withRetainedSource } from './opener.ts'
import { scanSource } from './scan.ts'
import {
  SourceMaintenanceError,
  type InspectSourceAdoptionRequest,
  type ClosedSourceAdoptionInspection,
} from './types.ts'

/** Resolve an uncertain local outcome even when network access has been revoked; this never authorizes activation. */
export const inspectSourceAdoption = (
  request: InspectSourceAdoptionRequest,
): Effect.Effect<ClosedSourceAdoptionInspection, SourceMaintenanceError> =>
  Effect.gen(function* () {
    const { plan, intent } = yield* admitAdoption(request)
    let closure: 'joined' | 'unknown' = 'unknown'
    const result = yield* Effect.exit(
      withRetainedSource(
        request.opener,
        plan.binding,
        // The existing outer transaction supplies a consistent scan; its body performs SELECTs only.
        (source) =>
          source.write((tx) =>
            scanSource(tx, plan.limits).pipe(Effect.flatMap((scan) => classifyAdoption(plan, scan))),
          ),
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
      return yield* Effect.fail(
        new SourceMaintenanceError('adoption-inspection-unclosed', result.cause, 'not-started', closure),
      )
    return {
      contract: 'livestore-source-adoption-inspection-v1',
      operationId: plan.binding.operationId,
      payloadDigest: intent.payloadDigest,
      planDigest: plan.planDigest,
      outcome: result.value,
      closure: 'joined-maintenance-owner',
    }
  })
