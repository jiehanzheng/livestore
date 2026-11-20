import type { Element, ElementContent } from 'hast'

import type { TwoslashRuntimeOptions, LineOwnerMetadata } from './renderer-config.ts'

export type SnippetRenderInput = {
  code: string
  language: string
  lineOwners: readonly LineOwnerMetadata[]
}

export type RendererJob = {
  projectRoot: string
  ownerRoot: string
  runtime: TwoslashRuntimeOptions
} & ({ mode: 'build' } | { mode: 'render'; inputs: SnippetRenderInput[] })

export const jobByteLimit = 16 * 1024 * 1024
export const logByteLimit = 1024 * 1024

export const renderInputLimit = 1024
export const jobDeadlineMs = 10 * 60 * 1000
export const terminationGraceMs = 5000

export type RenderedJobSnippet = { renderedGroupAst: Element; styles: string[] }
export type RendererJobValue = number | undefined | RenderedJobSnippet[]

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const isHastContent = (value: unknown): value is ElementContent => {
  if (isRecord(value) === false) return false
  if (value.type === 'text' || value.type === 'comment') return typeof value.value === 'string'
  return (
    value.type === 'element' &&
    typeof value.tagName === 'string' &&
    isRecord(value.properties) &&
    Object.values(value.properties).every(
      (property) =>
        property === null ||
        ['string', 'number', 'boolean'].includes(typeof property) ||
        (Array.isArray(property) && property.every((item) => typeof item === 'string' || typeof item === 'number')),
    ) &&
    Array.isArray(value.children) &&
    value.children.every(isHastContent)
  )
}
const isRenderedSnippet = (value: unknown): value is RenderedJobSnippet =>
  isRecord(value) &&
  isHastContent(value.renderedGroupAst) &&
  value.renderedGroupAst.type === 'element' &&
  Array.isArray(value.styles) &&
  value.styles.every((style) => typeof style === 'string')

export const decodeRendererOutput = (job: RendererJob, output: unknown): RendererJobValue => {
  if (isRecord(output) === false || typeof output.ok !== 'boolean') throw new Error('Invalid renderer result envelope.')
  if (output.ok === false)
    throw new Error(typeof output.error === 'string' ? output.error : 'Renderer compilation failed.', {
      cause: output.failure,
    })
  const value = output.value
  if (job.mode === 'build') {
    if (value !== undefined && (typeof value !== 'number' || Number.isSafeInteger(value) === false || value < 0)) {
      throw new Error('Invalid renderer build count.')
    }
    return value
  }
  if (
    Array.isArray(value) === false ||
    value.length !== job.inputs.length ||
    value.every(isRenderedSnippet) === false
  ) {
    throw new Error('Invalid renderer batch result.')
  }
  return value
}

export type PreparedRendererJob = { job: RendererJob; ownerRoot: string; request: string }

/** Bound both fan-out and depth; cause graphs may contain cycles or shared errors. */
export const serializeRendererError = (cause: unknown): unknown => {
  const seen = new Set<unknown>()
  let remaining = 16
  const visit = (value: unknown, depth: number): unknown => {
    if (remaining-- <= 0 || depth > 8) return { truncated: true }
    if (seen.has(value) === true) return { repeated: true }
    if (!(value instanceof Error)) return { message: String(value).slice(0, 1024) }
    seen.add(value)
    return {
      name: value.name.slice(0, 128),
      message: value.message.slice(0, 1024),
      stack: value.stack?.slice(0, 2048),
      ...(Object.prototype.hasOwnProperty.call(value, 'cause') === true
        ? { cause: visit(value.cause, depth + 1) }
        : {}),
      ...(value instanceof AggregateError
        ? {
            errors:
              Array.isArray(value.errors) === true
                ? value.errors.slice(0, 16).map((error: unknown) => visit(error, depth + 1))
                : [{ invalidAggregateErrors: true }],
          }
        : {}),
    }
  }
  return visit(cause, 0)
}

export const encodeRendererFailure = (cause: unknown): string =>
  JSON.stringify({
    ok: false,
    error: (cause instanceof Error ? cause.message : String(cause)).slice(0, 4096),
    failure: serializeRendererError(cause),
  })
