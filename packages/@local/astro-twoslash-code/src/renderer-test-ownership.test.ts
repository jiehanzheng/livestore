import { expect, it } from 'vitest'

import { RendererOwnershipFailure, type RendererOutputOwner, type RendererScratchOwner } from './renderer-failure.ts'
import { assertTestFilesRemovable, closeTestOutput } from './renderer-test-ownership.ts'

it('keeps exact descriptor zero and path owners reachable after failed cleanup returns', () => {
  const output: RendererOutputOwner = { descriptor: 0, closed: false }
  const scratch: RendererScratchOwner = { path: '/injected/fixture', state: 'owned' }
  const primary = new Error('close failed')
  let closeCalls = 0,
    removals = 0,
    escaped: unknown
  const callback = () => {
    closeTestOutput(scratch.path, output, scratch, (descriptor) => {
      expect(descriptor).toBe(0)
      closeCalls++
      throw primary
    })
    removals++
  }
  try {
    callback()
  } catch (failure) {
    escaped = failure
  }
  if (!(escaped instanceof RendererOwnershipFailure)) throw new Error('Expected retained fixture ownership.')
  expect(escaped.primary).toBe(primary)
  expect(escaped.uncertain.output).toBe(output)
  expect(escaped.uncertain.scratch).toBe(scratch)
  expect(escaped.ownerRoot).toBe('/injected/fixture')
  expect(closeCalls).toBe(1)
  expect(removals).toBe(0)
  expect(output.closed).toBe(false)
})
it('retains uncertain scratch after a positively closed output descriptor without removing it again', () => {
  const output: RendererOutputOwner = { descriptor: 42, closed: true }
  const scratch: RendererScratchOwner = { path: '/injected/scratch', state: 'uncertain' }
  let escaped: unknown
  try {
    assertTestFilesRemovable('/injected/owner', output, scratch)
  } catch (failure) {
    escaped = failure
  }
  if (!(escaped instanceof RendererOwnershipFailure)) throw new Error('Expected retained scratch ownership.')
  expect(escaped.uncertain.scratch).toBe(scratch)
  expect(escaped.uncertain.output).toBeUndefined()
  expect(scratch.state).toBe('uncertain')
})
it('permits deliberate evidence cleanup only when the descriptor and scratch ownership are certain', () => {
  const output: RendererOutputOwner = { descriptor: 0, closed: false }
  const scratch: RendererScratchOwner = { path: '/injected/scratch', state: 'owned' }
  let closed = 0
  closeTestOutput('/injected/owner', output, scratch, () => {
    closed++
  })
  expect(closed).toBe(1)
  expect(output.closed).toBe(true)
  scratch.state = 'retained'
  expect(() => assertTestFilesRemovable('/injected/owner', output, scratch)).not.toThrow()
})
