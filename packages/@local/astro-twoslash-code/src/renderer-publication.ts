import { RendererOwnershipFailure } from './renderer-failure.ts'
import { encodeRendererFailure, serializeRendererError } from './renderer-protocol.ts'

/** A failed result-file write is not a published result. Preserve both errors
 * and send a bounded private cause graph through the parent's captured log.
 * Throw the composite so entry callers cannot discard a publication failure. */
export const publishRendererFailure = (
  ownerRoot: string,
  primary: unknown,
  publish: (encoded: string) => void,
  diagnose: (message: string, failure: RendererOwnershipFailure) => void,
): void => {
  try {
    publish(encodeRendererFailure(primary))
    return
  } catch (publication) {
    const failure = new RendererOwnershipFailure(
      'Renderer failure result could not be published.',
      ownerRoot,
      primary,
      [publication],
      {},
    )
    try {
      diagnose(
        `Renderer failure result could not be published.\n${JSON.stringify({ ok: false, primary: serializeRendererError(primary), publication: serializeRendererError(publication) })}\n`,
        failure,
      )
    } catch (diagnostic) {
      throw new RendererOwnershipFailure(
        'Renderer failure result and diagnostic could not be published.',
        ownerRoot,
        primary,
        [publication, diagnostic],
        {},
      )
    }
    throw failure
  }
}
