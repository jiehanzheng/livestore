import { expect, it } from 'vitest'

import { RendererOwnershipFailure } from './renderer-failure.ts'
import { jobByteLimit, logByteLimit, serializeRendererError } from './renderer-protocol.ts'
import { publishRendererFailure } from './renderer-publication.ts'

const caughtFailure = (run: () => void): RendererOwnershipFailure => {
  try {
    run()
  } catch (failure) {
    if (failure instanceof RendererOwnershipFailure) return failure
    throw failure
  }
  throw new Error('Expected publication to throw its owned composite.')
}

it('publishes failure envelopes without claiming success', () => {
  let result: unknown
  publishRendererFailure(
    '/owner',
    new Error('render'),
    (text) => {
      result = JSON.parse(text)
    },
    () => {
      throw new Error('No diagnostic expected.')
    },
  )
  expect(result).toMatchObject({ ok: false, error: 'render' })
})
it('throws the actual composite after publishing a bounded truthful diagnostic', () => {
  const primary = new Error('render'),
    publication = new Error('write')
  let diagnostic = '',
    observed: RendererOwnershipFailure | undefined
  const failure = caughtFailure(() =>
    publishRendererFailure(
      '/owner',
      primary,
      () => {
        throw publication
      },
      (text, owner) => {
        diagnostic = text
        observed = owner
      },
    ),
  )
  expect(failure).toBe(observed)
  expect(failure.primary).toBe(primary)
  expect(failure.cleanupErrors[0]).toBe(publication)
  expect(diagnostic).toContain('Renderer failure result could not be published.')
  expect(diagnostic).toContain('render')
  expect(diagnostic).toContain('write')
  expect(Buffer.byteLength(diagnostic)).toBeLessThan(jobByteLimit)
  expect(diagnostic).not.toContain('"ok":true')
})
it('throws publication and diagnostic failures even with a thrown undefined primary', () => {
  const publication = new Error('write'),
    diagnostic = new Error('stderr')
  const failure = caughtFailure(() =>
    publishRendererFailure(
      '/owner',
      undefined,
      () => {
        throw publication
      },
      () => {
        throw diagnostic
      },
    ),
  )
  expect(failure).toMatchObject({ hasPrimary: true, primary: undefined, errors: [undefined, publication, diagnostic] })
  expect(failure.cleanupErrors[0]).toBe(publication)
  expect(failure.cleanupErrors[1]).toBe(diagnostic)
})
it('keeps independent publication diagnostics bounded even for a large primary graph', () => {
  const primary = new AggregateError(
    Array.from({ length: 100 }, () => new Error('\0'.repeat(100000))),
    'primary',
  )
  const publication = new Error('distinct publication error')
  let diagnostic = ''
  caughtFailure(() =>
    publishRendererFailure(
      '/owner',
      primary,
      () => {
        throw publication
      },
      (text) => {
        diagnostic = text
      },
    ),
  )
  expect(Buffer.byteLength(diagnostic)).toBeLessThan(logByteLimit)
  expect(diagnostic).toContain('distinct publication error')
  expect(diagnostic).toContain('"truncated":true')
})
it('bounds a large Error.name before putting it on the wire', () => {
  const primary = new Error('primary')
  primary.stack = 'fixed stack'
  primary.name = '\0'.repeat(jobByteLimit)
  const encoded = JSON.stringify(serializeRendererError(primary))
  expect(JSON.parse(encoded).name).toHaveLength(128)
  expect(Buffer.byteLength(encoded)).toBeLessThan(logByteLimit)
})
it('reads only the native aggregate array prefix without iterating or copying its tail', () => {
  // Reuse an immutable leaf: this test targets tail access, not 100,000 Error stacks.
  const leaf = new Error('leaf')
  const errors = Array.from({ length: 100000 }, () => leaf)
  Object.defineProperty(errors, Symbol.iterator, {
    value: () => {
      throw new Error('Whole aggregate iteration is forbidden.')
    },
  })
  Object.defineProperty(errors, '16', {
    get: () => {
      throw new Error('Aggregate tail must remain unread.')
    },
  })
  const primary = new AggregateError([], 'many')
  primary.errors = errors
  const encoded = JSON.stringify(serializeRendererError(primary))
  expect(JSON.parse(encoded).errors).toHaveLength(16)
  expect(Buffer.byteLength(encoded)).toBeLessThan(logByteLimit)
})
