import { describe, expect, it } from 'vitest'

import { runLocalRendererJob } from './renderer-child-job.ts'
import { RendererOwnershipFailure } from './renderer-failure.ts'
import {
  createRendererDispatcher,
  type RendererClose,
  type RendererEvidence,
  type RendererExecution,
} from './renderer-parent.ts'
import { jobDeadlineMs, terminationGraceMs, type RendererJob } from './renderer-protocol.ts'

const deferred = <A>() => {
  let resolve: (value: A) => void = () => {
    throw new Error('Uninitialized test promise.')
  }
  const promise = new Promise<A>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
const request: RendererJob = {
  mode: 'build',
  projectRoot: '/injected/project',
  ownerRoot: '/injected/owner',
  runtime: {},
}

const harness = () => {
  const close = deferred<RendererClose>()
  const signals: string[] = []
  const retained: RendererEvidence[] = []
  const events: string[] = []
  const timers: { delay: number; callback: () => void; cancelled: boolean }[] = []
  const controls: {
    output: unknown
    readError?: Error
    closeError?: Error
    captureError?: Error
    cleanupError?: Error
    launchError?: Error
  } = { output: { ok: true, value: 3 } }
  const handle = { kind: 'injected process handle' }
  let launches = 0
  const execution: RendererExecution = {
    output: { descriptor: 0, closed: false },
    scratch: { path: '/injected/scratch', state: 'owned' },
    handle,
    pid: 42,
    directory: '/injected/scratch',
    started: Promise.resolve(),
    closed: close.promise,
    terminate: (signal) => {
      signals.push(signal)
    },
    closeOutput: () => {
      events.push('close-output')
      if (controls.closeError !== undefined) throw controls.closeError
      execution.output.closed = true
      if (controls.captureError !== undefined) throw controls.captureError
    },
    readOutput: () => {
      events.push('read-output')
      if (controls.readError !== undefined) throw controls.readError
      return controls.output
    },
    cleanup: () => {
      events.push('cleanup')
      if (controls.cleanupError !== undefined) {
        execution.scratch.state = 'uncertain'
        throw controls.cleanupError
      }
      execution.scratch.state = 'removed'
    },
    retain: (evidence) => {
      retained.push(structuredClone(evidence))
    },
  }
  const dispatcher = createRendererDispatcher({
    prepare: (job) => ({ job, ownerRoot: job.ownerRoot, request: JSON.stringify(job) }),
    launch: () => {
      launches += 1
      if (controls.launchError !== undefined) throw controls.launchError
      return execution
    },
    schedule: (delay, callback) => {
      const timer = { delay, callback, cancelled: false }
      timers.push(timer)
      return () => {
        timer.cancelled = true
      }
    },
  })
  const fire = (delay: number) => {
    const timer = timers.find((item) => item.delay === delay && !item.cancelled)
    if (timer === undefined) throw new Error(`No scheduled test deadline ${delay}.`)
    timer.cancelled = true
    timer.callback()
  }
  return {
    dispatcher,
    close,
    signals,
    retained,
    events,
    controls,
    handle,
    fire,
    get launches() {
      return launches
    },
  }
}

describe('parent-only renderer supervision with injected handles', () => {
  it('does not report success before close and complete output validation/cleanup', async () => {
    const h = harness()
    const running = h.dispatcher.start(request)
    expect(h.events).toEqual([])
    expect(h.dispatcher.active?.execution?.handle).toBe(h.handle)
    expect(() => h.dispatcher.start(request)).toThrow(/admission occupied/)
    h.close.resolve({ code: 0, signal: null })
    await running.joined
    expect(await running.result).toBe(3)
    expect(h.events).toEqual(['close-output', 'read-output', 'cleanup'])
    expect(running.evidence).toMatchObject({
      outputValidated: true,
      cleanupSucceeded: true,
      close: { code: 0, signal: null },
    })
    expect(h.dispatcher.active).toBeUndefined()
    expect(h.launches).toBe(1)
  })

  it('holds admission and the exact handle after cancellation until positive close', async () => {
    const h = harness()
    const running = h.dispatcher.start(request)
    running.cancel()
    running.cancel()
    expect(h.signals).toEqual(['SIGTERM'])
    expect(h.dispatcher.active?.execution?.handle).toBe(h.handle)
    expect(() => h.dispatcher.start(request)).toThrow(/admission occupied/)
    h.fire(terminationGraceMs)
    expect(h.signals).toEqual(['SIGTERM', 'SIGKILL'])
    expect(h.dispatcher.active?.evidence?.close).toBeNull()
    h.close.resolve({ code: null, signal: 'SIGKILL' })
    await expect(running.result).rejects.toThrow(/Renderer job failed/)
    expect(h.retained.at(-1)).toMatchObject({
      cancellation: 'cancelled',
      forcedTermination: true,
      cleanupSucceeded: false,
    })
    expect(h.events).not.toContain('cleanup')
  })

  it('never equates a deadline or forced termination with observed close', async () => {
    const h = harness()
    const running = h.dispatcher.start(request)
    h.fire(jobDeadlineMs)
    h.fire(terminationGraceMs)
    let settled = false
    void running.result.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      },
    )
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(h.dispatcher.active?.execution?.handle).toBe(h.handle)
    expect(h.dispatcher.active?.evidence).toMatchObject({
      status: 'awaiting-close',
      cancellation: 'deadline',
      close: null,
    })
    expect(() => h.dispatcher.start(request)).toThrow(/admission occupied/)
    expect(h.launches).toBe(1)
    h.close.resolve({ code: null, signal: 'SIGKILL' })
    await expect(running.result).rejects.toThrow(/Renderer job failed/)
  })

  it('preserves compilation and output-close failures together', async () => {
    const h = harness()
    h.controls.output = { ok: false, error: 'TS2322: incompatible value' }
    h.controls.closeError = new Error('log close failed')
    const running = h.dispatcher.start(request)
    h.close.resolve({ code: 1, signal: null })
    await expect(running.result).rejects.toThrow(/TS2322/)
    expect(h.retained.at(-1)).toMatchObject({
      primaryError: 'TS2322: incompatible value',
      cleanupError: 'log close failed',
      outputValidated: false,
    })
    expect(h.events).not.toContain('cleanup')
    expect(h.dispatcher.active?.execution).toBeUndefined()
    expect(h.dispatcher.active?.uncertain?.output?.descriptor).toBe(0)
    expect(h.dispatcher.active?.failure).toMatchObject({ cleanupErrors: [h.controls.closeError] })
  })

  it('keeps a valid result distinct from a failed scratch cleanup', async () => {
    const h = harness()
    h.controls.cleanupError = new Error('scratch removal failed')
    const running = h.dispatcher.start(request)
    h.close.resolve({ code: 0, signal: null })
    await running.joined
    await expect(running.result).rejects.toThrow(/scratch removal failed/)
    expect(h.retained.at(-1)).toMatchObject({
      primaryError: null,
      cleanupError: 'scratch removal failed',
      outputValidated: true,
      cleanupSucceeded: false,
    })
    expect(h.dispatcher.active?.execution).toBeUndefined()
    expect(h.dispatcher.active?.uncertain?.scratch?.state).toBe('uncertain')
  })

  it.each([
    ['missing', undefined],
    ['malformed', { ok: true, value: 'three' }],
    ['negative count', { ok: true, value: -1 }],
    ['fractional count', { ok: true, value: 1.5 }],
  ])('retains a %s output instead of accepting close alone', async (_label, output) => {
    const h = harness()
    h.controls.output = output
    const running = h.dispatcher.start(request)
    h.close.resolve({ code: 0, signal: null })
    await expect(running.result).rejects.toThrow(/Renderer job failed/)
    expect(h.retained.at(-1)?.outputValidated).toBe(false)
    expect(h.events).not.toContain('cleanup')
  })

  it('retains an output-bound failure reported by its reader', async () => {
    const h = harness()
    h.controls.readError = new Error('Renderer job output exceeds 16 MiB.')
    const running = h.dispatcher.start(request)
    h.close.resolve({ code: 0, signal: null })
    await expect(running.result).rejects.toThrow(/exceeds 16 MiB/)
    expect(h.retained.at(-1)?.outputValidated).toBe(false)
  })

  it('rejects malformed rendered HAST before removing its evidence', async () => {
    const h = harness()
    const job: RendererJob = { ...request, mode: 'render', inputs: [{ code: 'x', language: 'ts', lineOwners: [] }] }
    h.controls.output = { ok: true, value: [{ renderedGroupAst: { type: 'element', children: [] }, styles: [] }] }
    const running = h.dispatcher.start(job)
    h.close.resolve({ code: 0, signal: null })
    await expect(running.result).rejects.toThrow(/Invalid renderer batch result/)
    expect(h.events).not.toContain('cleanup')
  })

  it('releases a reservation when launch fails before creating a handle', () => {
    const h = harness()
    h.controls.launchError = new Error('no process created')
    expect(() => h.dispatcher.start(request)).toThrow(/no process created/)
    expect(h.dispatcher.active).toBeUndefined()
    expect(h.launches).toBe(1)
  })

  it('retains exact primary and cleanup objects after process close without retaining the process', async () => {
    const h = harness()
    const primary = new Error('read'),
      cleanup = new Error('close')
    h.controls.readError = primary
    h.controls.closeError = cleanup
    const running = h.dispatcher.start(request)
    h.close.resolve({ code: 1, signal: null })
    let failure: unknown
    try {
      await running.result
    } catch (cause) {
      failure = cause
    }
    expect(failure).toBeInstanceOf(RendererOwnershipFailure)
    expect((failure as RendererOwnershipFailure).primary).toBe(primary)
    expect((failure as RendererOwnershipFailure).cleanupErrors[0]).toBe(cleanup)
    expect(h.dispatcher.active?.execution).toBeUndefined()
    expect(h.dispatcher.active?.failure).toBe(failure)
    expect(h.dispatcher.active?.uncertain?.output?.closed).toBe(false)
  })

  it('releases admission after a capture error when descriptor close is confirmed', async () => {
    const h = harness()
    h.controls.captureError = new Error('capture')
    const running = h.dispatcher.start(request)
    h.close.resolve({ code: 0, signal: null })
    await expect(running.result).rejects.toMatchObject({ cleanupErrors: [h.controls.captureError], uncertain: {} })
    expect(h.dispatcher.active).toBeUndefined()
  })

  it('keeps launch admission only for actual uncertain owners', () => {
    const h = harness()
    const output = { descriptor: 0, closed: false }
    const failure = new RendererOwnershipFailure('launch', request.ownerRoot, new Error('spawn'), [], { output })
    h.controls.launchError = failure
    expect(() => h.dispatcher.start(request)).toThrow(failure)
    expect(h.dispatcher.active?.uncertain?.output).toBe(output)
    expect(h.dispatcher.active?.execution).toBeUndefined()
    expect(h.dispatcher.active?.failure).toBe(failure)
    expect(() => h.dispatcher.start(request)).toThrow(/admission occupied/)
  })

  it('dispatches one finite batch while the child invokes only local capabilities', async () => {
    let launches = 0
    let localBuilds = 0
    let localRenders = 0
    const h = harness()
    const dispatcher = createRendererDispatcher({
      prepare: (job) => ({ job, ownerRoot: job.ownerRoot, request: JSON.stringify(job) }),
      launch: (prepared) => {
        launches += 1
        void runLocalRendererJob(prepared.job, {
          build: async () => {
            localBuilds += 1
            return 100
          },
          render: async () => {
            localRenders += 1
            return []
          },
        }).then((value) => {
          h.controls.output = { ok: true, value }
          h.close.resolve({ code: 0, signal: null })
        })
        return {
          output: { descriptor: 0, closed: true },
          scratch: { path: '/injected/job', state: 'removed' },
          handle: h.handle,
          pid: 42,
          directory: '/injected/job',
          started: Promise.resolve(),
          closed: h.close.promise,
          terminate: () => {},
          closeOutput: () => {},
          readOutput: () => h.controls.output,
          cleanup: () => {},
          retain: () => {},
        }
      },
      schedule: () => () => {},
    })
    expect(await dispatcher.start(request).result).toBe(100)
    expect({ launches, localBuilds, localRenders }).toEqual({ launches: 1, localBuilds: 1, localRenders: 0 })
  })
})
