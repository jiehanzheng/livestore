import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { transformerTwoslash } from '@shikijs/twoslash'
import type { Element, ElementContent } from 'hast'
import { fromMarkdown } from 'mdast-util-from-markdown'
import { toHast } from 'mdast-util-to-hast'
import { bundledLanguages, createHighlighter, type ShikiTransformer } from 'shiki'
import { createTwoslasher } from 'twoslash-vue'
import * as ts from 'typescript'

import type { TwoslashProjectPaths } from './project-paths.ts'
import { createRendererConfig, type TwoslashRuntimeOptions, type LineOwnerMetadata } from './renderer-config.ts'
import { completeRendererSetup } from './renderer-lifetime.ts'
import type { SnippetRenderInput } from './renderer-protocol.ts'
import { snippetClientModule } from './snippet-client.ts'

export const createLocalSnippetRenderer = async (paths: TwoslashProjectPaths, options: TwoslashRuntimeOptions) => {
  const config = createRendererConfig(paths, options)
  const require = createRequire(import.meta.url)
  const highlighter = await createHighlighter({
    themes: ['github-light', 'github-dark'],
    langs: ['typescript', 'tsx', 'javascript', 'jsx', 'vue', 'json', 'css', 'html', 'astro'],
  })
  return completeRendererSetup(
    paths.snippetAssetsRoot,
    highlighter,
    () => {
      const createCompiler = () =>
        createTwoslasher({
          tsModule: ts,
          compilerOptions: config.compilerOptions,
          vfsRoot: paths.snippetAssetsRoot,
          tsLibDirectory: path.dirname(ts.getDefaultLibFilePath(config.compilerOptions)),
          vueCompilerOptions: {
            strictTemplates: true,
            plugins: [fileURLToPath(new URL('./vue-script-boundary.cts', import.meta.url))],
          },
        })
      // TypeScript bundles create and remove virtual module files. Vue's generated
      // script resolves imports from disk and needs its own compiler filesystem cache.
      const twoslasher = createCompiler()
      const vueTwoslasher = createCompiler()
      const baseStyles =
        fs.readFileSync(require.resolve('@shikijs/twoslash/style-rich.css'), 'utf8') +
        `
.ls-snippet { position: relative; }
.ls-snippet pre { overflow-x: auto; padding: 1rem; }
.ls-snippet .line { display: block; min-height: 1lh; }
.ls-snippet .copy { position: absolute; top: .25rem; right: .25rem; }
.twoslash-popup-container[popover]:popover-open { display: flex; opacity: 1; visibility: visible; position: fixed; margin: 0; transform: none; pointer-events: auto; max-width: min(40rem, calc(100vw - 2rem)); max-height: 50vh; overflow: auto; }
.twoslash-popup-container[popover]:not(:popover-open) { display: none; }
.twoslash-popup-container[popover] .twoslash-popup-arrow { display: none; }
`
      return {
        configHash: config.fingerprintHash,
        baseStyles,
        themeStyles:
          'html[data-theme="dark"] .shiki, html[data-theme="dark"] .shiki span { color: var(--shiki-dark) !important; background-color: var(--shiki-dark-bg) !important; }',
        jsModules: [snippetClientModule],
        dispose: () => highlighter.dispose(),
        render: async ({
          code,
          language,
          lineOwners,
        }: SnippetRenderInput): Promise<{ renderedGroupAst: Element; styles: Set<string> }> => {
          if (language === 'vue' && fs.realpathSync(process.cwd()) !== fs.realpathSync(paths.snippetAssetsRoot)) {
            throw new Error('Local Vue rendering requires the actual snippet owner cwd.')
          }
          if (highlighter.getLoadedLanguages().includes(language) === false) {
            const grammar = Object.entries(bundledLanguages).find(([name]) => name === language)?.[1]
            if (grammar !== undefined) await highlighter.loadLanguage(grammar)
          }
          let pointer = 0
          let renderedSource = code
          const ownership: ShikiTransformer = {
            name: 'livestore-line-ownership',
            preprocess(source) {
              renderedSource = source
            },
            line(node, lineNumber) {
              const text = renderedSource.split('\n')[lineNumber - 1]?.trim() ?? ''
              const predicate =
                text.startsWith('// @filename:') === true
                  ? (entry: LineOwnerMetadata) => entry.owner === null && entry.marker === null
                  : text.startsWith('// __LS_FILE_START__') === true
                    ? (entry: LineOwnerMetadata) => entry.marker === 'start'
                    : text.startsWith('// __LS_FILE_END__') === true
                      ? (entry: LineOwnerMetadata) => entry.marker === 'end'
                      : (entry: LineOwnerMetadata) => entry.owner !== null
              while (pointer < lineOwners.length) {
                const entry = lineOwners[pointer++]!
                if (predicate(entry) === false) continue
                if (entry.owner !== null) node.properties['data-ls-owner'] = entry.owner
                if (entry.marker !== null) node.properties['data-ls-marker'] = entry.marker
                break
              }
              node.tagName = 'div'
            },
          }
          const ast = highlighter.codeToHast(code, {
            lang: language,
            themes: { light: 'github-light', dark: 'github-dark' },
            transformers: [
              transformerTwoslash({
                twoslasher: language === 'vue' ? vueTwoslasher : twoslasher,
                twoslashOptions: { compilerOptions: config.compilerOptions },
                rendererRich: {
                  errorRendering: 'hover',
                  renderMarkdown: renderHoverMarkdown,
                  renderMarkdownInline: (markdown) =>
                    renderHoverMarkdown(markdown).flatMap((node) =>
                      node.type === 'element' && node.tagName === 'p' ? node.children : [node],
                    ),
                },
                langs: ['ts', 'tsx', 'js', 'jsx', 'vue', 'typescript', 'javascript'],
              }),
              ownership,
            ],
          })
          const children = ast.children.filter((node) => node.type !== 'doctype')
          const copy: Element = {
            type: 'element',
            tagName: 'div',
            properties: { className: ['copy'] },
            children: [
              {
                type: 'element',
                tagName: 'button',
                properties: { type: 'button', 'aria-label': 'Copy code', dataCode: code },
                children: [{ type: 'text', value: 'Copy' }],
              },
            ],
          }
          return {
            renderedGroupAst: {
              type: 'element',
              tagName: 'div',
              properties: { className: ['ls-snippet'] },
              children: [{ type: 'element', tagName: 'figure', properties: {}, children: [...children, copy] }],
            },
            styles: new Set(),
          }
        },
      }
    },
    (resource) => resource.dispose(),
  )
}

const renderHoverMarkdown = (markdown: string): ElementContent[] => {
  const root = toHast(fromMarkdown(markdown))
  if (root.type !== 'root') throw new Error('Expected a Markdown document root.')
  return root.children.filter((node) => node.type !== 'doctype')
}
