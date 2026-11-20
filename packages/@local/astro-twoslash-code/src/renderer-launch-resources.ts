import { RendererOwnershipFailure, type RendererOutputOwner, type RendererScratchOwner } from './renderer-failure.ts'

export type LaunchResources = { scratch: RendererScratchOwner; output: RendererOutputOwner }
export type LaunchResourceCapabilities = {
  ensureCache: () => void
  createScratch: () => string
  writeRequest: (directory: string) => void
  openOutput: (directory: string) => number
  closeOutput: (descriptor: number) => void
  removeScratch: (directory: string) => void
  retainFailure: (failure: RendererOwnershipFailure, directory: string | undefined) => void
}

/** Own partial acquisitions from the first filesystem operation, including descriptor zero. */
export const acquireRendererLaunch = <A>(
  ownerRoot: string,
  io: LaunchResourceCapabilities,
  launch: (resources: LaunchResources) => A,
): A => {
  let scratch: RendererScratchOwner | undefined
  let output: RendererOutputOwner | undefined
  try {
    io.ensureCache()
    scratch = { path: io.createScratch(), state: 'owned' }
    io.writeRequest(scratch.path)
    output = { descriptor: io.openOutput(scratch.path), closed: false }
    return launch({ scratch, output })
  } catch (primary) {
    const cleanupErrors: unknown[] = []
    if (output !== undefined && output.closed !== true) {
      try {
        io.closeOutput(output.descriptor)
        output.closed = true
      } catch (cause) {
        cleanupErrors.push(cause)
      }
    }
    if (scratch !== undefined && (output === undefined || output.closed === true)) {
      try {
        io.removeScratch(scratch.path)
        scratch.state = 'removed'
      } catch (cause) {
        scratch.state = 'uncertain'
        cleanupErrors.push(cause)
      }
    } else if (scratch !== undefined) scratch.state = 'retained'
    const uncertain = {
      ...(output !== undefined && output.closed !== true ? { output } : {}),
      ...(scratch !== undefined && scratch.state !== 'removed' ? { scratch } : {}),
    }
    const failure = new RendererOwnershipFailure(
      'Renderer launch acquisition failed.',
      ownerRoot,
      primary,
      cleanupErrors,
      uncertain,
    )
    try {
      io.retainFailure(failure, scratch?.path)
    } catch (cause) {
      throw new RendererOwnershipFailure(
        'Renderer launch and evidence retention failed.',
        ownerRoot,
        primary,
        [...cleanupErrors, cause],
        uncertain,
      )
    }
    throw failure
  }
}
