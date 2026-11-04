import { Effect } from 'effect'

import { sourceLifecycle } from './lifecycle.ts'
import { SourceDbError, type SourceHandle } from './role.ts'

const freshBrand: unique symbol = Symbol('FreshSource')
export interface FreshSource {
  readonly [freshBrand]: true
}
export interface OwnedCreationBoundary {
  readonly storageName: string
  readonly kind:
    | 'new-memory-connection'
    | 'exclusive-indexed-db-creation'
    | 'exclusive-node-file-creation'
    | 'exclusive-opfs-source-association'
    | 'exclusive-expo-source-namespace'
    | 'exclusive-native-source-namespace'
  readonly isHeld: () => boolean
}
const bindings = new WeakMap<FreshSource, { source: SourceHandle; boundary: OwnedCreationBoundary; epoch: number }>()
const issued = new WeakSet<SourceHandle>()
const issuedBoundaries = new WeakSet<OwnedCreationBoundary>()
const bySource = new WeakMap<SourceHandle, FreshSource>()

/** Internal allocator boundary, deliberately absent from the public role barrel.
 * Only an owned native creation path may call this; discovery booleans and empty tables are not creation.
 */
export const bindFreshSource = (source: SourceHandle, boundary: OwnedCreationBoundary): FreshSource => {
  if (
    issued.has(source) === true ||
    issuedBoundaries.has(boundary) === true ||
    boundary.storageName === '' ||
    boundary.isHeld() === false
  )
    throw new Error('SOURCE creation is not owned or was already issued')
  const fresh: FreshSource = Object.freeze({ [freshBrand]: true as const })
  issued.add(source)
  issuedBoundaries.add(boundary)
  bindings.set(fresh, { source, boundary: Object.freeze({ ...boundary }), epoch: source[sourceLifecycle].epoch })
  bySource.set(source, fresh)
  return fresh
}

export const invalidateFreshSource = (source: SourceHandle): void => {
  const fresh = bySource.get(source)
  if (fresh !== undefined) bindings.delete(fresh)
  bySource.delete(source)
}

/** Consume before waiting for initialization admission: cancellation/failure cannot recycle a creation receipt. */
export const consumeFreshSource = (source: SourceHandle, fresh: FreshSource): Effect.Effect<void, SourceDbError> =>
  Effect.try({
    try: () => {
      const binding = bindings.get(fresh)
      if (binding !== undefined) {
        bindings.delete(fresh)
        bySource.delete(binding.source)
      }
      if (
        binding === undefined ||
        binding.source !== source ||
        binding.epoch !== source[sourceLifecycle].epoch ||
        source[sourceLifecycle].phase !== 'open' ||
        binding.boundary.isHeld() === false
      )
        throw new Error('Missing, spent, foreign or unowned SOURCE creation receipt')
    },
    catch: (cause) => new SourceDbError({ operation: 'initialize', cause }),
  })
