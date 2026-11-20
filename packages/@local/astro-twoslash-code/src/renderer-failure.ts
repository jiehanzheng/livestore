export type RendererOutputOwner = { descriptor: number; closed: boolean }
export type RendererScratchOwner = { path: string; state: 'owned' | 'retained' | 'removed' | 'uncertain' }
export type RendererUncertainOwners = {
  output?: RendererOutputOwner
  scratch?: RendererScratchOwner
  resource?: unknown
}

export const hasUncertainOwners = (owners: RendererUncertainOwners) =>
  owners.output !== undefined || owners.scratch !== undefined || owners.resource !== undefined

/** Error objects are retained independently; serialized summaries are not ownership evidence. */
export class RendererOwnershipFailure extends AggregateError {
  constructor(
    message: string,
    readonly ownerRoot: string,
    readonly primary: unknown,
    readonly cleanupErrors: readonly unknown[],
    readonly uncertain: RendererUncertainOwners,
    readonly hasPrimary = true,
  ) {
    super(
      hasPrimary === true ? [primary, ...cleanupErrors] : [...cleanupErrors],
      message,
      hasPrimary === true ? { cause: primary } : undefined,
    )
  }
}
