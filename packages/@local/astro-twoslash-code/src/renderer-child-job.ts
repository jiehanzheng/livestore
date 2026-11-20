import type { RendererJob, RendererJobValue } from './renderer-protocol.ts'

export type LocalRendererCapabilities = {
  build: (job: Extract<RendererJob, { mode: 'build' }>) => Promise<RendererJobValue>
  render: (job: Extract<RendererJob, { mode: 'render' }>) => Promise<RendererJobValue>
}

// No process capability is supplied to the child runner. It can only invoke
// the local rendering/building leaves selected by the finite request.
export const runLocalRendererJob = (job: RendererJob, local: LocalRendererCapabilities) =>
  job.mode === 'build' ? local.build(job) : local.render(job)
