import type { SourceIdentity } from './SourceIdentity.ts'
import type { SqliteDb } from './sqlite-types.ts'

const initializedSourceBrand: unique symbol = Symbol('livestore.InitializedSource')

export interface InitializedSource {
  readonly [initializedSourceBrand]: true
  readonly identity: SourceIdentity
  readonly sourceIsNew: boolean
}

const bindings = new WeakMap<InitializedSource, { db: SqliteDb; identity: SourceIdentity }>()

/** Package-private minting: only the SDK's successful initialization phase calls this function. */
export const bindInitializedSource = (
  db: SqliteDb,
  identity: SourceIdentity,
  sourceIsNew: boolean,
): InitializedSource => {
  const immutableIdentity = Object.freeze({ ...identity })
  const context: InitializedSource = Object.freeze({
    [initializedSourceBrand]: true as const,
    identity: immutableIdentity,
    sourceIsNew,
  })
  bindings.set(context, { db, identity: immutableIdentity })
  return context
}

export const getInitializedSourceBinding = (context: InitializedSource) => bindings.get(context)
