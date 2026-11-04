import { Effect, Exit, type Scope } from '@livestore/utils/effect'

import type { SourceOwner } from '../source-db/owner.ts'
import type { SourceDbError } from '../source-db/role.ts'
import { boundedBinding, equal, ownJson } from './codec.ts'
import {
  SourceMaintenanceError,
  type ApplicationBinding,
  type DurableIntent,
  type RetainedSourceMaintenanceOpener,
  type SourceMaintenanceLocationOwner,
} from './types.ts'

type Entry = {
  readonly binding: ApplicationBinding
  readonly locationOwner: SourceMaintenanceLocationOwner
  readonly acquire: Effect.Effect<SourceOwner, SourceDbError | SourceMaintenanceError, Scope.Scope>
}
const openers = new WeakMap<RetainedSourceMaintenanceOpener, Entry>()

/** Platform-internal: acquisition must be retained-only and scope every real resource through joined close. */
export const retainedSourceMaintenanceOpener = (entry: Entry): RetainedSourceMaintenanceOpener => {
  const opener = Object.freeze({}) as RetainedSourceMaintenanceOpener
  openers.set(opener, { ...entry, binding: boundedBinding(entry.binding) })
  return opener
}

export const withRetainedSource = <A, E>(
  opener: RetainedSourceMaintenanceOpener,
  binding: ApplicationBinding,
  use: (source: SourceOwner) => Effect.Effect<A, E>,
  intent?: DurableIntent,
): Effect.Effect<A, E | SourceDbError | SourceMaintenanceError> =>
  Effect.suspend(() => {
    const entry = openers.get(opener)
    if (entry === undefined || equal(entry.binding, binding) === false)
      return Effect.fail(
        new SourceMaintenanceError(
          'opener-binding',
          'Foreign opener or changed installation binding',
          'not-started',
          'joined',
        ),
      )
    if (intent !== undefined && equal(intent.binding, binding) === false)
      return Effect.fail(
        new SourceMaintenanceError(
          'intent-binding',
          'Intent differs from the stable capture binding',
          'not-started',
          'joined',
        ),
      )
    const context =
      intent === undefined
        ? { purpose: 'capture' as const, binding }
        : { purpose: 'adoption' as const, binding, intent }
    const scoped = Effect.gen(function* () {
      const state = { acquired: false }
      // Body failure is a value until every registered physical resource finalizer has joined.
      const outer = yield* Effect.exit(
        Effect.scoped(
          Effect.exit(
            Effect.gen(function* () {
              const source = yield* entry.acquire
              state.acquired = true
              if (
                source.persistence.kind === 'native-shared-host' &&
                (yield* source.persistence.host.inTransaction) === true
              )
                return yield* Effect.fail(
                  new SourceMaintenanceError(
                    'borrowed-host-frame',
                    'Maintenance requires its own outer native transaction',
                  ),
                )
              return yield* use(source)
            }),
          ),
        ),
      )
      if (Exit.isFailure(outer) === true)
        return yield* Effect.fail(new SourceMaintenanceError('maintenance-close', outer.cause, 'unknown', 'unknown'))
      if (Exit.isFailure(outer.value) === true)
        return yield* Effect.fail(
          new SourceMaintenanceError(
            'maintenance-body',
            outer.value.cause,
            'not-started',
            state.acquired === true ? 'joined' : 'unknown',
          ),
        )
      return outer.value.value
    })
    return entry.locationOwner.run(ownJson(context), scoped)
  })
