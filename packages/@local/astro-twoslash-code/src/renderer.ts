import type { Element, ElementContent } from 'hast'

import type { TwoslashProjectPaths } from './project-paths.ts'
import type { TwoslashRuntimeOptions } from './renderer-config.ts'
import { startRendererJob } from './renderer-job.ts'
import { createLocalSnippetRenderer } from './renderer-local.ts'
import type { SnippetRenderInput } from './renderer-protocol.ts'

export const createSnippetRenderer = async (paths: TwoslashProjectPaths, options: TwoslashRuntimeOptions) => {
  const local = await createLocalSnippetRenderer(paths, options)
  return {
    ...local,
    render: async (input: SnippetRenderInput): Promise<{ renderedGroupAst: Element; styles: Set<string> }> => {
      if (input.language !== 'vue') return local.render(input)
      const running = startRendererJob({
        mode: 'render',
        projectRoot: paths.projectRoot,
        ownerRoot: paths.snippetAssetsRoot,
        runtime: options,
        inputs: [input],
      })
      const result = await running.result
      if (Array.isArray(result) === false || result.length !== 1)
        throw new Error('Expected one validated render result.')
      const rendered = result[0]
      if (rendered === undefined) throw new Error('Validated render result was empty.')
      return { renderedGroupAst: rendered.renderedGroupAst, styles: new Set(rendered.styles) }
    },
  }
}
