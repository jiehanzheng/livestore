import type * as SQLite from 'expo-sqlite'

const allocationBrand: unique symbol = Symbol('ExpoSourceAllocation')
export interface ExpoSourceAllocation {
  readonly [allocationBrand]: true
}
export interface ExpoSourceCreation {
  readonly storageName: string
  readonly kind: 'exclusive-expo-source-namespace'
  readonly isHeld: () => boolean
}
export interface ExpoSourceOwner {
  readonly isHeld: () => boolean
  readonly closed: () => void
}

const allocations = new WeakMap<ExpoSourceAllocation, string>()

/** Package-internal: only a completed exclusive native namespace creation may issue this receipt. */
export const allocateExpoSourceReceipt = (storageName: string): ExpoSourceAllocation => {
  const allocation: ExpoSourceAllocation = Object.freeze({ [allocationBrand]: true as const })
  allocations.set(allocation, storageName)
  return allocation
}

/** Burn before native open: a failed or foreign attempt cannot recycle a namespace claim. */
export const consumeExpoSourceAllocation = (allocation: ExpoSourceAllocation, storageName: string): void => {
  const ownedName = allocations.get(allocation)
  allocations.delete(allocation)
  if (ownedName === undefined || ownedName !== storageName) {
    throw new Error('Missing, spent or foreign native SOURCE namespace allocation')
  }
}

export const expoSourceStorageName = (directory: string, databaseName: string): string =>
  `${directory.replace(/\/+$/, '')}/${databaseName}`

/** The exact native connection, rather than a JS adapter flag, retains the SQLite file lock until close. */
export const acquireExpoSourceOwner = (
  db: Pick<SQLite.SQLiteDatabase, 'execSync' | 'getFirstSync'>,
): ExpoSourceOwner => {
  db.execSync('PRAGMA locking_mode=EXCLUSIVE')
  const mode = db.getFirstSync<{ locking_mode: string }>('PRAGMA locking_mode')?.locking_mode
  if (mode !== 'exclusive') throw new Error('Native SOURCE exclusive locking mode is unavailable')
  // A pragma response alone is not acquisition. This statement must obtain the real native file lock.
  db.execSync('BEGIN EXCLUSIVE; COMMIT')
  let held = true
  return {
    isHeld: () => held,
    closed: () => {
      held = false
    },
  }
}
