import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { Data, Effect } from '@livestore/utils/effect'

import { resolveProjectPaths } from './project-paths.ts'
import { acquireRendererLaunch, type LaunchResources } from './renderer-launch-resources.ts'
import { prepareRendererJob } from './renderer-owner.ts'
import { createRendererDispatcher, type RendererClose, type RendererExecution } from './renderer-parent.ts'
import { serializeRendererError } from './renderer-protocol.ts'
import { jobByteLimit, logByteLimit, type PreparedRendererJob, type RendererJob } from './renderer-protocol.ts'
import { writeRendererBytes, RendererWriteFailure } from './renderer-write.ts'

export class RendererJobError extends Data.TaggedError('RendererJobError')<{ message: string; cause: unknown }> {}

/** All partial filesystem acquisitions remain owned if launch cannot complete. */
const launchRenderer = (prepared: PreparedRendererJob): RendererExecution => {
  const paths = resolveProjectPaths(prepared.job.projectRoot)
  return acquireRendererLaunch(
    prepared.ownerRoot,
    {
      ensureCache: () => fs.mkdirSync(paths.cacheRoot, { recursive: true }),
      createScratch: () => fs.mkdtempSync(path.join(paths.cacheRoot, 'job-')),
      writeRequest: (directory) => fs.writeFileSync(path.join(directory, 'request.json'), prepared.request),
      openOutput: (directory) => fs.openSync(path.join(directory, 'child.log'), 'w'),
      closeOutput: (descriptor) => fs.closeSync(descriptor),
      removeScratch: (directory) => fs.rmSync(directory, { recursive: true }),
      retainFailure: (failure, directory) => {
        const record = directory === undefined ? `launch-${crypto.randomUUID()}` : path.basename(directory)
        fs.writeFileSync(
          path.join(paths.cacheRoot, `${record}.failure.json`),
          JSON.stringify(
            {
              ownerRoot: failure.ownerRoot,
              directory,
              processCreated: false,
              primary: serializeRendererError(failure.primary),
              cleanup: failure.cleanupErrors.map(serializeRendererError),
              uncertain: failure.uncertain,
            },
            null,
            2,
          ),
        )
      },
    },
    (resources) => createRendererExecution(prepared, resources),
  )
}

/** The only process-creation capability in the renderer's owned source. */
const createRendererExecution = (
  prepared: PreparedRendererJob,
  { scratch, output }: LaunchResources,
): RendererExecution => {
  const directory = scratch.path
  const requestPath = path.join(directory, 'request.json')
  const resultPath = path.join(directory, 'result.json')
  const evidencePath = `${directory}.failure.json`
  const log = output.descriptor
  const executable = process.versions.bun === undefined ? 'bun' : process.execPath
  const child = spawn(executable, [fileURLToPath(new URL('./renderer-child.ts', import.meta.url)), requestPath], {
    cwd: prepared.ownerRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  })
  let logBytes = 0
  let logReceivedBytes = 0
  let captureFailed = false
  let resultBytes: number | undefined
  let observedOutput: string | undefined
  const captureErrors: unknown[] = []
  let spawnError: Error | undefined
  const capture = (data: Buffer) => {
    logReceivedBytes += data.length
    if (captureFailed === true) return
    const remaining = Math.max(0, logByteLimit - logBytes)
    if (remaining === 0) return
    try {
      logBytes += writeRendererBytes(data.subarray(0, remaining), (bytes, offset, length) =>
        fs.writeSync(log, bytes, offset, length),
      )
    } catch (cause) {
      if (cause instanceof RendererWriteFailure) logBytes += cause.written
      captureFailed = true
      captureErrors.push(cause)
    }
  }
  child.stdout.on('data', capture)
  child.stderr.on('data', capture)
  child.on('error', (cause) => {
    spawnError = cause
  })
  const started = new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve)
    child.once('error', reject)
  })
  void started.catch(() => undefined)
  const closed = new Promise<RendererClose>((resolve) => {
    child.once('close', (code, signal) => resolve({ code, signal }))
  })
  return {
    handle: child,
    output,
    scratch,
    pid: child.pid,
    directory,
    started,
    closed,
    terminate: (signal) => {
      child.kill(signal)
    },
    closeOutput: () => {
      try {
        fs.closeSync(log)
        output.closed = true
      } catch (cause) {
        captureErrors.push(cause)
      }
      if (captureErrors.length > 0) throw new AggregateError(captureErrors, 'Renderer log capture/close failed.')
    },
    readOutput: () => {
      if (spawnError !== undefined) throw spawnError
      if (fs.existsSync(resultPath) === false) {
        throw new Error(
          `Renderer child closed without a result. ${logBytes === 0 ? 'No child diagnostic bytes were captured.' : 'Captured child output is retained in child.log.'}`,
        )
      }
      resultBytes = fs.statSync(resultPath).size
      if (resultBytes > jobByteLimit) throw new Error('Renderer job output exceeds 16 MiB.')
      observedOutput = fs.readFileSync(resultPath, 'utf8')
      return JSON.parse(observedOutput)
    },
    cleanup: () => {
      try {
        fs.rmSync(directory, { recursive: true })
        scratch.state = 'removed'
      } catch (cause) {
        scratch.state = 'uncertain'
        throw cause
      }
    },
    // This sibling survives partially completed scratch deletion. The actual
    // ChildProcess remains in the parent admission until positive close.
    retain: (evidence) => {
      if (observedOutput !== undefined) fs.writeFileSync(`${evidencePath}.result.json`, observedOutput)
      fs.writeFileSync(
        evidencePath,
        JSON.stringify(
          {
            ...evidence,
            directory,
            logBytes,
            logReceivedBytes,
            childDiagnostics: logBytes === 0 ? 'none-captured' : 'captured-output-only',
            logTruncated: logReceivedBytes > logBytes,
            resultBytes,
            resultSha256:
              observedOutput === undefined ? null : crypto.createHash('sha256').update(observedOutput).digest('hex'),
          },
          null,
          2,
        ),
      )
    },
  }
}

const dispatcher = createRendererDispatcher({
  prepare: prepareRendererJob,
  launch: launchRenderer,
  schedule: (delayMs, callback) => {
    const timer = setTimeout(callback, delayMs)
    return () => clearTimeout(timer)
  },
})

export const startRendererJob = dispatcher.start

export const runRendererJob = (job: RendererJob) =>
  Effect.acquireUseRelease(
    Effect.try({
      try: () => startRendererJob(job),
      catch: (cause) => new RendererJobError({ message: String(cause), cause }),
    }),
    (running) =>
      Effect.tryPromise({
        try: () => running.result,
        catch: (cause) => new RendererJobError({ message: String(cause), cause }),
      }),
    (running) =>
      Effect.promise(async () => {
        running.cancel()
        await running.joined
      }),
  )
