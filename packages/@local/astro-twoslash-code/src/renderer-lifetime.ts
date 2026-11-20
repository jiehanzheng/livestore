import { RendererOwnershipFailure } from './renderer-failure.ts'

const disposeAfterFailure = <R>(
  ownerRoot: string,
  resource: R,
  primary: unknown,
  dispose: (resource: R) => void,
): never => {
  try {
    dispose(resource)
  } catch (cleanup) {
    throw new RendererOwnershipFailure('Renderer setup/render and disposal failed.', ownerRoot, primary, [cleanup], {
      resource,
    })
  }
  throw primary
}

export const completeRendererSetup = <R, A>(
  ownerRoot: string,
  resource: R,
  setup: () => A,
  dispose: (resource: R) => void,
): A => {
  try {
    return setup()
  } catch (primary) {
    return disposeAfterFailure(ownerRoot, resource, primary, dispose)
  }
}

export const useLocalRenderer = async <R, A>(
  ownerRoot: string,
  acquire: () => Promise<R>,
  use: (resource: R) => Promise<A>,
  dispose: (resource: R) => void,
): Promise<A> => {
  const resource = await acquire()
  let value: A
  try {
    value = await use(resource)
  } catch (primary) {
    return disposeAfterFailure(ownerRoot, resource, primary, dispose)
  }
  try {
    dispose(resource)
  } catch (cleanup) {
    throw new RendererOwnershipFailure(
      'Renderer disposal failed.',
      ownerRoot,
      undefined,
      [cleanup],
      { resource },
      false,
    )
  }
  return value
}
