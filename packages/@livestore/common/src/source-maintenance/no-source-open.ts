import { Effect } from '@livestore/utils/effect'

import { SourceMaintenanceError } from './types.ts'

/** Only the SDK SOURCE boundary is attested; nested caller stream/sink resource failures remain intact. */
export const noSourceOpen = <A, R>(effect: Effect.Effect<A, SourceMaintenanceError, R>) =>
  effect.pipe(Effect.mapError((error) => new SourceMaintenanceError(error.code, error, 'not-started', 'joined')))
