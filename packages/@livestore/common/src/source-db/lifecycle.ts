import type { SourceReader } from './role.ts'

export interface SourceLifecycle {
  phase: 'open' | 'closing' | 'closed' | 'failed'
  epoch: number
  readonly namespace: 'standalone' | 'durable-object'
}
export const sourceLifecycle: unique symbol = Symbol('SourceOwnerLifecycle')

/** One physical owner's lifecycle; readers and transaction capabilities reference the same object. */
export const makeSourceLifecycle = (namespace: SourceLifecycle['namespace'] = 'standalone'): SourceLifecycle => ({
  phase: 'open',
  epoch: 0,
  namespace,
})
export const attachSourceLifecycle = <Reader extends SourceReader>(reader: Reader, lifecycle: SourceLifecycle) =>
  Object.assign(reader, { [sourceLifecycle]: lifecycle })
export const invalidateSourceLifecycle = (lifecycle: SourceLifecycle): void => {
  lifecycle.epoch++
}
