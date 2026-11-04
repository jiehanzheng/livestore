import { Effect, Exit, type Scope } from '@livestore/utils/effect'

import { acquireSourceAuthority, type SourceAuthority } from '../../source/creation.ts'
import { consumeOpfsSourceAssociation, type OpfsSourceAssociation } from './source-association.ts'

const namespaceBrand: unique symbol = Symbol('OpfsSourceNamespace')
const inventoryBrand: unique symbol = Symbol('OpfsSourceInventory')
export interface OpfsSourceNamespace {
  readonly [namespaceBrand]: true
  readonly directory: string
  readonly isHeld: () => boolean
}
export interface OpfsSourceInventory {
  readonly [inventoryBrand]: true
}
export interface OpfsSourceCreation {
  readonly storageName: string
  readonly kind: 'exclusive-opfs-source-association'
  readonly isHeld: () => boolean
}

type NamespaceBinding = { authority: SourceAuthority; closed: boolean }
type InventoryBinding = { namespace: OpfsSourceNamespace; sourceWasAbsent: boolean }
const namespaces = new WeakMap<OpfsSourceNamespace, NamespaceBinding>()
const inventories = new WeakMap<OpfsSourceInventory, InventoryBinding>()
// Failed physical teardown must keep the real callback and its held namespace authority reachable.
const quarantined = new Set<OpfsSourceNamespace>()

export const acquireOpfsSourceNamespace = ({
  locks,
  directory,
  closePhysicalOwner,
}: {
  locks: LockManager
  directory: string
  closePhysicalOwner: Effect.Effect<void>
}): Effect.Effect<OpfsSourceNamespace, Effect.Error<ReturnType<typeof acquireSourceAuthority>>, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.gen(function* () {
      const authority = yield* acquireSourceAuthority(locks, `opfs:${directory}`)
      const binding: NamespaceBinding = { authority, closed: false }
      const namespace: OpfsSourceNamespace = Object.freeze({
        [namespaceBrand]: true as const,
        directory,
        isHeld: () => binding.closed === false && authority.isHeld(),
      })
      namespaces.set(namespace, binding)
      return namespace
    }),
    (namespace) =>
      Effect.gen(function* () {
        const binding = namespaces.get(namespace)!
        const result = yield* Effect.exit(closePhysicalOwner)
        if (Exit.isFailure(result) === true) {
          quarantined.add(namespace)
          return yield* Effect.failCause(result.cause)
        }
        yield* Effect.promise(() => binding.authority.release()).pipe(
          Effect.onExit((exit) =>
            Effect.sync(() => {
              if (Exit.isFailure(exit) === true) quarantined.add(namespace)
            }),
          ),
        )
        binding.closed = true
        quarantined.delete(namespace)
      }),
  )

/** Internal scanner API. An inventory is advisory and cannot itself authorize initialization. */
export const certifyOpfsSourceInventory = (
  namespace: OpfsSourceNamespace,
  directory: string,
  sourceWasAbsent: boolean,
): OpfsSourceInventory => {
  if (namespaces.has(namespace) === false || namespace.directory !== directory || namespace.isHeld() === false) {
    throw new Error('OPFS SOURCE inventory requires its exact live namespace authority')
  }
  const inventory: OpfsSourceInventory = Object.freeze({ [inventoryBrand]: true as const })
  inventories.set(inventory, { namespace, sourceWasAbsent })
  return inventory
}

/** Consume before any permissive VFS pool initialization or native SQLite open. */
export const consumeOpfsSourceInventory = (inventory: OpfsSourceInventory, directory: string): InventoryBinding => {
  const binding = inventories.get(inventory)
  inventories.delete(inventory)
  if (binding === undefined || binding.namespace.directory !== directory || binding.namespace.isHeld() === false) {
    throw new Error('OPFS SOURCE inventory is missing, spent, foreign or no longer owned')
  }
  return binding
}

export const creationFromOpfsAssociation = (
  inventory: InventoryBinding,
  association: OpfsSourceAssociation | undefined,
): OpfsSourceCreation | undefined => {
  if (inventory.sourceWasAbsent === false || association === undefined) return undefined
  const associationHeld = consumeOpfsSourceAssociation(association, inventory.namespace.directory)
  return Object.freeze({
    storageName: `opfs:${inventory.namespace.directory}/eventlog.db`,
    kind: 'exclusive-opfs-source-association' as const,
    isHeld: () => inventory.namespace.isHeld() && associationHeld(),
  })
}
