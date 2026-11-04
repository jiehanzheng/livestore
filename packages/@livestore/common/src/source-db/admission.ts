import { Effect } from '@livestore/utils/effect'

import type { SourceIdentity } from '../SourceIdentity.ts'
import { bindFreshSource, consumeFreshSource } from './freshness.ts'
import * as Identity from './identity.ts'
import { sourceLifecycle } from './lifecycle.ts'
import { hasRetainedSourceNamespace } from './namespace.ts'
import type { SourceOwner } from './owner.ts'
import { fenceSource, type SourceHandle } from './role.ts'
import { listSourceTables } from './schema.ts'

const initializedBrand: unique symbol = Symbol('InitializedSource')
export interface InitializedSource {
  readonly [initializedBrand]: true
  readonly identity: SourceIdentity
}
const initialized = new WeakMap<InitializedSource, { source: SourceHandle; epoch: number }>()

/** The only successful initialization-proof registry; allocation permits do not enter this registry. */
const bindInitialized = (source: SourceHandle, identity: SourceIdentity): InitializedSource => {
  const proof = Object.freeze({ [initializedBrand]: true as const, identity: Object.freeze({ ...identity }) })
  initialized.set(proof, { source, epoch: source[sourceLifecycle].epoch })
  return proof
}

/** Run before STATE allocation. Native namespace creation is part of the genuine host transaction. */
export const initializeSource = (owner: SourceOwner) =>
  Effect.gen(function* () {
    const epoch = owner.handle[sourceLifecycle].epoch
    if (owner.persistence.kind === 'native-shared-host' && (yield* owner.persistence.host.inTransaction) === true) {
      // A nested host callback has only staged writes; it cannot mint a successful durable initialization proof.
      return yield* owner.write(() =>
        Effect.fail(
          fenceSource(
            owner.handle,
            'initialize',
            'SOURCE initialization must finish its outer native host transaction before STATE admission',
          ),
        ),
      )
    }
    let identity: SourceIdentity
    if (owner.fresh !== undefined) {
      yield* consumeFreshSource(owner.handle, owner.fresh)
      identity = yield* owner.write((transaction) => Identity.initializeWithinTransaction(transaction, epoch))
    } else if (owner.persistence.kind === 'native-shared-host') {
      identity = yield* owner.write((transaction) =>
        Effect.gen(function* () {
          const tables = yield* listSourceTables(transaction)
          if (hasRetainedSourceNamespace(tables) === true) return yield* Identity.read(transaction)
          const fresh = bindFreshSource(owner.handle, {
            storageName: owner.storageName,
            kind: 'exclusive-native-source-namespace',
            isHeld: () => owner.handle[sourceLifecycle].phase === 'open',
          })
          yield* consumeFreshSource(owner.handle, fresh)
          return yield* Identity.initializeWithinTransaction(transaction, epoch)
        }),
      )
    } else {
      identity = yield* Identity.read(owner.handle)
    }
    if (epoch !== owner.handle[sourceLifecycle].epoch || owner.handle[sourceLifecycle].phase !== 'open') {
      return yield* Effect.fail(fenceSource(owner.handle, 'initialize', 'SOURCE owner changed during initialization'))
    }
    return bindInitialized(owner.handle, identity)
  })

/** Revalidation is read-only; a copied token, foreign handle or changed owner cannot authorize STATE. */
export const assertInitialized = (source: SourceHandle, proof: InitializedSource) =>
  Effect.gen(function* () {
    const binding = initialized.get(proof)
    if (
      binding === undefined ||
      binding.source !== source ||
      binding.epoch !== source[sourceLifecycle].epoch ||
      source[sourceLifecycle].phase !== 'open'
    ) {
      return yield* Effect.fail(
        fenceSource(source, 'admit', 'Missing, stale or foreign successful SOURCE initialization proof'),
      )
    }
    const identity = yield* Identity.read(source)
    if (binding.epoch !== source[sourceLifecycle].epoch || source[sourceLifecycle].phase !== 'open') {
      return yield* Effect.fail(
        fenceSource(source, 'admit', 'SOURCE owner changed during initialization-proof revalidation'),
      )
    }
    if (
      identity.formatVersion !== proof.identity.formatVersion ||
      identity.incarnation !== proof.identity.incarnation
    ) {
      return yield* Effect.fail(fenceSource(source, 'admit', 'SOURCE identity changed after successful initialization'))
    }
    return identity
  })
