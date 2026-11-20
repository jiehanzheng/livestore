import fs from 'node:fs'
import path from 'node:path'

import { resolveProjectPaths } from './project-paths.ts'
import { jobByteLimit, renderInputLimit, type PreparedRendererJob, type RendererJob } from './renderer-protocol.ts'

export const validateRendererJob = (job: RendererJob) => {
  if (path.isAbsolute(job.projectRoot) === false || path.isAbsolute(job.ownerRoot) === false)
    throw new Error('Renderer roots must be absolute.')
  if (job.mode !== 'build' && job.mode !== 'render') throw new Error('Unknown renderer job mode.')
  if (job.mode === 'render' && (Array.isArray(job.inputs) === false || job.inputs.length > renderInputLimit)) {
    throw new Error('Renderer batch exceeds its input count bound.')
  }
  const paths = resolveProjectPaths(job.projectRoot)
  if (fs.realpathSync(job.ownerRoot) !== fs.realpathSync(paths.snippetAssetsRoot)) {
    throw new Error('Renderer job owner must be the actual snippet workspace.')
  }
  return paths
}

export const prepareRendererJob = (job: RendererJob): PreparedRendererJob => {
  assertSerializable(job)
  validateRendererJob(job)
  const normalized = {
    ...job,
    projectRoot: fs.realpathSync(job.projectRoot),
    ownerRoot: fs.realpathSync(job.ownerRoot),
  }
  const request = JSON.stringify(normalized)
  if (Buffer.byteLength(request) > jobByteLimit) throw new Error('Renderer job input exceeds 16 MiB.')
  return { job: normalized, ownerRoot: normalized.ownerRoot, request }
}

// Validate before JSON.stringify so custom toJSON/getter callbacks cannot change
// a supposedly data-only job or execute while the parent prepares admission.
const assertSerializable = (value: unknown, ancestors = new Set<object>()): void => {
  if (typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') {
    throw new Error('A renderer job requires serializable runtime options.')
  }
  if (typeof value === 'number' && Number.isFinite(value) === false)
    throw new Error('A renderer job requires finite numeric data.')
  if (typeof value !== 'object' || value === null) return
  if (ancestors.has(value) === true) throw new Error('A renderer job cannot contain circular data.')
  const prototype: unknown = Object.getPrototypeOf(value)
  if (prototype !== null && prototype !== Object.prototype && prototype !== Array.prototype) {
    throw new Error('A renderer job requires plain serializable data.')
  }
  ancestors.add(value)
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') throw new Error('A renderer job requires serializable string keys.')
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (descriptor === undefined || descriptor.get !== undefined || descriptor.set !== undefined) {
      throw new Error('A renderer job requires serializable data without accessors.')
    }
    assertSerializable(descriptor.value, ancestors)
  }
  ancestors.delete(value)
}
