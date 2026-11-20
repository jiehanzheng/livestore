import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { expect, it } from 'vitest'

import { type RendererOutputOwner, type RendererScratchOwner } from './renderer-failure.ts'
import { closeTestOutput, assertTestFilesRemovable } from './renderer-test-ownership.ts'
import { RendererWriteFailure, writeRendererBytes } from './renderer-write.ts'

const actualDescriptor = (onFinished: (cleanup: () => void) => void) => {
  const root = fileURLToPath(new URL('../../../../temp_nocommit/', import.meta.url))
  const directory = fs.mkdtempSync(path.join(root, 'renderer-write-'))
  let output: RendererOutputOwner | undefined
  const scratch: RendererScratchOwner = { path: directory, state: 'owned' }
  onFinished(() => {
    if (output !== undefined) closeTestOutput(directory, output, scratch, fs.closeSync)
    assertTestFilesRemovable(directory, output, scratch)
    fs.rmSync(directory, { recursive: true })
    scratch.state = 'removed'
  })
  const filename = path.join(directory, 'log')
  output = { descriptor: fs.openSync(filename, 'w'), closed: false }
  return { descriptor: output.descriptor, filename }
}
it('completes controlled short writes through an actual descriptor without losing bytes', ({ onTestFinished }) => {
  const { descriptor, filename } = actualDescriptor(onTestFinished)
  const bytes = Buffer.from('short writes preserve every byte')
  let calls = 0
  const written = writeRendererBytes(bytes, (data, offset, length) => {
    calls++
    return fs.writeSync(descriptor, data, offset, Math.min(2, length))
  })
  expect(calls).toBeGreaterThan(1)
  expect(written).toBe(bytes.length)
  expect(fs.readFileSync(filename)).toEqual(bytes)
})
it('reports zero progress after an actual prefix and does not claim unwritten bytes', ({ onTestFinished }) => {
  const { descriptor, filename } = actualDescriptor(onTestFinished)
  let calls = 0,
    failure: unknown
  try {
    writeRendererBytes(Buffer.from('abcdef'), (data, offset, length) => {
      if (calls++ > 0) return 0
      return fs.writeSync(descriptor, data, offset, Math.min(2, length))
    })
  } catch (cause) {
    failure = cause
  }
  expect(failure).toBeInstanceOf(RendererWriteFailure)
  expect(failure).toMatchObject({ written: 2 })
  expect(calls).toBe(2)
  expect(fs.readFileSync(filename, 'utf8')).toBe('ab')
})
it('preserves the exact write failure and prior progress', () => {
  const primary = new Error('write failed')
  let calls = 0,
    failure: unknown
  try {
    writeRendererBytes(Buffer.from('abc'), () => {
      if (calls++ === 0) return 1
      throw primary
    })
  } catch (cause) {
    failure = cause
  }
  if (!(failure instanceof RendererWriteFailure)) throw new Error('Expected owned write failure.')
  expect(failure.primary).toBe(primary)
  expect(failure).toMatchObject({ written: 1, cause: primary })
})
