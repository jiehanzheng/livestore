import { describe, expect, it } from 'vitest'

import { RendererOwnershipFailure } from './renderer-failure.ts'
import { acquireRendererLaunch, type LaunchResourceCapabilities } from './renderer-launch-resources.ts'
import { completeRendererSetup, useLocalRenderer } from './renderer-lifetime.ts'
import { encodeRendererFailure, decodeRendererOutput } from './renderer-protocol.ts'

const owner = '/injected/owner'
describe('partial renderer resource acquisition without processes', () => {
  it.each(['cache', 'scratch', 'request', 'open', 'launch'])(
    'preserves the %s primary and releases only acquired resources',
    (stage) => {
      const primary = new Error(stage)
      const events: string[] = []
      const step = (name: string) => {
        events.push(name)
        if (name === stage) throw primary
      }
      const io: LaunchResourceCapabilities = {
        ensureCache: () => step('cache'),
        createScratch: () => {
          step('scratch')
          return '/scratch'
        },
        writeRequest: () => step('request'),
        openOutput: () => {
          step('open')
          return 0
        },
        closeOutput: (fd) => {
          expect(fd).toBe(0)
          step('close')
        },
        removeScratch: () => step('remove'),
        retainFailure: () => step('retain'),
      }
      let failure: unknown
      try {
        acquireRendererLaunch(owner, io, () => step('launch'))
      } catch (cause) {
        failure = cause
      }
      expect(failure).toBeInstanceOf(RendererOwnershipFailure)
      expect(failure).toMatchObject({ primary, cleanupErrors: [], uncertain: {} })
      expect(events.includes('close')).toBe(stage === 'launch')
      expect(events.includes('remove')).toBe(['request', 'open', 'launch'].includes(stage))
    },
  )
  it('retains descriptor zero, scratch and independent evidence errors when close fails', () => {
    const primary = new Error('spawn'),
      close = new Error('close'),
      evidence = new Error('evidence')
    let removed = false
    let failure: unknown
    try {
      acquireRendererLaunch(
        owner,
        {
          ensureCache: () => {},
          createScratch: () => '/scratch',
          writeRequest: () => {},
          openOutput: () => 0,
          closeOutput: () => {
            throw close
          },
          removeScratch: () => {
            removed = true
          },
          retainFailure: () => {
            throw evidence
          },
        },
        () => {
          throw primary
        },
      )
    } catch (cause) {
      failure = cause
    }
    expect(removed).toBe(false)
    expect(failure).toMatchObject({
      primary,
      cleanupErrors: [close, evidence],
      uncertain: { output: { descriptor: 0, closed: false }, scratch: { path: '/scratch' } },
    })
    expect((failure as RendererOwnershipFailure).primary).toBe(primary)
    expect((failure as RendererOwnershipFailure).cleanupErrors[0]).toBe(close)
  })
  it('retains only uncertain scratch after successful descriptor close', () => {
    const primary = new Error('launch'),
      cleanup = new Error('remove')
    expect(() =>
      acquireRendererLaunch(
        owner,
        {
          ensureCache: () => {},
          createScratch: () => '/scratch',
          writeRequest: () => {},
          openOutput: () => 0,
          closeOutput: () => {},
          removeScratch: () => {
            throw cleanup
          },
          retainFailure: () => {},
        },
        () => {
          throw primary
        },
      ),
    ).toThrow(
      expect.objectContaining({
        primary,
        cleanupErrors: [cleanup],
        uncertain: { scratch: { path: '/scratch', state: 'uncertain' } },
      }),
    )
  })
})

describe('local renderer lifetime without highlighter execution', () => {
  it('disposes after setup failure and preserves setup plus disposal errors', () => {
    const resource = {},
      primary = new Error('setup'),
      cleanup = new Error('dispose')
    expect(() =>
      completeRendererSetup(
        owner,
        resource,
        () => {
          throw primary
        },
        () => {
          throw cleanup
        },
      ),
    ).toThrow(expect.objectContaining({ primary, cleanupErrors: [cleanup], uncertain: { resource } }))
  })
  it.each([true, false])('preserves disposal failure after render failure=%s', async (fail) => {
    const resource = {},
      primary = new Error('render'),
      cleanup = new Error('dispose')
    let disposed = 0
    await expect(
      useLocalRenderer(
        owner,
        async () => resource,
        async () => {
          if (fail === true) throw primary
          return 42
        },
        () => {
          disposed++
          throw cleanup
        },
      ),
    ).rejects.toMatchObject({
      primary: fail === true ? primary : undefined,
      cleanupErrors: [cleanup],
      uncertain: { resource },
    })
    expect(disposed).toBe(1)
  })
  it('distinguishes thrown undefined from successful use followed by disposal failure', async () => {
    const cleanup = new Error('dispose')
    const acquire = async () => ({})
    const dispose = () => {
      throw cleanup
    }
    let caught: unknown
    try {
      await useLocalRenderer(
        owner,
        acquire,
        async () => {
          throw undefined
        },
        dispose,
      )
    } catch (cause) {
      caught = cause
    }
    expect(caught).toMatchObject({ hasPrimary: true, primary: undefined, errors: [undefined, cleanup] })
    await expect(useLocalRenderer(owner, acquire, async () => 42, dispose)).rejects.toMatchObject({
      hasPrimary: false,
      errors: [cleanup],
    })
  })
  it('preserves a bounded nested error graph across the wire', () => {
    const error = new AggregateError([new Error('cleanup')], 'render', { cause: new Error('primary') })
    const output = JSON.parse(encodeRendererFailure(error))
    expect(output.failure).toMatchObject({ cause: { message: 'primary' }, errors: [{ message: 'cleanup' }] })
    expect(() =>
      decodeRendererOutput({ mode: 'build', ownerRoot: owner, projectRoot: owner, runtime: {} }, output),
    ).toThrow(expect.objectContaining({ cause: output.failure }))
  })
})
