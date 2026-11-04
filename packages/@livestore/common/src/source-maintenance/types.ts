import type { Effect, Schema, Stream } from '@livestore/utils/effect'

import type * as GlobalEvent from '../schema/LiveStoreEvent/global.ts'
import type { SourceIdentity } from '../SourceIdentity.ts'

const openerBrand: unique symbol = Symbol('RetainedSourceMaintenanceOpener')
/** Minted by a retained-only platform seam, not a caller's ownership/closed boolean. */
export interface RetainedSourceMaintenanceOpener {
  readonly [openerBrand]: true
}
export type Json = Schema.Json
export interface ApplicationBinding {
  readonly operationId: string
  /** Application-owned location, revision, routing and authorization witness codec; opaque to the SDK. */
  readonly context: Json
}
/** Implemented by the application's actual installation-location owner; this does not authenticate grants. */
export interface SourceMaintenanceLocationOwner {
  run<A, E, R>(
    context: SourceMaintenanceContext,
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | SourceMaintenanceError, R>
}
export type SourceMaintenanceContext =
  | { readonly purpose: 'capture'; readonly binding: ApplicationBinding }
  | { readonly purpose: 'adoption'; readonly binding: ApplicationBinding; readonly intent: DurableIntent }
export interface DurableIntent {
  readonly binding: ApplicationBinding
  /** Opaque actual receipt from the application's durable intent owner; never SDK-created future authority. */
  readonly receipt: Json
  readonly payloadDigest: string
  readonly planDigest: string
}
/** Raw format-7 evidence: JSON text and every retained generation are preserved verbatim. */
export interface SourceRecoveryRow {
  readonly seqNumGlobal: number
  readonly seqNumClient: number
  readonly seqNumRebaseGeneration: number
  readonly parentSeqNumGlobal: number
  readonly parentSeqNumClient: number
  readonly parentSeqNumRebaseGeneration: number
  readonly name: string
  readonly argsJson: string
  readonly clientId: string
  readonly sessionId: string
  readonly schemaHash: number
  readonly syncMetadataJson: string
}
/** Compact commitment, suitable for the existing bounded opaque installation-operation payload. */
export interface SourceSnapshot {
  readonly sourceIdentity: SourceIdentity
  readonly backendId: string | null
  readonly acknowledgedHead: number
  readonly rows: number
  readonly rowDigest: string
  /** All raw event fields except syncMetadataJson; adoption cannot change this commitment. */
  readonly eventDigest: string
  readonly clearedMetadataRowDigest: string
  readonly schemaDigest: string
}
export interface PrefixCoverage {
  readonly acknowledgedHead: number
  readonly provenThrough: number
  readonly status: 'complete' | 'incomplete' | 'conflicting'
  readonly digest: string
  readonly reason: string | null
}
export interface CaptureLimits {
  readonly maxRows: number
  readonly maxBytes: number
  readonly maxRowBytes: number
  readonly pageSize: number
}
export interface CaptureHeader {
  readonly contract: 'livestore-source-recovery-v1'
  readonly binding: ApplicationBinding
  readonly sourceIdentity: SourceIdentity
  readonly backendId: string | null
  readonly acknowledgedHead: number
  readonly schemaDigest: string
  readonly limits: CaptureLimits
  /** Producer/definition provenance supplied by the application, not an SDK authorization claim. */
  readonly provenance: Json
}
export interface CaptureChunk {
  readonly index: number
  readonly rows: readonly SourceRecoveryRow[]
  readonly bytes: number
  readonly digest: string
}
export interface ClosedCaptureReceipt {
  readonly header: CaptureHeader
  readonly snapshot: SourceSnapshot
  readonly coverage: PrefixCoverage
  readonly chunks: number
  readonly bytes: number
  readonly captureDigest: string
  readonly closure: 'joined-maintenance-owner'
}
/** Stage callbacks are idempotent by header/chunk digest; only seal publishes a completed capture. */
export interface CaptureSink {
  begin(header: CaptureHeader): Effect.Effect<void, SourceMaintenanceError>
  chunk(chunk: CaptureChunk): Effect.Effect<void, SourceMaintenanceError>
  seal(receipt: ClosedCaptureReceipt): Effect.Effect<void, SourceMaintenanceError>
}
export interface CaptureRequest {
  readonly opener: RetainedSourceMaintenanceOpener
  readonly binding: ApplicationBinding
  readonly limits: CaptureLimits
  readonly provenance: Json
  readonly sink: CaptureSink
}
/** Untrusted standard-JSON readers supply unknown values; the SDK validates them before canonical use. */
export interface SourceCaptureInput {
  readonly receipt: unknown
  readonly chunks: Stream.Stream<unknown, SourceMaintenanceError>
}
/** Typed producer-side archive; readers can use SourceCaptureInput without assertions or copied SDK schemas. */
export interface CaptureArchive {
  readonly receipt: ClosedCaptureReceipt
  readonly chunks: Stream.Stream<CaptureChunk, SourceMaintenanceError>
}
export interface TargetVerification {
  readonly binding: ApplicationBinding
  readonly backendId: string
  readonly logicalHead: number
  /** Complete, bounded, non-live canonical prefix through logicalHead, with parents and multiplicity. */
  readonly prefix: Stream.Stream<GlobalEvent.Encoded, SourceMaintenanceError>
  readonly witness: Json
  /** Null during preparation; exact durable envelope digest during adoption/resume. */
  readonly intentPayloadDigest: string | null
}
export interface RecoveryAdoptionPlan {
  readonly contract: 'livestore-source-adoption-v1'
  readonly binding: ApplicationBinding
  readonly captureDigest: string
  readonly expected: SourceSnapshot
  readonly limits: CaptureLimits
  readonly targetBackendId: string
  readonly targetHead: number
  readonly targetPrefixDigest: string
  readonly targetWitnessDigest: string
  readonly successorIncarnation: string
  readonly postimageDigest: string
  readonly eventDefinitionsDigest: string
  readonly policy: 'position-preserving-preserve-residual'
  readonly planDigest: string
}
export interface SourceEventDefinitionWitness {
  readonly name: string
  readonly schemaHash: number
  readonly clientOnly: boolean
}
export interface PrepareAdoptionRequest {
  readonly capture: SourceCaptureInput
  readonly target: TargetVerification
  readonly eventDefinitions: readonly SourceEventDefinitionWitness[]
}
export interface AdoptRequest {
  readonly opener: RetainedSourceMaintenanceOpener
  readonly plan: RecoveryAdoptionPlan
  readonly intent: DurableIntent
  readonly currentTarget: TargetVerification
  readonly eventDefinitions: readonly SourceEventDefinitionWitness[]
}
export interface InspectSourceAdoptionRequest {
  readonly opener: RetainedSourceMaintenanceOpener
  readonly plan: RecoveryAdoptionPlan
  readonly intent: DurableIntent
}
/** Local exact-state evidence only: no network, grant, activation or cancellation authority. */
export interface ClosedSourceAdoptionInspection {
  readonly contract: 'livestore-source-adoption-inspection-v1'
  readonly operationId: string
  readonly payloadDigest: string
  readonly planDigest: string
  readonly outcome: 'applied' | 'not-applied' | 'foreign'
  readonly closure: 'joined-maintenance-owner'
}
export interface ClosedAdoptionReceipt {
  readonly contract: 'livestore-source-adoption-receipt-v1'
  readonly operationId: string
  readonly payloadDigest: string
  readonly planDigest: string
  readonly outcome: 'applied' | 'already-applied'
  readonly sourceIdentityBefore: SourceIdentity
  readonly sourceIdentityAfter: SourceIdentity
  readonly backendId: string
  readonly acknowledgedHead: number
  readonly rowDigest: string
  readonly eventDigest: string
  readonly targetWitnessDigest: string
  readonly closure: 'joined-maintenance-owner'
}
export class SourceMaintenanceError extends Error {
  readonly _tag = 'SourceMaintenanceError'
  constructor(
    readonly code: string,
    override readonly cause: unknown,
    readonly commitStatus: 'not-started' | 'unknown' | 'committed' = 'not-started',
    /** Actual SDK resource scope result, independent of mutation/commit status. */
    readonly closure: 'joined' | 'unknown' = 'unknown',
  ) {
    super(`SOURCE maintenance ${code}`)
  }
}

export interface VerifiedCapturePrefix {
  readonly coverage: PrefixCoverage
  readonly through: number
  readonly prefixDigest: string
  readonly eventDefinitionsDigest: string
  readonly events: Stream.Stream<GlobalEvent.Encoded>
}
export interface InspectedSourceCapture {
  readonly receipt: ClosedCaptureReceipt
  readonly rows: Stream.Stream<SourceRecoveryRow>
  /** Only the proven contiguous prefix; incomplete/conflicting coverage remains explicit to the operator. */
  readCanonicalPrefix(
    definitions: readonly SourceEventDefinitionWitness[],
    options?: { readonly through?: number },
  ): Effect.Effect<VerifiedCapturePrefix, SourceMaintenanceError>
}
