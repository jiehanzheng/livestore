import { Schema } from '@livestore/utils/effect'

import type {
  ApplicationBinding,
  CaptureHeader,
  CaptureLimits,
  ClosedCaptureReceipt,
  PrefixCoverage,
  SourceSnapshot,
} from './types.ts'

export const sourceIdentityCodec = Schema.Struct({ formatVersion: Schema.Finite, incarnation: Schema.String })
export const captureLimitsCodec: Schema.Codec<CaptureLimits> = Schema.Struct({
  maxRows: Schema.Finite,
  maxBytes: Schema.Finite,
  maxRowBytes: Schema.Finite,
  pageSize: Schema.Finite,
})
export const applicationBindingCodec: Schema.Codec<ApplicationBinding> = Schema.Struct({
  operationId: Schema.String,
  context: Schema.Json,
})
export const sourceSnapshotCodec: Schema.Codec<SourceSnapshot> = Schema.Struct({
  sourceIdentity: sourceIdentityCodec,
  backendId: Schema.NullOr(Schema.String),
  acknowledgedHead: Schema.Finite,
  rows: Schema.Finite,
  rowDigest: Schema.String,
  eventDigest: Schema.String,
  clearedMetadataRowDigest: Schema.String,
  schemaDigest: Schema.String,
})
export const prefixCoverageCodec: Schema.Codec<PrefixCoverage> = Schema.Struct({
  acknowledgedHead: Schema.Finite,
  provenThrough: Schema.Finite,
  status: Schema.Literals(['complete', 'incomplete', 'conflicting']),
  digest: Schema.String,
  reason: Schema.NullOr(Schema.String),
})
const headerCodec: Schema.Codec<CaptureHeader> = Schema.Struct({
  contract: Schema.Literal('livestore-source-recovery-v1'),
  binding: applicationBindingCodec,
  sourceIdentity: sourceIdentityCodec,
  backendId: Schema.NullOr(Schema.String),
  acknowledgedHead: Schema.Finite,
  schemaDigest: Schema.String,
  limits: captureLimitsCodec,
  provenance: Schema.Json,
})
export const captureReceiptCodec: Schema.Codec<ClosedCaptureReceipt> = Schema.Struct({
  header: headerCodec,
  snapshot: sourceSnapshotCodec,
  coverage: prefixCoverageCodec,
  chunks: Schema.Finite,
  bytes: Schema.Finite,
  captureDigest: Schema.String,
  closure: Schema.Literal('joined-maintenance-owner'),
})
/** Raw rows stay unknown until the single existing format-7 row guard/decoder checks them. */
export const captureChunkInputCodec = Schema.Struct({
  index: Schema.Finite,
  rows: Schema.Array(Schema.Unknown),
  bytes: Schema.Finite,
  digest: Schema.String,
})
