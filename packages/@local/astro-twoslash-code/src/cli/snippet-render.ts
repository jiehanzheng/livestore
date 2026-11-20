import { toHtml } from 'hast-util-to-html'

import { Effect } from '@livestore/utils/effect'

import type { TwoslashProjectPaths } from '../project-paths.ts'
import type { LineOwnerMetadata, TwoslashRuntimeOptions } from '../renderer-config.ts'
import { createLocalSnippetRenderer } from '../renderer-local.ts'
import type { buildSnippetBundle } from '../vite/snippet-graph.ts'
import { collectDiagnostics } from './snippet-diagnostics.ts'
import { SnippetBuildError } from './snippet-error.ts'
import { restoreFocusSpecifiers, sanitizeRenderedHtml } from './snippet-import-restoration.ts'
import { trimRenderedAst, stripSentinelsFromDataCodeAttributes } from './snippet-ownership.ts'
import { assembleSnippet, guessLanguage } from './snippet-source.ts'
import { createVirtualFiles, remapVirtualPathsForFocus, resolveFocusVirtualPath } from './snippet-virtual-files.ts'

type THastRendererResult = Awaited<ReturnType<Awaited<ReturnType<typeof createLocalSnippetRenderer>>['render']>>
export type TSnippetRenderer = Awaited<ReturnType<typeof createLocalSnippetRenderer>>

export const loadSnippetRenderer = (
  paths: TwoslashProjectPaths,
  runtimeOptions: TwoslashRuntimeOptions,
): Effect.Effect<{ renderer: TSnippetRenderer; configHash: string }, SnippetBuildError> =>
  Effect.tryPromise({
    try: async () => {
      const renderer = await createLocalSnippetRenderer(paths, runtimeOptions)
      return { renderer, configHash: renderer.configHash }
    },
    catch: (cause) => {
      if (process.env.TWOSLASH_DEBUG === '1') {
        console.error('astro-twoslash-code: failed to load Shiki renderer', cause)
      }
      return new SnippetBuildError({
        message: 'Unable to load Shiki renderer',
        cause,
      })
    },
  })

export type TRenderedSnippet = {
  html: string | null
  language: string
  meta: string
  diagnostics: string[]
  styles: string[]
}

export const renderSnippet = (
  renderer: TSnippetRenderer,
  bundle: ReturnType<typeof buildSnippetBundle>,
  focusFilename: string,
): Effect.Effect<TRenderedSnippet, SnippetBuildError> =>
  Effect.tryPromise({
    try: async () => {
      const language = guessLanguage(focusFilename)
      const canonicalFiles = createVirtualFiles(bundle.files, bundle.fileOrder)
      const focusRecord = canonicalFiles.find((file) => file.relativePath === focusFilename)
      const virtualFiles = remapVirtualPathsForFocus(canonicalFiles, focusFilename)
      const focusVirtualPath = resolveFocusVirtualPath(virtualFiles, focusFilename)

      const snippetFiles = virtualFiles.map((file) => ({
        virtualPath: file.virtualPath,
        content: file.content,
      }))
      const assembled = assembleSnippet(snippetFiles, focusVirtualPath)
      let html: string | null = null
      let styles: string[] = []
      let diagnostics: string[] = []
      let renderResult: THastRendererResult
      const lineOwners = assembled.lines.map<LineOwnerMetadata>((line) => ({
        owner: line.owner,
        marker: line.marker,
      }))
      const renderOptions = { code: assembled.code, language, lineOwners }
      try {
        renderResult = await renderer.render(renderOptions)
      } catch (cause) {
        const failure = cause as { message?: string; cause?: unknown }
        const nested = failure?.cause as { recommendation?: string; message?: string } | undefined
        const detail = nested?.recommendation ?? nested?.message ?? failure?.message ?? null
        const message =
          detail != null && detail.length > 0
            ? `Twoslash rendering failed for ${focusFilename}: ${detail}`
            : `Twoslash rendering failed for ${focusFilename}`
        throw new SnippetBuildError({
          message,
          cause,
          entry: bundle.entryFilePath,
        })
      }

      const trimmedAst = trimRenderedAst(renderResult.renderedGroupAst, focusVirtualPath, assembled)
      const restoredAst = restoreFocusSpecifiers(trimmedAst, focusRecord?.relativeImports ?? [])
      diagnostics = collectDiagnostics(restoredAst)
      html = sanitizeRenderedHtml(toHtml(restoredAst))
      html = stripSentinelsFromDataCodeAttributes(html)
      styles = Array.from(renderResult.styles)
      return {
        html,
        language,
        meta: 'twoslash',
        diagnostics,
        styles,
      } satisfies TRenderedSnippet
    },
    catch: (cause) =>
      cause instanceof SnippetBuildError
        ? cause
        : new SnippetBuildError({
            message: `Failed to render snippet for ${focusFilename}`,
            cause,
            entry: bundle.entryFilePath,
          }),
  }).pipe(
    Effect.withSpan(`renderSnippet:${focusFilename}`, {
      attributes: { filename: focusFilename },
    }),
  )
