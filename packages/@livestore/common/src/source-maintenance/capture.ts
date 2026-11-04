import { Effect, Exit } from '@livestore/utils/effect'

import { boundedBinding, digest, equal, ownJson } from './codec.ts'
import { withRetainedSource } from './opener.ts'
import { readSourceMetadata, scanSource } from './scan.ts'
import { SourceMaintenanceError, type CaptureHeader, type CaptureRequest, type ClosedCaptureReceipt } from './types.ts'

/** Staged output is not EOF: scope teardown and the real location owner must both join before publication. */
export const captureSource = (request: CaptureRequest): Effect.Effect<ClosedCaptureReceipt, SourceMaintenanceError> =>
  Effect.gen(function* () {
    const descriptor = yield* Effect.try({
      try: () =>
        ownJson({ binding: boundedBinding(request.binding), limits: request.limits, provenance: request.provenance }),
      catch: (cause) => new SourceMaintenanceError('capture-binding', cause, 'not-started', 'joined'),
    })
    const { binding, limits, provenance } = descriptor
    let closure: 'joined' | 'unknown' = 'unknown'
    const result = yield* Effect.exit(
      withRetainedSource(request.opener, binding, (source) =>
        source.write((tx) =>
          Effect.gen(function* () {
            const metadata = yield* readSourceMetadata(tx)
            const header: CaptureHeader = ownJson({
              contract: 'livestore-source-recovery-v1',
              binding,
              ...metadata,
              limits,
              provenance,
            })
            yield* request.sink.begin(header)
            const scan = yield* scanSource(tx, header.limits, (index, rows, bytes, chunkDigest) =>
              request.sink.chunk({ index, rows, bytes, digest: chunkDigest }),
            )
            const actualMetadata = {
              sourceIdentity: scan.snapshot.sourceIdentity,
              backendId: scan.snapshot.backendId,
              acknowledgedHead: scan.snapshot.acknowledgedHead,
              schemaDigest: scan.snapshot.schemaDigest,
            }
            if (equal(metadata, actualMetadata) === false)
              return yield* Effect.fail(
                new SourceMaintenanceError('capture-snapshot-changed', 'SOURCE metadata changed within capture'),
              )
            return { header, ...scan }
          }),
        ),
      ).pipe(
        Effect.tapError((error) =>
          Effect.sync(() => {
            if (error instanceof SourceMaintenanceError) closure = error.closure
          }),
        ),
      ),
    )
    if (Exit.isFailure(result) === true)
      return yield* Effect.fail(new SourceMaintenanceError('capture-unsealed', result.cause, 'not-started', closure))
    const { header, snapshot, coverage, bytes, chunks } = result.value
    const publication = yield* Effect.exit(
      Effect.gen(function* () {
        const captureDigest = yield* digest(['source-recovery-capture', 1, header, snapshot, coverage, chunks, bytes])
        const receipt: ClosedCaptureReceipt = {
          header,
          snapshot,
          coverage,
          chunks,
          bytes,
          captureDigest,
          closure: 'joined-maintenance-owner',
        }
        yield* request.sink.seal(receipt)
        return receipt
      }),
    )
    if (Exit.isFailure(publication) === true)
      return yield* Effect.fail(
        new SourceMaintenanceError('capture-publication', publication.cause, 'not-started', 'joined'),
      )
    return publication.value
  })
