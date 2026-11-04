import { acquireOpfsSourceNamespace } from '@livestore/sqlite-wasm/browser'
import { Effect } from '@livestore/utils/effect'

/** Acquire before discovery; the actual factory close joins STATE, SOURCE and pool handles before lease release. */
export const acquireSourceNamespace = ({
  directory,
  closePhysicalOwner,
  locks = globalThis.navigator?.locks,
}: {
  directory: string
  closePhysicalOwner: Effect.Effect<void>
  locks?: LockManager
}) =>
  Effect.suspend(() => {
    if (locks === undefined) return Effect.die(new Error('OPFS SOURCE requires Web Locks namespace authority'))
    return acquireOpfsSourceNamespace({ locks, directory, closePhysicalOwner })
  })
