import fs from 'node:fs'
import path from 'node:path'

import { Effect } from '@livestore/utils/effect'
import { PlatformNode } from '@livestore/utils/node'

import { buildSnippetArtifacts } from './cli/snippet-build.ts'
import { runLocalRendererJob } from './renderer-child-job.ts'
import { normalizeRuntimeOptions } from './renderer-config.ts'
import { useLocalRenderer } from './renderer-lifetime.ts'
import { createLocalSnippetRenderer } from './renderer-local.ts'
import { validateRendererJob } from './renderer-owner.ts'
import { jobByteLimit, type RendererJob } from './renderer-protocol.ts'
import { publishRendererFailure } from './renderer-publication.ts'
import { writeRendererBytes } from './renderer-write.ts'

const requestPath = process.argv[2]
if (requestPath === undefined || fs.statSync(requestPath).size > jobByteLimit) {
  throw new Error('Expected a bounded renderer job request.')
}
const resultPath = path.join(path.dirname(requestPath), 'result.json')

let ownerRoot = path.dirname(requestPath)
try {
  const job: RendererJob = JSON.parse(fs.readFileSync(requestPath, 'utf8'))
  const paths = validateRendererJob(job)
  ownerRoot = job.ownerRoot
  if (fs.realpathSync(process.cwd()) !== fs.realpathSync(job.ownerRoot)) {
    throw new Error('Renderer child cwd does not match its actual owner.')
  }
  const value = await runLocalRendererJob(job, {
    build: (request) =>
      Effect.runPromise(
        buildSnippetArtifacts({ paths, runtimeOptions: normalizeRuntimeOptions(request.runtime) }).pipe(
          Effect.provide(PlatformNode.NodeFileSystem.layer),
        ),
      ),
    render: (request) =>
      useLocalRenderer(
        job.ownerRoot,
        () => createLocalSnippetRenderer(paths, request.runtime),
        async (renderer) => {
          const results = []
          for (const input of request.inputs) {
            const rendered = await renderer.render(input)
            results.push({ ...rendered, styles: Array.from(rendered.styles) })
          }
          return results
        },
        (renderer) => renderer.dispose(),
      ),
  })
  const output = JSON.stringify({ ok: true, value })
  if (Buffer.byteLength(output) > jobByteLimit) throw new Error('Renderer job output exceeds 16 MiB.')
  fs.writeFileSync(resultPath, output)
} catch (cause) {
  process.exitCode = 1
  // Publication failure propagates as the actual composite; it cannot be
  // mistaken for a successfully published failure envelope.
  publishRendererFailure(
    ownerRoot,
    cause,
    (encoded) => fs.writeFileSync(resultPath, encoded),
    (diagnostic) => {
      writeRendererBytes(Buffer.from(diagnostic), (bytes, offset, length) => fs.writeSync(2, bytes, offset, length))
    },
  )
}
