/** A successful write can consume a strict prefix. Keep that progress distinct
 * from the original failure so evidence never claims bytes that were lost. */
export class RendererWriteFailure extends Error {
  constructor(
    readonly written: number,
    readonly primary: unknown,
  ) {
    super('Renderer diagnostic write failed.', { cause: primary })
  }
}

export const writeRendererBytes = (
  bytes: Uint8Array,
  write: (bytes: Uint8Array, offset: number, length: number) => number,
): number => {
  let offset = 0
  try {
    while (offset < bytes.length) {
      const count = write(bytes, offset, bytes.length - offset)
      if (Number.isSafeInteger(count) === false || count <= 0 || count > bytes.length - offset) {
        throw new Error('Renderer diagnostic write made no valid forward progress.')
      }
      offset += count
    }
    return offset
  } catch (primary) {
    throw new RendererWriteFailure(offset, primary)
  }
}
