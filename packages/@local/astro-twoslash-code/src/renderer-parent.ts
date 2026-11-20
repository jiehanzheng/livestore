import {
  RendererOwnershipFailure,
  hasUncertainOwners,
  type RendererOutputOwner,
  type RendererScratchOwner,
  type RendererUncertainOwners,
} from './renderer-failure.ts'
import {
  decodeRendererOutput,
  serializeRendererError,
  jobDeadlineMs,
  terminationGraceMs,
  type RendererJob,
  type RendererJobValue,
  type PreparedRendererJob,
} from './renderer-protocol.ts'

export type RendererClose = { code: number | null; signal: string | null }
export type RendererEvidence = {
  ownerRoot: string
  pid: number | null
  status: 'running' | 'awaiting-close' | 'closed'
  close: RendererClose | null
  cancellation: 'cancelled' | 'deadline' | null
  forcedTermination: boolean
  terminationErrors: string[]
  primaryError: string | null
  cleanupError: string | null
  outputValidated: boolean
  cleanupSucceeded: boolean
  failureGraph?: unknown
}

export type RendererExecution = {
  output: RendererOutputOwner
  scratch: RendererScratchOwner
  handle: unknown
  pid: number | undefined
  directory: string
  started: Promise<void>
  closed: Promise<RendererClose>
  terminate: (signal: 'SIGTERM' | 'SIGKILL') => void
  closeOutput: () => void
  readOutput: () => unknown
  cleanup: () => void
  retain: (evidence: RendererEvidence) => void
}

export type RendererParentCapabilities = {
  prepare: (job: RendererJob) => PreparedRendererJob
  launch: (prepared: PreparedRendererJob) => RendererExecution
  schedule: (delayMs: number, callback: () => void) => () => void
}

export class RendererParentFailure extends RendererOwnershipFailure {
  constructor(
    readonly evidence: RendererEvidence,
    readonly directory: string,
    primary: unknown,
    cleanup: readonly unknown[],
    uncertain: RendererUncertainOwners,
    hasPrimary: boolean,
  ) {
    super(
      `Renderer job failed: ${evidence.primaryError ?? evidence.cleanupError ?? evidence.cancellation}; evidence at ${directory}`,
      evidence.ownerRoot,
      primary,
      cleanup,
      uncertain,
      hasPrimary,
    )
  }
}

const message = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause))
const appendError = (existing: string | null, cause: unknown) =>
  existing === null ? message(cause) : `${existing}\n${message(cause)}`

/** Parent-only admission and supervision. Child/local modules cannot import this module. */
type Admission = {
  ownerRoot: string
  errors?: unknown[]
  execution?: RendererExecution
  evidence?: RendererEvidence
  uncertain?: RendererUncertainOwners
  failure?: unknown
}

export const createRendererDispatcher = (capabilities: RendererParentCapabilities) => {
  let active: Admission | undefined

  const start = (job: RendererJob) => {
    const prepared = capabilities.prepare(job)
    if (active !== undefined) throw new Error(`Renderer admission occupied by ${active.ownerRoot}.`)
    const reservation: Admission = { ownerRoot: prepared.ownerRoot }
    active = reservation
    let execution: RendererExecution
    try {
      execution = capabilities.launch(prepared)
    } catch (cause) {
      // A launch capability must return an owned handle once a process exists.
      if (cause instanceof RendererOwnershipFailure && hasUncertainOwners(cause.uncertain) === true) {
        reservation.uncertain = cause.uncertain
        reservation.failure = cause
      } else active = undefined
      throw cause
    }
    reservation.execution = execution
    const evidence: RendererEvidence = {
      ownerRoot: prepared.ownerRoot,
      pid: execution.pid ?? null,
      status: 'running',
      close: null,
      cancellation: null,
      forcedTermination: false,
      terminationErrors: [],
      primaryError: null,
      cleanupError: null,
      outputValidated: false,
      cleanupSucceeded: false,
    }
    reservation.evidence = evidence
    let hasPrimary = false
    let primary: unknown
    const cleanupErrors: unknown[] = []
    const terminationErrors: unknown[] = []
    reservation.errors = cleanupErrors
    let cancelDeadline = () => {}
    let cancelGrace = () => {}
    const retain = () => {
      evidence.failureGraph = {
        hasPrimary,
        primary: serializeRendererError(primary),
        cleanup: cleanupErrors.map(serializeRendererError),
        termination: terminationErrors.map(serializeRendererError),
      }
      try {
        execution.retain(evidence)
      } catch (cause) {
        cleanupErrors.push(cause)
        evidence.cleanupError = appendError(evidence.cleanupError, cause)
      }
    }
    const signal = (kind: 'SIGTERM' | 'SIGKILL') => {
      try {
        execution.terminate(kind)
      } catch (cause) {
        terminationErrors.push(cause)
        evidence.terminationErrors.push(message(cause))
      }
    }
    const cancel = (reason: 'cancelled' | 'deadline' = 'cancelled') => {
      if (evidence.close !== null || evidence.cancellation !== null) return
      evidence.cancellation = reason
      evidence.status = 'awaiting-close'
      try {
        cancelDeadline()
      } catch (cause) {
        cleanupErrors.push(cause)
        evidence.cleanupError = appendError(evidence.cleanupError, cause)
      }
      signal('SIGTERM')
      try {
        cancelGrace = capabilities.schedule(terminationGraceMs, () => {
          if (evidence.close !== null) return
          evidence.forcedTermination = true
          signal('SIGKILL')
          retain()
        })
      } catch (cause) {
        cleanupErrors.push(cause)
        evidence.cleanupError = appendError(evidence.cleanupError, cause)
        signal('SIGKILL')
      }
      retain()
    }
    try {
      cancelDeadline = capabilities.schedule(jobDeadlineMs, () => cancel('deadline'))
    } catch (cause) {
      primary = cause
      hasPrimary = true
      evidence.primaryError = message(cause)
      signal('SIGTERM')
      retain()
    }
    void execution.started.catch(() => undefined)
    // A deadline or termination request is not close evidence. Admission and the
    // actual handle remain retained until this positive close observation arrives.
    const joined = execution.closed.then(() => undefined)
    const result = execution.closed.then((close) => {
      delete reservation.execution
      evidence.close = close
      evidence.status = 'closed'
      for (const stop of [cancelDeadline, cancelGrace]) {
        try {
          stop()
        } catch (cause) {
          cleanupErrors.push(cause)
          evidence.cleanupError = appendError(evidence.cleanupError, cause)
        }
      }
      try {
        try {
          execution.closeOutput()
          if (execution.output.closed !== true) throw new Error('Renderer output descriptor close was not confirmed.')
        } catch (cause) {
          cleanupErrors.push(cause)
          evidence.cleanupError = appendError(evidence.cleanupError, cause)
        }
        let value: RendererJobValue = undefined
        try {
          value = decodeRendererOutput(job, execution.readOutput())
          if (close.code !== 0 || close.signal !== null)
            throw new Error(`Renderer child exited ${close.code}/${close.signal}.`)
          evidence.outputValidated = true
        } catch (cause) {
          if (hasPrimary === false) {
            primary = cause
            hasPrimary = true
          } else cleanupErrors.push(cause)
          evidence.primaryError = message(primary)
        }
        if (evidence.cancellation === null && evidence.primaryError === null && evidence.cleanupError === null) {
          try {
            execution.cleanup()
            evidence.cleanupSucceeded = true
          } catch (cause) {
            cleanupErrors.push(cause)
            evidence.cleanupError = appendError(evidence.cleanupError, cause)
          }
        }
        if (evidence.cleanupSucceeded !== true) {
          if (execution.scratch.state === 'owned') execution.scratch.state = 'retained'
          retain()
          const uncertain: RendererUncertainOwners = {
            ...(execution.output.closed !== true ? { output: execution.output, scratch: execution.scratch } : {}),
            ...(execution.scratch.state === 'uncertain' ? { scratch: execution.scratch } : {}),
          }
          const failure = new RendererParentFailure(
            { ...evidence, terminationErrors: [...evidence.terminationErrors] },
            execution.directory,
            primary,
            [...cleanupErrors, ...terminationErrors],
            uncertain,
            hasPrimary,
          )
          if (hasUncertainOwners(uncertain) === true) {
            reservation.uncertain = uncertain
            reservation.failure = failure
          }
          throw failure
        }
        return value
      } finally {
        if (active === reservation && reservation.uncertain === undefined) active = undefined
      }
    })
    void result.catch(() => undefined)
    return {
      result,
      joined,
      started: execution.started,
      cancel,
      directory: execution.directory,
      pid: execution.pid,
      handle: execution.handle,
      evidence,
      output: execution.output,
      scratch: execution.scratch,
    }
  }
  return {
    start,
    get active() {
      return active
    },
  }
}
