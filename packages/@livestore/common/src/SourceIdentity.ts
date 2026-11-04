/** Persisted SOURCE identity, validated by the canonical Effect domain. */
export interface SourceIdentity {
  readonly formatVersion: number
  readonly incarnation: string
}
export { read, rotate as rotateWithinTransaction } from './source-db/identity.ts'
export { assertInitialized, initializeSource, type InitializedSource } from './source-db/admission.ts'
