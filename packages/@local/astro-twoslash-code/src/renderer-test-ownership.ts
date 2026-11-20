import { RendererOwnershipFailure, type RendererOutputOwner, type RendererScratchOwner } from './renderer-failure.ts'

/** Test teardown must leave uncertain resources reachable through its thrown
 * error after the framework releases the cleanup callback. */
export const closeTestOutput = (
  ownerRoot: string,
  output: RendererOutputOwner,
  scratch: RendererScratchOwner,
  close: (descriptor: number) => void,
): void => {
  if (output.closed === true) return
  try {
    close(output.descriptor)
    output.closed = true
  } catch (primary) {
    scratch.state = 'retained'
    throw new RendererOwnershipFailure('Test output close is uncertain; files retained.', ownerRoot, primary, [], {
      output,
      scratch,
    })
  }
}

export const assertTestFilesRemovable = (
  ownerRoot: string,
  output: RendererOutputOwner | undefined,
  scratch: RendererScratchOwner,
): void => {
  const uncertain = {
    ...(output !== undefined && output.closed !== true ? { output, scratch } : {}),
    ...(scratch.state === 'uncertain' ? { scratch } : {}),
  }
  if (uncertain.output !== undefined || uncertain.scratch !== undefined) {
    throw new RendererOwnershipFailure(
      'Test resource ownership is uncertain; files retained.',
      ownerRoot,
      undefined,
      [],
      uncertain,
      false,
    )
  }
}
